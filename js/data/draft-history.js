// Draft history layer + owner tendency analyzer. Stores past auction results
// across multiple years and computes per-owner behavior profiles. Profiles
// then plug into the mock draft simulator (more realistic AI) and the
// nomination assistant (better drain targets).
//
// History CSV format (flexible):
//   year, owner, player, pos, price [, value, keeper?]
//
// Computed per-owner profile fields:
//   aggression:     avg price paid / avg projected value
//   spendBias:      front-loaded (stars+scrubs) vs spread (balanced)
//   posSpend:       { C: %, 1B: %, ..., SP: %, RP: % } share of $ by position
//   closerBias:     RP spend / total spend (high = pays for saves)
//   tierShape:      avg price by player tier (T1, T2, T3, T4, T5)
//   nominationStyle:eager-bidder vs patient (avg nomination position they end up winning)

const HISTORY_KEY = "ud_draft_history_v1";
const OWNER_ALIAS_KEY = "ud_owner_aliases_v1";

const _history = {
  picks: [],   // [{ year, owner, player, pos, price, value?, keeper? }]
  meta: { years: [] },
};

// Three buckets:
//   byGuid: ESPN owner GUID → current owner name (preferred — stable across years)
//   byName: historical team name → current owner name (fallback when GUID missing)
//   excludedGuids: GUIDs of former owners no longer in the league. Their
//     picks are filtered out of tendency profiles entirely.
const _ownerAliases = { byGuid: {}, byName: {}, excludedGuids: {} };

function loadOwnerAliases() {
  try {
    const v = JSON.parse(localStorage.getItem(OWNER_ALIAS_KEY) || "null");
    if (v) {
      _ownerAliases.byGuid = v.byGuid || {};
      _ownerAliases.byName = v.byName || v.map || {};
      _ownerAliases.excludedGuids = v.excludedGuids || {};
    }
  } catch (e) {}
}

function setOwnerExcluded(guid, excluded) {
  if (!guid) return;
  if (excluded) _ownerAliases.excludedGuids[guid] = true;
  else delete _ownerAliases.excludedGuids[guid];
  saveOwnerAliases();
  // Force re-render even if league data isn't loaded yet
  if (typeof switchView === "function" && typeof currentView !== "undefined") {
    switchView(currentView);
  }
}
function isOwnerExcluded(guid) {
  return !!_ownerAliases.excludedGuids[guid];
}
function saveOwnerAliases() {
  localStorage.setItem(OWNER_ALIAS_KEY, JSON.stringify(_ownerAliases));
}
function setOwnerAliasByGuid(guid, currentName) {
  if (!guid) return;
  if (!currentName) delete _ownerAliases.byGuid[guid];
  else _ownerAliases.byGuid[guid] = currentName;
  saveOwnerAliases();
  if (typeof switchView === "function" && typeof currentView !== "undefined") {
    switchView(currentView);
  }
}
function setOwnerAlias(historicalName, currentName) {
  if (!historicalName) return;
  if (!currentName) delete _ownerAliases.byName[historicalName];
  else _ownerAliases.byName[historicalName] = currentName;
  saveOwnerAliases();
  if (typeof switchView === "function" && typeof currentView !== "undefined") {
    switchView(currentView);
  }
}
// Resolve a pick to its current-owner name. Prefer GUID alias (stable
// across team renames + ownership transfers); fall back to name alias.
function resolveOwnerForPick(pick) {
  if (pick.espnOwnerGuid && _ownerAliases.byGuid[pick.espnOwnerGuid]) {
    return _ownerAliases.byGuid[pick.espnOwnerGuid];
  }
  if (pick.owner && _ownerAliases.byName[pick.owner]) {
    return _ownerAliases.byName[pick.owner];
  }
  return pick.owner;
}
// Legacy name-only resolver retained for callers that only have a name.
function resolveOwner(name) {
  return _ownerAliases.byName[name] || name;
}
function listHistoricalOwners() {
  return Array.from(new Set(_history.picks.map(p => p.owner))).filter(Boolean).sort();
}
// List unique owner GUIDs found in history, with their team-name aliases.
// Also tracks the most recent ESPN team ID so the UI can render the
// CURRENT team name (per LEAGUE.teams + ESPN_TEAM_ID_MAP) for context.
function listHistoricalOwnerGuids() {
  const byGuid = {};
  for (const p of _history.picks) {
    if (!p.espnOwnerGuid) continue;
    if (!byGuid[p.espnOwnerGuid]) {
      byGuid[p.espnOwnerGuid] = { guid: p.espnOwnerGuid, teamNames: new Set(), years: new Set(), pickCount: 0, mostRecentYear: 0, mostRecentEspnTeamId: null };
    }
    const o = byGuid[p.espnOwnerGuid];
    o.teamNames.add(p.owner);
    o.years.add(p.year);
    o.pickCount += 1;
    if (p.year > o.mostRecentYear) {
      o.mostRecentYear = p.year;
      o.mostRecentEspnTeamId = p.espnTeamId;
    }
  }
  // Resolve mostRecentEspnTeamId → current team (uses ESPN_TEAM_ID_MAP from espn.js)
  return Object.values(byGuid).map(o => {
    let currentTeam = null;
    if (o.mostRecentEspnTeamId != null && typeof ESPN_TEAM_ID_MAP !== "undefined") {
      const internalId = ESPN_TEAM_ID_MAP[o.mostRecentEspnTeamId];
      if (internalId) {
        const t = getTeam(internalId);
        if (t) currentTeam = { id: internalId, name: t.name, owner: t.owner };
      }
    }
    return {
      guid: o.guid,
      teamNames: Array.from(o.teamNames).sort(),
      years: Array.from(o.years).sort(),
      pickCount: o.pickCount,
      mostRecentYear: o.mostRecentYear,
      mostRecentEspnTeamId: o.mostRecentEspnTeamId,
      currentTeam,
    };
  }).sort((a, b) => b.pickCount - a.pickCount);
}
loadOwnerAliases();

function loadHistoryFromStorage() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "null");
    if (v) {
      _history.picks = v.picks || [];
      _history.meta = v.meta || { years: [] };
    }
  } catch (e) {}
}

function saveHistoryToStorage() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify({ picks: _history.picks, meta: _history.meta }));
}

function importHistoryCSV(text, year) {
  const rows = parseCSV(text);
  let added = 0;
  // Try to infer year from a column if not provided
  for (const r of rows) {
    const player = r["Player"] || r["Name"] || r["player_name"];
    if (!player) continue;
    const yr = year || toNum(r["Year"] || r["year"] || r["Season"]) || (new Date().getFullYear() - 1);
    const owner = r["Owner"] || r["Team"] || r["owner"] || r["team"] || "";
    const pos = r["POS"] || r["Pos"] || r["Position"] || r["pos"] || "";
    const price = toNum(r["Price"] || r["$"] || r["Cost"] || r["price"] || r["paid"]);
    if (!owner && !price) continue;
    _history.picks.push({
      year: yr, owner: String(owner).trim(), player: String(player).trim(),
      pos, price, value: toNum(r["Value"] || r["proj"] || r["projected"]),
      keeper: /true|1|y/i.test(String(r["Keeper"] || r["keeper"] || "")),
    });
    added++;
  }
  _history.meta.years = Array.from(new Set(_history.picks.map(p => p.year))).sort();
  saveHistoryToStorage();
  if (typeof rerender === "function") rerender();
  return added;
}

function clearHistory() {
  _history.picks = [];
  _history.meta = { years: [] };
  saveHistoryToStorage();
  if (typeof rerender === "function") rerender();
}

function getHistoryPicks(year) {
  if (!year) return _history.picks;
  return _history.picks.filter(p => p.year === year);
}

// Compute behavior profile for one owner across all years. Applies owner
// aliases (GUID-first, name fallback) so historical team names roll up
// under the current owner. Skips picks from excluded GUIDs (former owners).
function computeOwnerProfile(ownerName) {
  const picks = _history.picks.filter(p =>
    !isOwnerExcluded(p.espnOwnerGuid) &&
    resolveOwnerForPick(p) === ownerName &&
    !p.keeper
  );
  if (!picks.length) return null;

  const totalSpent = picks.reduce((s, p) => s + p.price, 0);
  const meanPrice = totalSpent / picks.length;
  const maxPrice = picks.reduce((m, p) => p.price > m ? p.price : m, 0);

  // Position spend share
  const posSpend = {};
  for (const p of picks) {
    const k = normalizePosKey(p.pos);
    posSpend[k] = (posSpend[k] || 0) + p.price;
  }
  const posSpendPct = {};
  for (const [k, v] of Object.entries(posSpend)) {
    posSpendPct[k] = v / totalSpent;
  }
  const closerBias = posSpendPct.RP || 0;
  const spSpend = posSpendPct.SP || 0;
  const hitSpend = ["C","1B","2B","3B","SS","OF","UTIL","DH"].reduce((s, k) => s + (posSpendPct[k] || 0), 0);

  // Stars-and-scrubs: top-3 picks' share of total spending. Higher = more
  // top-heavy. Spread = lower. This is much more discriminating than stdev
  // because it directly measures "how much of your budget goes to your top guys."
  const sortedPrices = picks.map(p => p.price).sort((a, b) => b - a);
  const top3Sum = sortedPrices.slice(0, 3).reduce((s, v) => s + v, 0);
  const top3Share = totalSpent > 0 ? top3Sum / totalSpent : 0;
  // Also compute fraction of picks that are big-money ($25+)
  const bigMoneyShare = picks.filter(p => p.price >= 25).length / picks.length;

  // Tier breakdown by raw price
  const tiers = { T1: [], T2: [], T3: [], T4: [], T5: [] };
  for (const p of picks) {
    let t;
    if (p.price >= 35) t = "T1";
    else if (p.price >= 20) t = "T2";
    else if (p.price >= 10) t = "T3";
    else if (p.price >= 5) t = "T4";
    else t = "T5";
    tiers[t].push(p.price);
  }
  const tierShape = {};
  for (const [t, arr] of Object.entries(tiers)) {
    tierShape[t] = { count: arr.length, avg: arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0 };
  }

  // Average BIDS PER YEAR — picks/years tells you whether they go deep on cheap
  // guys or load up on a few expensive ones.
  const yearsPlayed = Array.from(new Set(picks.map(p => p.year)));
  const picksPerYear = picks.length / yearsPlayed.length;

  const mostSpentOn = Object.entries(posSpend).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    owner: ownerName,
    picks: picks.length,
    totalSpent,
    meanPrice,
    maxPrice,
    picksPerYear,
    posSpendPct,
    closerBias,
    spSpend,
    hitSpend,
    top3Share,
    bigMoneyShare,
    tierShape,
    mostSpentOn,
    years: yearsPlayed,
  };
}

function normalizePosKey(pos) {
  const t = String(pos || "").toUpperCase();
  if (t.includes("SP")) return "SP";
  if (t.includes("RP") || t === "P") return "RP";
  if (t.includes("OF") || t === "LF" || t === "CF" || t === "RF") return "OF";
  if (t.includes("DH") || t === "UT") return "UTIL";
  for (const p of ["C", "SS", "2B", "3B", "1B"]) {
    if (t.includes(p)) return p;
  }
  return t || "UTIL";
}

// Build profiles for every owner in the history. Returns { owner: profile }.
// Uses GUID-first resolution so historical team-renames AND ownership
// transfers roll up correctly.
function computeAllOwnerProfiles() {
  const owners = Array.from(new Set(
    _history.picks
      .filter(p => !isOwnerExcluded(p.espnOwnerGuid))
      .map(p => resolveOwnerForPick(p))
  )).filter(Boolean);
  const out = {};
  for (const o of owners) {
    out[o] = computeOwnerProfile(o);
  }
  return out;
}

// Convert a history profile into the params expected by the mock-engine's
// per-owner DEFAULT_PROFILE shape. Returns a partial overlay.
function profileToMockOverlay(profile) {
  if (!profile) return null;
  // Without value data, use top3Share as a proxy for aggression: owners who
  // concentrate spending on top picks tend to overbid for stars.
  const aggression = Math.max(0.9, Math.min(1.2, 1 + (profile.top3Share - 0.4) * 0.5));
  // Position bias: scaled deviation from average
  const posBias = {};
  for (const [pos, pct] of Object.entries(profile.posSpendPct)) {
    const anchor = { SP: 0.18, RP: 0.08, OF: 0.30, C: 0.04, "1B": 0.06, "2B": 0.05, "3B": 0.06, SS: 0.07, UTIL: 0.04 }[pos] || 0.05;
    posBias[pos] = Math.max(0.5, Math.min(1.5, 1 + (pct - anchor) * 2));
  }
  // High top3 share = stars+scrubs appetite
  const topTierAppetite = 1 + Math.max(0, Math.min(0.6, (profile.top3Share - 0.4) * 1.5));
  return { aggression, posBias, topTierAppetite };
}

loadHistoryFromStorage();
