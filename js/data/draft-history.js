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

  return {
    owner: ownerName,
    picks: picks.length,
    totalSpent,
    meanPrice,
    maxPrice,
    picksPerYear,
    posSpendPct,
    posAvgPrice,
    posCount,
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
  const avg = { posSpendPct: {}, posAvgPrice: {}, meanPrice: 0, top3Share: 0, maxPrice: 0, bigBidsPerYear: 0, avgMaxBidPerYear: 0 };
  for (const p of owners) {
    avg.meanPrice += p.meanPrice;
    avg.top3Share += p.top3Share;
    avg.maxPrice += p.maxPrice;
    avg.bigBidsPerYear += p.bigBidsPerYear || 0;
    avg.avgMaxBidPerYear += p.avgMaxBidPerYear || 0;
    for (const [k, v] of Object.entries(p.posSpendPct)) {
      avg.posSpendPct[k] = (avg.posSpendPct[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(p.posAvgPrice)) {
      avg.posAvgPrice[k] = (avg.posAvgPrice[k] || 0) + v;
    }
  }
  const n = owners.length;
  avg.meanPrice /= n;
  avg.top3Share /= n;
  avg.maxPrice /= n;
  avg.bigBidsPerYear /= n;
  avg.avgMaxBidPerYear /= n;
  for (const k of Object.keys(avg.posSpendPct)) avg.posSpendPct[k] /= n;
  for (const k of Object.keys(avg.posAvgPrice)) avg.posAvgPrice[k] /= n;
  return avg;
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
  // Position tendencies — flag any position where they spend 1.5x+ league avg per pick
  for (const [pos, avg] of Object.entries(profile.posAvgPrice)) {
    const lg = leagueAvg.posAvgPrice[pos];
    if (!lg || (profile.posCount[pos] || 0) < 2) continue;
    const ratio = avg / lg;
    if (ratio >= 1.5 && avg >= 8) out.push({ kind: "pos-up", text: "Pays up for " + pos + ": avg $" + avg.toFixed(0) + " vs league $" + lg.toFixed(0) + " (" + (ratio * 100 - 100).toFixed(0) + "% above)" });
    else if (ratio <= 0.6) out.push({ kind: "pos-down", text: "Bargain hunts at " + pos + ": avg $" + avg.toFixed(0) + " vs league $" + lg.toFixed(0) });
  }
  // RP tendency
  if (profile.closerBias > 0.13) out.push({ kind: "closer-up", text: "Closer hoarder — " + (profile.closerBias * 100).toFixed(0) + "% of budget on RP (league avg " + ((leagueAvg.posSpendPct.RP || 0) * 100).toFixed(0) + "%)" });
  else if (profile.closerBias < 0.04) out.push({ kind: "closer-down", text: "Punts saves — only " + (profile.closerBias * 100).toFixed(0) + "% on RP" });
  // SP tendency
  if (profile.spSpend > 0.30) out.push({ kind: "sp-up", text: "SP-heavy build — " + (profile.spSpend * 100).toFixed(0) + "% on starters" });
  else if (profile.spSpend < 0.15) out.push({ kind: "sp-down", text: "Light on SP — " + (profile.spSpend * 100).toFixed(0) + "% only" });
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
  return { aggression, posBias, topTierAppetite };
}

loadHistoryFromStorage();
