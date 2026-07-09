// Category dashboard — projects your team's standings finish in all 10 cats
// given current roster (keepers + drafted in live draft). Used both in the
// keepers/overview context (offseason) and live draft (real-time).

// Returns aggregated category totals for a list of players (by name).
function aggregateCats(players) {
  const totals = {
    R: 0, HR: 0, RBI: 0, SB: 0, OBP_pa: 0, OBP_hbb: 0,
    QS: 0, K: 0, SV_HLD: 0, IP: 0, ER: 0, BB_H: 0,
  };
  for (const name of players) {
    const proj = getProjection(name);
    if (!proj) continue;
    if (proj.type === "H") {
      totals.R += proj.R || 0;
      totals.HR += proj.HR || 0;
      totals.RBI += proj.RBI || 0;
      totals.SB += proj.SB || 0;
      totals.OBP_pa += proj.PA || 0;
      totals.OBP_hbb += (proj.OBP || 0) * (proj.PA || 0);
    } else {
      totals.QS += proj.QS || 0;
      totals.K += proj.K || 0;
      totals.SV_HLD += (proj.SV || 0) + (proj.HLD || 0);
      totals.IP += proj.IP || 0;
      totals.ER += (proj.ERA || 0) * (proj.IP || 0) / 9;
      totals.BB_H += (proj.WHIP || 0) * (proj.IP || 0);
    }
  }
  totals.OBP = totals.OBP_pa > 0 ? totals.OBP_hbb / totals.OBP_pa : 0;
  totals.ERA = totals.IP > 0 ? (totals.ER * 9) / totals.IP : 0;
  totals.WHIP = totals.IP > 0 ? totals.BB_H / totals.IP : 0;
  return totals;
}

// Rough 12-team roto target benchmarks (1st place = roughly the top of these).
// These come from historical roto standings for OBP-format leagues. They get
// refined as we ingest your league history.
const CAT_TARGETS = {
  R:  { p1: 1100, p6: 950,  p12: 800 },
  HR: { p1: 350,  p6: 290,  p12: 230 },
  RBI:{ p1: 1080, p6: 920,  p12: 780 },
  SB: { p1: 165,  p6: 125,  p12: 90 },
  OBP:{ p1: 0.345,p6: 0.330,p12: 0.315 },
  QS: { p1: 95,   p6: 80,   p12: 65 },
  K:  { p1: 1500, p6: 1280, p12: 1100 },
  SV_HLD:{ p1: 175, p6: 130, p12: 95 },
  ERA:{ p1: 3.45, p6: 3.75, p12: 4.10 }, // lower = better
  WHIP:{ p1: 1.13,p6: 1.20, p12: 1.27 },
};

// Project rank given a total in a category. Linear interpolation between
// p1/p6/p12, clamped 1..12.
function projectRank(cat, value) {
  const t = CAT_TARGETS[cat];
  if (!t) return null;
  // ERA/WHIP — lower is better
  const inverse = cat === "ERA" || cat === "WHIP";
  if (inverse) {
    if (value <= t.p1) return 1 + (t.p1 - value) / Math.max(0.01, t.p1) * -0;
    if (value <= t.p6) return 1 + ((value - t.p1) / (t.p6 - t.p1)) * 5;
    if (value <= t.p12) return 6 + ((value - t.p6) / (t.p12 - t.p6)) * 6;
    return 12 + Math.min(0.99, (value - t.p12) / Math.max(0.01, t.p12));
  }
  if (value >= t.p1) return 1;
  if (value >= t.p6) return 1 + (t.p1 - value) / (t.p1 - t.p6) * 5;
  if (value >= t.p12) return 6 + (t.p6 - value) / (t.p6 - t.p12) * 6;
  return 12;
}

// Builds the full team projection given a list of player names. Returns:
//   { totals: {R, HR, ...}, ranks: {R: 5.3, ...}, rotoPoints: 86.4 }
function projectTeamCategories(playerNames) {
  const totals = aggregateCats(playerNames);
  const cats = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
  const ranks = {};
  let rotoPoints = 0;
  for (const c of cats) {
    const v = c === "SV_HLD" ? totals.SV_HLD : (c === "OBP" ? totals.OBP : c === "ERA" ? totals.ERA : c === "WHIP" ? totals.WHIP : totals[c]);
    const r = projectRank(c, v);
    ranks[c] = r;
    // Roto points: 13 - rank (best = 12 pts, worst = 1 pt). Clamp 1..12 to keep within range.
    rotoPoints += Math.max(1, Math.min(12, 13 - r));
  }
  return { totals, ranks, rotoPoints };
}

// Returns the list of player names currently committed to my team (keepers +
// any drafted picks tracked separately). For now, just keepers + drafted from
// live draft state if available.
function getMyRoster() {
  const me = (typeof getMyDraftTeam === "function" ? getMyDraftTeam() : getMyTeam());
  if (!me) return [];
  // Keepers from the Keepers tab (your predicted keepers), not league-site marks.
  const selAll = (typeof getEffectiveKeeperSelections === "function") ? getEffectiveKeeperSelections() : getKeeperSelections();
  const sel = selAll[me.id] || {};
  const kept = Object.entries(sel)
    .filter(([_, f]) => f.keeper) // ML keepers only — minors don't contribute to ML cats this year
    .map(([n]) => n);
  // Plus anything drafted live (if live draft state exists)
  const drafted = (typeof getMyLiveDraftPicks === "function") ? getMyLiveDraftPicks() : [];
  return [...kept, ...drafted];
}

function renderCategoryDashboard() {
  // Stats can come from EITHER the preseason store OR the active ROS source
  // (Jeff's normal workflow — hosted ROS CSVs auto-load, preseason stays
  // empty). Gate on the same sources getProjection actually reads, else this
  // showed "Import projections" while the Data tab was fully loaded.
  const hasPreseason = getHitterProjections().length > 0;
  // Any stats-bearing source counts — not just the active one (which is often
  // $-only). Mirrors getProjection's cross-source stats lookup (R17).
  const hasRos = (typeof rosStatSourceIds === "function") && rosStatSourceIds().length > 0;
  if (!hasPreseason && !hasRos) {
    return '<div class="empty"><p>Import projections to see category projections — Data tab ▸ Stat Projections (a $-only source has no stats to project).</p></div>';
  }
  const roster = getMyRoster();
  if (!roster.length) {
    return '<div class="card"><h3>Your Categories</h3><p class="muted">No keepers marked for your team yet.</p></div>';
  }
  const result = projectTeamCategories(roster);

  // Coverage check — how many rostered players actually resolve to a stat line.
  // A blank-heavy dashboard must SAY it's a data gap, never look like a bug (R17).
  const missing = (typeof getProjection === "function")
    ? roster.filter(n => !getProjection(n)) : [];

  let html = '<div class="card"><h2>Your Category Projection</h2>';
  html += '<p class="muted small">Based on ' + roster.length + ' player' + (roster.length === 1 ? "" : "s") + ' currently on your roster (keepers + drafted). Estimated rank assumes you finish drafting near the league average; refine as you add picks.</p>';
  if (missing.length && missing.length > roster.length * 0.2) {
    html += '<p class="small" style="color:var(--warn); margin:0 0 8px;">⚠ ' + missing.length + ' of ' + roster.length +
      ' of your players have no stat projection — totals below undercount. ' +
      'Missing: ' + missing.slice(0, 3).map(esc).join(", ") + (missing.length > 3 ? ", …" : "") +
      '. <span class="muted">Check Data ▸ Data health.</span></p>';
  }
  html += '<div class="grid cols-2" style="gap: 16px;">';

  for (const group of [
    { name: "Hitting", cats: [["R", "Runs"], ["HR", "Home Runs"], ["RBI", "RBI"], ["SB", "Steals"], ["OBP", "OBP"]] },
    { name: "Pitching", cats: [["QS", "QS"], ["K", "K"], ["SV_HLD", "SV+HLD"], ["ERA", "ERA"], ["WHIP", "WHIP"]] },
  ]) {
    html += '<div><h3>' + group.name + '</h3><table><tbody>';
    for (const [k, lbl] of group.cats) {
      const total = result.totals[k] || (k === "SV_HLD" ? result.totals.SV_HLD : 0);
      const rank = result.ranks[k];
      const display = (k === "OBP") ? total.toFixed(3) :
                      (k === "ERA" || k === "WHIP") ? total.toFixed(2) :
                      Math.round(total);
      const rankColor = rank <= 4 ? "good" : rank >= 9 ? "bad" : "";
      html += '<tr>';
      html += '<td>' + esc(lbl) + '</td>';
      html += '<td class="num" style="font-family: var(--mono);">' + display + '</td>';
      html += '<td class="num ' + rankColor + '">~' + rank.toFixed(1) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  html += '<div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);">';
  html += '<span class="muted small">Projected roto points: </span>';
  html += '<span style="font-family: var(--mono); font-size: 18px;">' + result.rotoPoints.toFixed(1) + '</span>';
  html += ' <span class="muted small">/ 120 (1st place = ~95+)</span>';
  html += '</div>';

  // Targets / punts — strategy-aware: a category Jeff has declared punted is
  // reported separately, never as a "need"; declared target cats get a 🎯.
  const cats = ["R","HR","RBI","SB","OBP","QS","K","SV_HLD","ERA","WHIP"];
  const strat = (typeof getMyStrategy === "function") ? getMyStrategy() : null;
  const punts = new Set((strat && strat.puntCategories) || []);
  const targetCats = new Set((strat && strat.targetCategories) || []);
  const mark = (c) => esc(c) + (targetCats.has(c) ? " 🎯" : "");
  const weak = cats.filter(c => result.ranks[c] >= 9 && !punts.has(c));
  const strong = cats.filter(c => result.ranks[c] <= 4 && !punts.has(c));
  if (weak.length || strong.length || punts.size) {
    html += '<div style="margin-top: 12px;">';
    if (strong.length) html += '<div class="small good">Strong: ' + strong.map(mark).join(", ") + '</div>';
    if (weak.length) html += '<div class="small bad">Need to address: ' + weak.map(mark).join(", ") + '</div>';
    if (punts.size) html += '<div class="small muted">Punting: ' + [...punts].map(esc).join(", ") + ' — excluded from needs.</div>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}
