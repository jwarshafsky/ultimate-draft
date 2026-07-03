// Overview — league-wide snapshot. Shows inflation, all teams' keeper/budget
// status, and a quick "what to do next" panel for setup state.

function renderOverview() {
  const root = document.getElementById("view-root");
  const meta = getProjectionMeta();
  const hasProj = meta.hitterCount > 0 || meta.pitcherCount > 0;
  const inflation = hasProj ? computeTieredInflation() : null;
  const budgets = computeTeamBudgets();

  // Topbar inflation badge — same shared keeper-inflation value as every tab.
  if (typeof updateInflationBadge === "function") updateInflationBadge();

  let html = "";

  // In-season (Mar–Oct), lead with the daily "Today" brief; off-season it drops
  // below the draft-prep cards. See renderDailyBrief().
  const brief = renderDailyBrief();
  if (_isInSeason()) html += brief;

  // Setup checklist (only show if something missing)
  const checklist = [];
  if (!hasProj) checklist.push({ label: "Import projections", action: 'switchView("data")' });
  const totalKeepers = Object.values(getKeeperSelections())
    .reduce((s, t) => s + Object.keys(t).length, 0);
  if (totalKeepers === 0) checklist.push({ label: "Mark keepers in The League App (syncs automatically)", action: null });

  if (checklist.length) {
    html += '<div class="card"><h2>Setup</h2>';
    for (const item of checklist) {
      html += '<div class="stat-row"><span class="label">▸ ' + item.label + "</span>";
      if (item.action) html += '<button class="btn" onclick=\'' + item.action + '\'>Open</button>';
      html += "</div>";
    }
    html += "</div>";
  }

  // League-wide stats
  html += '<div class="grid cols-4">';
  html += '<div class="card"><h3>League Budget</h3><div style="font-size: 22px; font-family: var(--mono);">$' + (LEAGUE.draftBudget * LEAGUE.numTeams).toLocaleString() + '</div><div class="small muted">' + LEAGUE.numTeams + ' teams × $' + LEAGUE.draftBudget + '</div></div>';

  if (inflation) {
    html += '<div class="card"><h3>Inflation</h3><div style="font-size: 22px; font-family: var(--mono);">' + inflation.multiplier.toFixed(3) + 'x</div><div class="small muted">hit ' + inflation.hitMultiplier.toFixed(2) + ' / pit ' + inflation.pitMultiplier.toFixed(2) + '</div></div>';
    html += '<div class="card"><h3>Keepers Locked</h3><div style="font-size: 22px; font-family: var(--mono);">$' + Math.round(inflation.keptCost) + '</div><div class="small muted">' + inflation.keeperCount + ' major, ' + inflation.minorCount + ' minor</div></div>';
    html += '<div class="card"><h3>$ Available</h3><div style="font-size: 22px; font-family: var(--mono);">$' + Math.round(inflation.leagueRemaining) + '</div><div class="small muted">to be auctioned</div></div>';
  } else {
    html += '<div class="card"><h3>Inflation</h3><div style="font-size: 22px; font-family: var(--mono); color: var(--text-3);">—</div><div class="small muted">import projections</div></div>';
    html += '<div class="card"><h3>Keepers</h3><div style="font-size: 22px; font-family: var(--mono);">' + totalKeepers + '</div><div class="small muted">selections in The League App</div></div>';
    html += '<div class="card"><h3>Projections</h3><div style="font-size: 22px; font-family: var(--mono);">' + (meta.hitterCount + meta.pitcherCount) + '</div><div class="small muted">' + meta.hitterCount + ' hit / ' + meta.pitcherCount + ' pit</div></div>';
  }
  html += "</div>";

  // Your team's category projection (if projections + keepers available)
  if (hasProj) {
    html += renderCategoryDashboard();
  }

  // Nomination suggestions (offseason planning view)
  if (hasProj && totalKeepers > 0) {
    html += '<div class="card"><h2>Nomination Targets</h2>';
    html += '<p class="muted small">Pre-draft nomination plan based on your keepers vs. opponents\' open needs.</p>';
    html += renderNominationsPanel();
    html += '</div>';
  }

  // Per-team "Total Value" from the Keepers data: predicted $ of your kept
  // players + (remaining cash ÷ inflation) — i.e. value locked in plus the value
  // your remaining budget can still buy at inflated prices.
  const tvSource = (typeof _currentKeeperSource === "function" && typeof _keeperSources === "function")
    ? _currentKeeperSource(_keeperSources()) : null;
  const tvInfl = (typeof computeKeeperInflation === "function") ? computeKeeperInflation() : 1;
  const teamTotals = (t) => {
    if (typeof _teamCandidates !== "function") return null;
    let predVal = 0, cost = 0;
    for (const r of _teamCandidates(t, tvSource)) {
      if (r.myPicked && r.eligible) { predVal += (r.predValue || 0); cost += r.cost; }
    }
    const adj = (typeof getDraftDollarAdjustment === "function") ? getDraftDollarAdjustment(t.id) : 0;
    const remainingCash = Math.max(0, LEAGUE.draftBudget + adj - cost);
    return { keeperValue: predVal, cost, remainingCash, total: predVal + remainingCash / (tvInfl > 0 ? tvInfl : 1) };
  };

  // Teams table
  html += '<div class="card"><h2>Teams</h2>';
  html += '<p class="muted small">Total Value = predicted $ of your kept players + (remaining cash ÷ inflation ' + (tvInfl ? tvInfl.toFixed(2) : '1.00') + '×). Keepers are your predictions on the Keepers tab.</p>';
  html += '<table><thead><tr>';
  html += '<th>Owner</th><th class="num">Keepers</th><th class="num">Minors</th><th class="num">Kept $</th><th class="num">Draft $±</th><th class="num">Remaining $</th><th class="num">$/Slot</th><th class="num">Total Value</th>';
  html += '</tr></thead><tbody>';
  // Build rows then sort by Total Value (desc).
  const rows = LEAGUE.teams.map(t => {
    const b = budgets[t.id] || { keepers: 0, remaining: LEAGUE.draftBudget, keeperCount: 0, minorCount: 0, draftDollarAdj: 0 };
    return { t, b, tv: teamTotals(t) };
  });
  rows.sort((a, b) => (b.tv ? b.tv.total : 0) - (a.tv ? a.tv.total : 0));
  for (const { t, b, tv } of rows) {
    const draftSpots = LEAGUE.rosterSize - b.keeperCount;
    const dollarsPerSpot = draftSpots > 0 ? b.remaining / draftSpots : 0;
    const adj = b.draftDollarAdj || 0;
    html += '<tr' + (t.isMe ? ' style="background: rgba(79,142,247,.06);"' : '') + '>';
    html += '<td>' + esc(t.owner) + (t.isMe ? ' <span class="kbd">you</span>' : '') + '</td>';
    html += '<td class="num">' + b.keeperCount + '</td>';
    html += '<td class="num minor">' + b.minorCount + '</td>';
    html += '<td class="num">$' + b.keepers + '</td>';
    html += '<td class="num ' + (adj > 0 ? 'good' : adj < 0 ? 'bad' : 'dim') + '">' + (adj > 0 ? '+$' + adj : adj < 0 ? '−$' + Math.abs(adj) : '$0') + '</td>';
    html += '<td class="num">$' + b.remaining + '</td>';
    html += '<td class="num">$' + dollarsPerSpot.toFixed(1) + '</td>';
    html += '<td class="num"><b>' + (tv ? '$' + Math.round(tv.total) : '—') + '</b></td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  // Off-season: the standings brief lives below the draft-prep cards.
  if (!_isInSeason()) html += brief;

  root.innerHTML = html;
}

// In-season ≈ March through October (roto matters daily); otherwise draft prep leads.
function _isInSeason() {
  const m = new Date().getMonth();   // 0 = Jan
  return m >= 2 && m <= 9;
}

// A daily "Today" brief built from the cached Standings snapshot (place, title
// odds, projection coverage, age) — no ESPN pull needed. Written by
// _saveStandingsBrief() in standings.js each time standings recompute.
function renderDailyBrief() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem("ud_standings_brief_v1") || "null"); } catch (e) { /* ignore */ }
  const modeLabel = { current: "current", ros: "rest-of-season", full: "projected final" };
  const ord = (n) => (typeof ordinal === "function" ? ordinal(n) : String(n));

  let html = '<div class="card" style="border-color: rgba(79,142,247,.45);"><h2>Today</h2>';
  if (!snap || snap.place == null) {
    html += '<p class="muted small">Pull your live standings to see where you stand, your title odds, and roster gaps — it caches here for a daily glance.</p>';
    html += '<button class="btn primary" onclick=\'switchView("standings")\' style="width:auto;">Open Standings</button></div>';
    return html;
  }

  const ageMs = Date.now() - (snap.ts || 0);
  const ageH = ageMs / 3600000;
  const ageStr = ageH < 1 ? Math.max(1, Math.round(ageMs / 60000)) + "m ago"
    : ageH < 48 ? Math.round(ageH) + "h ago"
    : Math.round(ageH / 24) + "d ago";
  const stale = ageH > 48;
  const covPct = snap.coverageTotal ? Math.round((snap.coverageMatched / snap.coverageTotal) * 100) : null;

  html += '<div class="grid cols-3">';
  html += '<div><div class="small muted">Place · ' + (modeLabel[snap.mode] || snap.mode) + '</div>' +
    '<div style="font-size:26px; font-family:var(--mono);">' + ord(snap.place) +
    '<span class="small muted"> of ' + snap.numTeams + '</span></div>' +
    '<div class="small muted">' + (snap.rotoPoints != null ? snap.rotoPoints.toFixed(1) + ' roto pts' : '') + '</div></div>';
  html += '<div><div class="small muted">Title odds</div>' +
    '<div style="font-size:26px; font-family:var(--mono);">' + (snap.pFirst != null ? Math.round(snap.pFirst * 100) + '%' : '—') + '</div>' +
    '<div class="small muted">P(finish 1st)</div></div>';
  html += '<div><div class="small muted">Data</div>' +
    '<div style="font-size:16px; font-family:var(--mono); color:' + (stale ? 'var(--warn)' : 'var(--text-2)') + ';">as of ' + ageStr + '</div>' +
    (covPct != null ? '<div class="small ' + (covPct >= 80 ? 'muted' : 'warn') + '">' + covPct + '% projection coverage</div>' : '') + '</div>';
  html += '</div>';
  if (stale) html += '<p class="small warn" style="margin-top:6px;">Standings are a couple days old — refresh on the Standings tab for current numbers.</p>';
  html += '<div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">' +
    '<button class="btn" onclick=\'switchView("standings")\' style="width:auto;">Standings detail</button>' +
    '<button class="btn ghost" onclick=\'switchView("hotfa")\' style="width:auto;">Hot FAs</button></div>';
  html += '</div>';
  return html;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
