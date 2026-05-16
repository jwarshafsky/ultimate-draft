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

// { historicalName: currentOwnerName } — applied during profile computation so
// e.g. "Jeff" → "Jeff", "Old Jeff Team Name" → "Jeff", etc.
const _ownerAliases = { map: {} };

function loadOwnerAliases() {
  try {
    const v = JSON.parse(localStorage.getItem(OWNER_ALIAS_KEY) || "null");
    if (v) _ownerAliases.map = v.map || v;
  } catch (e) {}
}
function saveOwnerAliases() {
  localStorage.setItem(OWNER_ALIAS_KEY, JSON.stringify({ map: _ownerAliases.map }));
}
function setOwnerAlias(historicalName, currentName) {
  if (!historicalName) return;
  if (!currentName) delete _ownerAliases.map[historicalName];
  else _ownerAliases.map[historicalName] = currentName;
  saveOwnerAliases();
  if (typeof rerender === "function") rerender();
}
function resolveOwner(name) {
  return _ownerAliases.map[name] || name;
}
function listHistoricalOwners() {
  return Array.from(new Set(_history.picks.map(p => p.owner))).filter(Boolean).sort();
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
// aliases so historical team names roll up under the current owner.
function computeOwnerProfile(ownerName) {
  const picks = _history.picks.filter(p => resolveOwner(p.owner) === ownerName && !p.keeper);
  if (!picks.length) return null;

  const totalSpent = picks.reduce((s, p) => s + p.price, 0);
  const picksWithValue = picks.filter(p => p.value > 0);
  const aggression = picksWithValue.length
    ? picksWithValue.reduce((s, p) => s + (p.price / p.value), 0) / picksWithValue.length
    : 1;

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

  // Closer bias
  const rpSpend = posSpendPct.RP || 0;
  const closerBias = rpSpend; // higher = pays more for relievers

  // Stars-and-scrubs detection: stdev of prices. High stdev = stars-and-scrubs.
  const mean = totalSpent / picks.length;
  const variance = picks.reduce((s, p) => s + Math.pow(p.price - mean, 2), 0) / picks.length;
  const stdev = Math.sqrt(variance);
  const starsScrubs = stdev / Math.max(1, mean); // coefficient of variation

  // Tier shape: average price paid per tier (using $ as the proxy for tier)
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

  // Most expensive position
  const mostSpentOn = Object.entries(posSpend).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    owner: ownerName,
    picks: picks.length,
    totalSpent,
    aggression,
    posSpendPct,
    closerBias,
    starsScrubs,
    tierShape,
    mostSpentOn,
    years: Array.from(new Set(picks.map(p => p.year))),
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
// Uses resolved (alias-applied) owner names so historical team-renames roll
// up under the current owner.
function computeAllOwnerProfiles() {
  const owners = Array.from(new Set(_history.picks.map(p => resolveOwner(p.owner)))).filter(Boolean);
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
  // Aggression: history-observed price/value ratio, clamp to [0.85, 1.25]
  const aggression = Math.max(0.85, Math.min(1.25, profile.aggression || 1));
  // Position bias: scaled deviation from average
  const posBias = {};
  for (const [pos, pct] of Object.entries(profile.posSpendPct)) {
    // Normal team spends ~16% on SP, ~8% on RP, ~12% on OF... use these as anchors
    const anchor = { SP: 0.18, RP: 0.08, OF: 0.30, C: 0.04, "1B": 0.06, "2B": 0.05, "3B": 0.06, SS: 0.07, UTIL: 0.04 }[pos] || 0.05;
    posBias[pos] = Math.max(0.5, Math.min(1.5, 1 + (pct - anchor) * 2));
  }
  // Stars-and-scrubs raises top-tier appetite
  const topTierAppetite = 1 + Math.max(0, Math.min(0.6, profile.starsScrubs - 0.5));
  return { aggression, posBias, topTierAppetite };
}

loadHistoryFromStorage();
