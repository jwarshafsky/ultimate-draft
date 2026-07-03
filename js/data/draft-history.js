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
//   defunctAutoProcessed: GUIDs we've auto-marked as defunct (last played < latest
//     year). Tracked so we don't re-auto-exclude if user manually re-includes.
const _ownerAliases = { byGuid: {}, byName: {}, excludedGuids: {}, defunctAutoProcessed: {} };

function loadOwnerAliases() {
  try {
    const v = JSON.parse(localStorage.getItem(OWNER_ALIAS_KEY) || "null");
    if (v) {
      _ownerAliases.byGuid = v.byGuid || {};
      _ownerAliases.byName = v.byName || v.map || {};
      _ownerAliases.excludedGuids = v.excludedGuids || {};
      _ownerAliases.defunctAutoProcessed = v.defunctAutoProcessed || {};
    }
  } catch (e) {}
}

// Auto-exclude any GUID whose mostRecentYear is older than the latest year in
// the data. Runs once per GUID (tracked in defunctAutoProcessed) so users
// can manually un-exclude without it bouncing back.
function autoExcludeDefunctOwners() {
  if (!_history.picks.length) return;
  const latestYear = Math.max(..._history.picks.map(p => p.year));
  const byGuid = {};
  for (const p of _history.picks) {
    if (!p.espnOwnerGuid) continue;
    if (!byGuid[p.espnOwnerGuid] || p.year > byGuid[p.espnOwnerGuid]) {
      byGuid[p.espnOwnerGuid] = p.year;
    }
  }
  let anyChange = false;
  for (const [guid, lastYear] of Object.entries(byGuid)) {
    if (lastYear < latestYear && !_ownerAliases.defunctAutoProcessed[guid]) {
      _ownerAliases.excludedGuids[guid] = true;
      _ownerAliases.defunctAutoProcessed[guid] = true;
      anyChange = true;
    }
  }
  if (anyChange) saveOwnerAliases();
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

// Returns the year of the upcoming draft. Defaults to latest data year + 1.
// (The latest year in _history.picks is the season just played; the NEXT
// draft is for the following year.)
function getUpcomingDraftYear() {
  const years = _history.meta.years || [];
  if (!years.length) return new Date().getFullYear();
  return Math.max(...years) + 1;
}

// Look up the keeper salary for the UPCOMING draft year. Per the constitution,
// a keeper's price is their most recent draft cost + $2 per year held.
// Resolution order:
//   1. Manual override in keeper_price_exceptions (most authoritative)
//   2. Most recent year's pick price + $2 × (upcoming year - that year)
// Returns null only if we have no record of this player anywhere.
// Match history picks by NORMALIZED name — draft-history names come from ESPN
// while callers pass League App / FanGraphs names, and accent or suffix drift
// ("José Ramírez", "Acuña Jr.") would otherwise miss and fall into guesses.
function _historyPicksFor(playerName) {
  const key = normalizePlayerName(playerName);
  return _history.picks.filter(p => {
    if (p._norm === undefined) p._norm = normalizePlayerName(p.player);
    return p._norm === key;
  });
}

function getCurrentKeeperSalary(playerName) {
  if (!playerName) return null;
  const exc = (typeof getKeeperPriceExceptions === "function") ? getKeeperPriceExceptions() : {};
  if (exc[playerName] != null) return exc[playerName];
  const allOfPlayer = _historyPicksFor(playerName).sort((a, b) => b.year - a.year);
  if (!allOfPlayer.length) {
    // No draft history — assume FAAB pickup. Per league constitution, FAAB
    // pickups keep at $6 first keepable year, +$2/year after. Most likely
    // case: picked up in the prior season and kept for upcoming = $8.
    return 8;
  }
  const upcomingYear = getUpcomingDraftYear();
  const mostRecent = allOfPlayer[0];
  const yearsLater = upcomingYear - mostRecent.year;
  return Math.max(1, mostRecent.price + 2 * yearsLater);
}

// True if a keeper salary was derived with multi-year escalator (player
// missed at least one year between most recent appearance and upcoming year).
// Useful for surfacing data quality issues — most kept players appear every
// year (kept again or drafted again), so a gap > 1 year may indicate
// a FAAB pickup the user should manually override.
function isKeeperSalaryEstimated(playerName) {
  if (!playerName) return false;
  const exc = (typeof getKeeperPriceExceptions === "function") ? getKeeperPriceExceptions() : {};
  if (exc[playerName] != null) return false;
  const allOfPlayer = _historyPicksFor(playerName).sort((a, b) => b.year - a.year);
  if (!allOfPlayer.length) return false;
  const upcomingYear = getUpcomingDraftYear();
  const mostRecent = allOfPlayer[0];
  return (upcomingYear - mostRecent.year) > 1;
}

// --- Keeper contract eligibility -----------------------------------------
// Ported from The League App's getContractStatus (js/app.js). Determines how
// many keeper years a player has left and whether they can be kept next season,
// derived from this tool's ESPN draft history. Constitution §2:
//   drafted ≤$40 → 3 additional keeper years; >$40 → 2; >$50 → 1.
//   A player past their final contract year cannot be kept.
// NOTE: This covers the "expiring contract" case. The "added via FA after the
// trade deadline" case is a transaction-level event we can't see from draft
// history — flag those manually (setMyIneligible) on the Keepers page.
function _maxKeepYears(originalPrice, fromMinors) {
  if (fromMinors) return 3;
  if (originalPrice > 50) return 1;
  if (originalPrice > 40) return 2;
  return 3;
}

// Returns contract status for an ML player by name, or { known:false } when we
// have no draft record (e.g. a recent FA pickup never seen in an auction).
function getKeeperContractStatus(playerName) {
  if (!playerName) return { known: false, canKeepNextSeason: true, status: "unknown", label: "no record" };
  const picks = _historyPicksFor(playerName).sort((a, b) => a.year - b.year);
  if (!picks.length) {
    return { known: false, canKeepNextSeason: true, status: "unknown", label: "no record",
      yearsKept: null, yearsRemaining: null, originalPrice: null };
  }
  const currentSeason = getUpcomingDraftYear() - 1;   // the season just played
  // The current contract begins at the most recent auction (non-keeper) pick.
  // If we only ever see keeper picks (auction predates our history window), fall
  // back to the earliest pick and flag the original price as estimated.
  const auctions = picks.filter(p => !p.keeper);
  const acq = auctions.length ? auctions[auctions.length - 1] : picks[0];
  const estimated = !auctions.length;
  const acquisitionYear = acq.year;
  const originalPrice = Math.max(1, acq.price || 1);
  const fromMinors = false;   // not derivable from auction history; ML default
  const maxYears = _maxKeepYears(originalPrice, fromMinors);
  const yearsKept = Math.max(0, currentSeason - acquisitionYear);
  const yearsRemaining = maxYears - yearsKept;
  const canKeepNextSeason = yearsRemaining > 0;

  let status, label;
  if (yearsRemaining <= 0) { status = "final"; label = "Final year — can't keep " + (currentSeason + 1); }
  else if (yearsRemaining === 1) { status = "expiring"; label = "1 keeper yr left"; }
  else { status = "ok"; label = yearsRemaining + " keeper yrs left"; }

  return {
    known: true, estimated, canKeepNextSeason, status, label,
    yearsKept, yearsRemaining, maxYears, originalPrice, acquisitionYear,
  };
}

// Compute behavior profile for one owner across all years. Applies owner
// aliases (GUID-first, name fallback) so historical team names roll up
// under the current owner. Skips picks from excluded GUIDs (former owners).
function computeOwnerProfile(ownerName) {
  const allOwnerPicks = _history.picks.filter(p =>
    !isOwnerExcluded(p.espnOwnerGuid) &&
    resolveOwnerForPick(p) === ownerName
  );
  const picks = allOwnerPicks.filter(p => !p.keeper);
  const keeperPicks = allOwnerPicks.filter(p => p.keeper);
  if (!picks.length && !keeperPicks.length) return null;

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

  // Per-year top-3 share — average of (top 3 prices that year / total spent that
  // year). This actually measures style: a stars-and-scrubs drafter does it
  // every draft, while a spread drafter never has runaway top picks.
  const byYear = {};
  for (const p of picks) {
    if (!byYear[p.year]) byYear[p.year] = { prices: [], total: 0 };
    byYear[p.year].prices.push(p.price);
    byYear[p.year].total += p.price;
  }
  let perYearTop3Sum = 0, yearCount = 0;
  let perYearBigBidsSum = 0;
  let perYearMaxBidSum = 0;
  for (const y of Object.values(byYear)) {
    const sorted = y.prices.slice().sort((a, b) => b - a);
    const top3 = sorted.slice(0, 3).reduce((s, v) => s + v, 0);
    if (y.total > 0) {
      perYearTop3Sum += top3 / y.total;
      yearCount += 1;
      perYearBigBidsSum += sorted.filter(p => p >= 25).length;
      perYearMaxBidSum += sorted[0] || 0;
    }
  }
  const top3Share = yearCount > 0 ? perYearTop3Sum / yearCount : 0;
  const bigBidsPerYear = yearCount > 0 ? perYearBigBidsSum / yearCount : 0;
  const avgMaxBidPerYear = yearCount > 0 ? perYearMaxBidSum / yearCount : 0;
  const bigMoneyShare = picks.filter(p => p.price >= 25).length / picks.length;

  // Tier breakdown
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

  const yearsPlayed = Array.from(new Set(picks.map(p => p.year))).sort();
  const picksPerYear = picks.length / yearsPlayed.length;
  const mostSpentOn = Object.entries(posSpend).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Top 8 most expensive picks ever
  const topPicks = picks.slice().sort((a, b) => b.price - a.price).slice(0, 8)
    .map(p => ({ player: p.player, year: p.year, price: p.price, pos: normalizePosKey(p.pos) }));

  // Repeat targets: players this owner drafted in multiple years (loyalty signal)
  const playerCounts = {};
  for (const p of picks) {
    if (!playerCounts[p.player]) playerCounts[p.player] = { count: 0, years: [], totalPrice: 0 };
    playerCounts[p.player].count += 1;
    playerCounts[p.player].years.push(p.year);
    playerCounts[p.player].totalPrice += p.price;
  }
  const repeatTargets = Object.entries(playerCounts)
    .filter(([_, v]) => v.count >= 2)
    .map(([name, v]) => ({ name, count: v.count, years: v.years.sort(), avgPrice: v.totalPrice / v.count }))
    .sort((a, b) => b.count - a.count || b.avgPrice - a.avgPrice)
    .slice(0, 8);

  // Per-position average price (for spotting "pays up for SP" type tendencies)
  const posAvgPrice = {};
  const posCount = {};
  for (const p of picks) {
    const k = normalizePosKey(p.pos);
    posAvgPrice[k] = (posAvgPrice[k] || 0) + p.price;
    posCount[k] = (posCount[k] || 0) + 1;
  }
  for (const k of Object.keys(posAvgPrice)) {
    posAvgPrice[k] = posAvgPrice[k] / posCount[k];
  }

  // Highest single pick per year
  const topPickByYear = {};
  for (const p of picks) {
    if (!topPickByYear[p.year] || p.price > topPickByYear[p.year].price) {
      topPickByYear[p.year] = { player: p.player, price: p.price, pos: normalizePosKey(p.pos) };
    }
  }

  // === Keeper context: avg keepers + total roster slots per position per year ===
  // Tells us if owners' draft tendencies are filling holes vs adding more.
  const yearPosKeepers = {};  // {year: {pos: count}}
  const yearPosDrafted = {};  // {year: {pos: count}}
  const yearKeeperCost = {};  // {year: total $ in keepers}
  const yearMaxKeeperPrice = {}; // {year: priciest single keeper}
  const yearExpensiveKeepers = {}; // {year: count of $20+ keepers}
  for (const p of keeperPicks) {
    if (!yearPosKeepers[p.year]) yearPosKeepers[p.year] = {};
    const k = normalizePosKey(p.pos);
    yearPosKeepers[p.year][k] = (yearPosKeepers[p.year][k] || 0) + 1;
    yearKeeperCost[p.year] = (yearKeeperCost[p.year] || 0) + p.price;
    if (!yearMaxKeeperPrice[p.year] || p.price > yearMaxKeeperPrice[p.year]) yearMaxKeeperPrice[p.year] = p.price;
    if (p.price >= 20) yearExpensiveKeepers[p.year] = (yearExpensiveKeepers[p.year] || 0) + 1;
  }
  for (const p of picks) {
    if (!yearPosDrafted[p.year]) yearPosDrafted[p.year] = {};
    const k = normalizePosKey(p.pos);
    yearPosDrafted[p.year][k] = (yearPosDrafted[p.year][k] || 0) + 1;
  }
  const avgKeepersByPos = {};
  const avgDraftedByPos = {};
  const yrCount = yearsPlayed.length || 1;
  for (const yr of yearsPlayed) {
    const yk = yearPosKeepers[yr] || {};
    const yd = yearPosDrafted[yr] || {};
    for (const [k, v] of Object.entries(yk)) avgKeepersByPos[k] = (avgKeepersByPos[k] || 0) + v;
    for (const [k, v] of Object.entries(yd)) avgDraftedByPos[k] = (avgDraftedByPos[k] || 0) + v;
  }
  for (const k of Object.keys(avgKeepersByPos)) avgKeepersByPos[k] /= yrCount;
  for (const k of Object.keys(avgDraftedByPos)) avgDraftedByPos[k] /= yrCount;
  const totalSlotByPos = {};
  for (const k of new Set([...Object.keys(avgKeepersByPos), ...Object.keys(avgDraftedByPos)])) {
    totalSlotByPos[k] = (avgKeepersByPos[k] || 0) + (avgDraftedByPos[k] || 0);
  }

  // Avg keeper financial profile
  const avgKeeperCost = Object.values(yearKeeperCost).reduce((s, v) => s + v, 0) / yrCount;
  const avgMaxKeeperPrice = Object.values(yearMaxKeeperPrice).reduce((s, v) => s + v, 0) / Math.max(1, Object.keys(yearMaxKeeperPrice).length);
  const avgExpensiveKeepersPerYear = Object.values(yearExpensiveKeepers).reduce((s, v) => s + v, 0) / yrCount;
  const avgDraftBudget = 260 - avgKeeperCost;  // remaining $ to spend on draft

  return {
    owner: ownerName,
    picks: picks.length,
    keeperCount: keeperPicks.length,
    totalSpent,
    meanPrice,
    maxPrice,
    picksPerYear,
    posSpendPct,
    posAvgPrice,
    posCount,
    avgKeepersByPos,
    avgDraftedByPos,
    totalSlotByPos,
    avgKeeperCost,
    avgMaxKeeperPrice,
    avgExpensiveKeepersPerYear,
    avgDraftBudget,
    closerBias,
    spSpend,
    hitSpend,
    top3Share,
    bigBidsPerYear,
    avgMaxBidPerYear,
    bigMoneyShare,
    tierShape,
    mostSpentOn,
    years: yearsPlayed,
    topPicks,
    repeatTargets,
    topPickByYear,
  };
}

// Compute league-wide averages so per-owner profiles can be shown as DELTAS.
function computeLeagueAverages() {
  const profiles = computeAllOwnerProfiles();
  const owners = Object.values(profiles).filter(p => p);
  if (!owners.length) return null;
  const avg = {
    posSpendPct: {}, posAvgPrice: {}, meanPrice: 0, top3Share: 0, maxPrice: 0,
    bigBidsPerYear: 0, avgMaxBidPerYear: 0,
    avgKeepersByPos: {}, avgDraftedByPos: {}, totalSlotByPos: {},
    avgKeeperCost: 0, avgMaxKeeperPrice: 0, avgExpensiveKeepersPerYear: 0,
    avgDraftBudget: 0,
  };
  for (const p of owners) {
    avg.meanPrice += p.meanPrice;
    avg.top3Share += p.top3Share;
    avg.maxPrice += p.maxPrice;
    avg.bigBidsPerYear += p.bigBidsPerYear || 0;
    avg.avgMaxBidPerYear += p.avgMaxBidPerYear || 0;
    avg.avgKeeperCost += p.avgKeeperCost || 0;
    avg.avgMaxKeeperPrice += p.avgMaxKeeperPrice || 0;
    avg.avgExpensiveKeepersPerYear += p.avgExpensiveKeepersPerYear || 0;
    avg.avgDraftBudget += p.avgDraftBudget || 0;
    for (const [k, v] of Object.entries(p.posSpendPct)) avg.posSpendPct[k] = (avg.posSpendPct[k] || 0) + v;
    for (const [k, v] of Object.entries(p.posAvgPrice)) avg.posAvgPrice[k] = (avg.posAvgPrice[k] || 0) + v;
    for (const [k, v] of Object.entries(p.avgKeepersByPos || {})) avg.avgKeepersByPos[k] = (avg.avgKeepersByPos[k] || 0) + v;
    for (const [k, v] of Object.entries(p.avgDraftedByPos || {})) avg.avgDraftedByPos[k] = (avg.avgDraftedByPos[k] || 0) + v;
    for (const [k, v] of Object.entries(p.totalSlotByPos || {})) avg.totalSlotByPos[k] = (avg.totalSlotByPos[k] || 0) + v;
  }
  const n = owners.length;
  for (const f of ["meanPrice", "top3Share", "maxPrice", "bigBidsPerYear", "avgMaxBidPerYear", "avgKeeperCost", "avgMaxKeeperPrice", "avgExpensiveKeepersPerYear", "avgDraftBudget"]) avg[f] /= n;
  for (const m of ["posSpendPct", "posAvgPrice", "avgKeepersByPos", "avgDraftedByPos", "totalSlotByPos"]) {
    for (const k of Object.keys(avg[m])) avg[m][k] /= n;
  }
  return avg;
}

// Generate a written tendency profile paragraph for an owner. Position-neutral
// where possible (no specific player names) — synthesizes style, position
// emphasis, and behavioral patterns into a 2-4 sentence narrative.
function ownerNarrative(profile, leagueAvg, styleLabel) {
  if (!profile || !leagueAvg) return "";
  const sentences = [];

  // 1. Overall spending style
  const top3 = (profile.top3Share * 100).toFixed(0);
  const lgTop3 = (leagueAvg.top3Share * 100).toFixed(0);
  const bigs = profile.bigBidsPerYear.toFixed(1);
  const lgBigs = leagueAvg.bigBidsPerYear.toFixed(1);
  if (styleLabel === "stars+scrubs") {
    sentences.push("Classic stars-and-scrubs drafter — concentrates " + top3 + "% of each draft's spending in the top 3 picks (league " + lgTop3 + "%) and makes " + bigs + " bids of $25+ per year (league " + lgBigs + ").");
  } else if (styleLabel === "spread") {
    sentences.push("Spread drafter that goes for depth over star power, rarely making mega-bids (" + bigs + " bids of $25+ per year vs league " + lgBigs + "). Top 3 picks only soak up " + top3 + "% of the budget.");
  } else if (styleLabel === "top-heavy") {
    sentences.push("Top-heavy build with calculated bursts of spending. Biggest bid averages $" + profile.avgMaxBidPerYear.toFixed(0) + " per year and top 3 picks claim " + top3 + "% of the budget.");
  } else {
    sentences.push("Balanced approach — neither concentrated stars-and-scrubs nor pure depth play. Top 3 picks take " + top3 + "% of each draft's budget (close to league " + lgTop3 + "%).");
  }

  // 2. Position emphasis (keeper-aware, using total slot footprint)
  const heavyPositions = [];
  const lightPositions = [];
  const fromKeepers = {};
  for (const pos of ["SP", "RP", "OF", "C", "1B", "2B", "3B", "SS"]) {
    const myTotal = profile.totalSlotByPos[pos] || 0;
    const lgTotal = leagueAvg.totalSlotByPos[pos] || 0;
    const diff = myTotal - lgTotal;
    if (myTotal < 0.5) continue;
    if (diff >= 0.8) {
      const keptShare = (profile.avgKeepersByPos[pos] || 0) / myTotal;
      fromKeepers[pos] = keptShare > 0.6 ? "mostly via keepers" : keptShare > 0.3 ? "keepers+draft mix" : "drafts heavy";
      heavyPositions.push(pos);
    } else if (diff <= -0.8) {
      lightPositions.push(pos);
    }
  }
  if (heavyPositions.length || lightPositions.length) {
    const heavyDesc = heavyPositions.length
      ? "leans heavy on " + heavyPositions.map(p => p + " (" + fromKeepers[p] + ")").join(", ")
      : "";
    const lightDesc = lightPositions.length ? "underweights " + lightPositions.join(", ") : "";
    const join = heavyDesc && lightDesc ? "; " : "";
    sentences.push("Position-wise, " + heavyDesc + join + lightDesc + ".");
  } else {
    sentences.push("Position-neutral — no major over- or underweights relative to league.");
  }

  // 3. Closer / SP behavioral patterns
  const tendencies = [];
  if (profile.closerBias > 0.13) tendencies.push("pays up for closers in the draft (" + (profile.closerBias * 100).toFixed(0) + "% of draft budget on RP vs league " + ((leagueAvg.posSpendPct.RP || 0) * 100).toFixed(0) + "%)");
  else if (profile.closerBias < 0.04 && (profile.avgKeepersByPos.RP || 0) < 1) tendencies.push("streams saves rather than buying them");
  if (profile.spSpend > 0.30 && (profile.avgKeepersByPos.SP || 0) < 2) tendencies.push("drafts SP aggressively to compensate for thin pitching keepers");
  else if (profile.spSpend < 0.15 && (profile.avgKeepersByPos.SP || 0) >= 2.5) tendencies.push("builds around cheap SP keepers and uses draft $ for hitting");
  if (tendencies.length) sentences.push("Behavioral tilts: " + tendencies.join("; ") + ".");

  // 4. Keeper financial profile + how it constrains draft bids
  const kc = profile.avgKeeperCost;
  const lgKc = leagueAvg.avgKeeperCost || 0;
  const maxK = profile.avgMaxKeeperPrice || 0;
  const lgMaxK = leagueAvg.avgMaxKeeperPrice || 0;
  if (kc >= lgKc * 1.15 && lgKc > 0) {
    const heavyKeeperNote = "Heavy keeper commitment — locks $" + kc.toFixed(0) + " into keepers each year (league $" + lgKc.toFixed(0) + "), leaving roughly $" + profile.avgDraftBudget.toFixed(0) + " for the auction.";
    let bidNote = "";
    if (profile.avgMaxBidPerYear < leagueAvg.avgMaxBidPerYear * 0.92) {
      bidNote = " That explains the restrained top draft bid ($" + profile.avgMaxBidPerYear.toFixed(0) + " avg vs league $" + leagueAvg.avgMaxBidPerYear.toFixed(0) + ") — the money's already committed.";
    } else if (maxK >= 30) {
      bidNote = " Top keeper averages $" + maxK.toFixed(0) + " — they're stacking talent before the gavel even drops.";
    }
    sentences.push(heavyKeeperNote + bidNote);
  } else if (kc <= lgKc * 0.85 && lgKc > 0) {
    sentences.push("Light keeper load — only $" + kc.toFixed(0) + " committed pre-draft (league $" + lgKc.toFixed(0) + "), so they walk in with $" + profile.avgDraftBudget.toFixed(0) + "+ to deploy. Their drafted top bid ($" + profile.avgMaxBidPerYear.toFixed(0) + ") reflects that flexibility.");
  } else {
    // 5. Top-bid aggressiveness (only if keeper load is average)
    if (profile.avgMaxBidPerYear >= leagueAvg.avgMaxBidPerYear * 1.12) {
      sentences.push("Willing to go to war on a single player — biggest annual bid averages $" + profile.avgMaxBidPerYear.toFixed(0) + ", well above the league norm of $" + leagueAvg.avgMaxBidPerYear.toFixed(0) + ".");
    } else if (profile.avgMaxBidPerYear <= leagueAvg.avgMaxBidPerYear * 0.85) {
      sentences.push("Restrained at the top — never pushes past $" + profile.avgMaxBidPerYear.toFixed(0) + " on a single player vs league $" + leagueAvg.avgMaxBidPerYear.toFixed(0) + ".");
    }
  }

  return sentences.join(" ");
}

// Generate human-readable insight strings for an owner.
function ownerInsights(profile, leagueAvg, styleLabel) {
  if (!profile || !leagueAvg) return [];
  const out = [];
  // Style insight: relative to league
  const top3Delta = (profile.top3Share - leagueAvg.top3Share) * 100;
  const bidsDelta = profile.bigBidsPerYear - leagueAvg.bigBidsPerYear;
  if (styleLabel === "stars+scrubs") {
    out.push({ kind: "style", text: "Stars+scrubs — top 3 picks = " + (profile.top3Share * 100).toFixed(0) + "% of budget/year (vs league " + (leagueAvg.top3Share * 100).toFixed(0) + "%), avg " + profile.bigBidsPerYear.toFixed(1) + " bids ≥$25 per draft" });
  } else if (styleLabel === "spread") {
    out.push({ kind: "style", text: "Spread drafter — only " + (profile.bigBidsPerYear.toFixed(1)) + " bids ≥$25/year (league " + leagueAvg.bigBidsPerYear.toFixed(1) + "), top 3 = " + (profile.top3Share * 100).toFixed(0) + "% of budget" });
  } else {
    out.push({ kind: "style", text: esc(styleLabel.charAt(0).toUpperCase() + styleLabel.slice(1)) + " — top 3 share " + (profile.top3Share * 100).toFixed(0) + "% (lg " + (leagueAvg.top3Share * 100).toFixed(0) + "%), " + profile.bigBidsPerYear.toFixed(1) + " big bids/yr (lg " + leagueAvg.bigBidsPerYear.toFixed(1) + ")" });
  }
  // Big spender check
  if (profile.avgMaxBidPerYear >= leagueAvg.avgMaxBidPerYear * 1.10) out.push({ kind: "style", text: "Goes hard on the top guy — avg $" + profile.avgMaxBidPerYear.toFixed(0) + "/year on biggest bid (league $" + leagueAvg.avgMaxBidPerYear.toFixed(0) + ")" });
  // KEEPER-AWARE position tendencies. Look at total slot footprint
  // (keepers + drafted) per position vs league. This catches "SP build" or
  // "OF hoarder" patterns even when most SP comes from keepers.
  for (const pos of ["SP", "RP", "C", "1B", "2B", "3B", "SS", "OF"]) {
    const myTotal = profile.totalSlotByPos[pos] || 0;
    const lgTotal = leagueAvg.totalSlotByPos[pos] || 0;
    if (myTotal < 0.5 || lgTotal < 0.5) continue;
    const diff = myTotal - lgTotal;
    if (diff >= 0.8) {
      const keptShare = (profile.avgKeepersByPos[pos] || 0) / myTotal;
      const buildNote = keptShare > 0.6 ? " (mostly via keepers)" : keptShare > 0.3 ? " (mix of keepers + draft)" : " (drafts heavy)";
      out.push({ kind: "pos-up", text: pos + "-heavy build — " + myTotal.toFixed(1) + " avg slots/year vs league " + lgTotal.toFixed(1) + buildNote });
    } else if (diff <= -0.8) {
      out.push({ kind: "pos-down", text: "Light on " + pos + " — " + myTotal.toFixed(1) + " avg slots vs league " + lgTotal.toFixed(1) });
    }
  }
  // RP tendency (drafted spend), but only flag if not already heavy via keepers
  if (profile.closerBias > 0.13) out.push({ kind: "closer-up", text: "Pays for closers in the draft — " + (profile.closerBias * 100).toFixed(0) + "% of draft budget on RP (league " + ((leagueAvg.posSpendPct.RP || 0) * 100).toFixed(0) + "%)" });
  else if (profile.closerBias < 0.04 && (profile.avgKeepersByPos.RP || 0) < 1) out.push({ kind: "closer-down", text: "Streams saves — " + (profile.closerBias * 100).toFixed(0) + "% on RP and few RP keepers" });
  // SP draft tendency, contextual
  if (profile.spSpend > 0.30 && (profile.avgKeepersByPos.SP || 0) < 2) out.push({ kind: "sp-up", text: "Drafts SP heavily — " + (profile.spSpend * 100).toFixed(0) + "% of draft $ on starters (and only " + (profile.avgKeepersByPos.SP || 0).toFixed(1) + " avg SP keepers)" });
  else if (profile.spSpend < 0.15 && (profile.avgKeepersByPos.SP || 0) >= 2.5) out.push({ kind: "sp-down", text: "Builds around SP keepers — avg " + (profile.avgKeepersByPos.SP || 0).toFixed(1) + " SP kept, only " + (profile.spSpend * 100).toFixed(0) + "% of draft $ on SP" });
  // Repeat targets
  if (profile.repeatTargets.length > 0) {
    const top = profile.repeatTargets[0];
    if (top.count >= 3) {
      out.push({ kind: "loyalty", text: "Loyal to " + top.name + " (drafted " + top.count + " years: " + top.years.join(", ") + ")" });
    }
  }
  return out;
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
  // Loyalty: owners who draft the same player year after year overpay to keep
  // "their guy". Map repeat targets → a bid premium scaled by how many years.
  const targets = {};
  for (const t of (profile.repeatTargets || [])) {
    if (!t || t.count < 2) continue;
    targets[t.name] = t.count >= 4 ? 1.20 : t.count >= 3 ? 1.14 : 1.08;
  }
  return { aggression, posBias, topTierAppetite, targets };
}

loadHistoryFromStorage();
