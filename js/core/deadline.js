// Deadline-trade model for the title-odds Monte Carlo. Pure functions — no
// DOM, no fetch.
//
// The base simulator assumes rosters are FROZEN. In reality, contenders buy
// stars at the deadline and out-of-it teams sell them (in this keeper league,
// sellers ship out players they won't keep for prospects, so the current-season
// value transfer is one-directional). This module builds a "trade model" that
// simulateTitleOdds() can apply per simulated season:
//
//   - Every team gets a BUYER weight (prob of a top-4 finish) and a SELLER
//     weight (prob of a bottom-5 finish), read from a base frozen-roster odds
//     run. Mid-pack teams score low on both — realistically unpredictable.
//   - Each team's best rest-of-season players (by projected value) are its
//     "chips" — the players who could plausibly move.
//   - Each simulated season draws K ~ Poisson(lambda) future trades. Each
//     trade picks a seller (∝ seller weight), one of its chips (∝ value, the
//     biggest stars are the likeliest to move), and a buyer (∝ buyer weight),
//     then moves NET_TRANSFER of the chip's remaining stats seller → buyer.
//     The discount covers the replacement player on each side (the seller
//     promotes a bench bat, the buyer benches his worst starter), and being
//     symmetric it keeps the league total exactly conserved — trades move
//     stats, they don't create them.
//   - lambda scales with the fraction of the trade window still open, so the
//     adjustment fades to zero at the deadline and never double-counts deals
//     that already happened (those are in the live rosters).
//
// Calibration: the league's Supabase trade log showed 4 trades by mid-July
// 2026, so ~5 star-moving deals per season is the default rate.

const DEADLINE_TRADES_PER_SEASON = 5;   // expected star trades over a full trade window
const DEADLINE_NET_TRANSFER = 0.8;      // net stat transfer after replacement effects
const DEADLINE_CHIPS_PER_TEAM = 3;      // tradeable stars considered per team

// Component keys that fully determine all 10 category totals. Counting cats
// move directly; the rate cats (OBP/ERA/WHIP) are re-derived from numerator /
// denominator so a traded player shifts them correctly on both sides.
const DEADLINE_COMP_KEYS = [
  "R", "HR", "RBI", "SB", "QS", "K", "SV_HLD",
  "obpNum", "obpDen", "er", "ip", "whipNum",
];

// Extract the component vector from an aggregateTeamCats() result.
function _dlComponentsFromTotals(t) {
  return {
    R: t.R, HR: t.HR, RBI: t.RBI, SB: t.SB, QS: t.QS, K: t.K, SV_HLD: t.SV_HLD,
    obpNum: t._obpNum, obpDen: t._obpDen, er: t._er, ip: t._ip, whipNum: t._whipNum,
  };
}

// Derive all 10 category values from a component vector. Zero-IP teams rank
// worst in ERA/WHIP (same convention as rankCategory).
function _dlCatValues(c) {
  return {
    R: c.R, HR: c.HR, RBI: c.RBI, SB: c.SB, QS: c.QS, K: c.K, SV_HLD: c.SV_HLD,
    OBP: c.obpDen > 0 ? c.obpNum / c.obpDen : 0,
    ERA: c.ip > 0 ? (c.er * 9) / c.ip : Infinity,
    WHIP: c.ip > 0 ? c.whipNum / c.ip : Infinity,
  };
}

// Scalar rest-of-season value of a chip — same shape as the lineup optimizer's
// value heuristics, computed from the component vector (obpDen ≈ PA).
function _dlChipValue(c) {
  const hit = (c.R || 0) * 0.7 + (c.RBI || 0) * 0.7 + (c.HR || 0) * 1.3 + (c.SB || 0) * 1.4 +
    Math.max(0, (c.obpDen > 0 ? c.obpNum / c.obpDen : 0) - 0.300) * (c.obpDen || 0) * 3;
  const ip = c.ip || 0;
  const era = ip > 0 ? (c.er * 9) / ip : 9;
  const whip = ip > 0 ? c.whipNum / ip : 9;
  const pit = (c.K || 0) * 0.3 + (c.QS || 0) * 2.5 + (c.SV_HLD || 0) * 1.8 +
    Math.max(0, 4.20 - era) * ip * 0.3 + Math.max(0, 1.28 - whip) * ip * 0.5;
  return hit + pit;
}

// Move `net` of a chip's components from seller to buyer (in place).
function _dlApplyTrade(sellerComp, buyerComp, chipComp, net) {
  for (const k of DEADLINE_COMP_KEYS) {
    const d = (chipComp[k] || 0) * net;
    sellerComp[k] -= d;
    buyerComp[k] += d;
  }
}

// Knuth Poisson sampler (lambda is small — a handful of trades).
function _dlPoisson(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// Weighted pick from items[] by weights[]; returns an index, or -1 when the
// total weight is ~zero (nobody plausible to pick).
function _dlWeightedPick(weights) {
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 1e-9)) return -1;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// Build the trade model from the engine rosters and a base (frozen-roster)
// simulateTitleOdds() result. Returns null when there's nothing to model.
//   rosters  = { teamId: [stat lines] } — the same rosters passed to the sim.
//   baseOdds = simulateTitleOdds(rosters, ...) with finishDist per team.
//   opts     = { windowFrac (0..1 of the trade window left, required),
//                lambda (override trades/season), chipsPerTeam }
function buildTradeModel(rosters, baseOdds, opts) {
  opts = opts || {};
  const byTeam = (baseOdds && baseOdds.byTeam) || {};
  const teamIds = Object.keys(rosters || {});
  const n = teamIds.length;
  if (n < 4) return null;

  // Buyer = likely top-4 finish; seller = likely bottom-5. From the base run's
  // finish distribution, so "who buys/sells" carries the same uncertainty the
  // sim already established.
  const buyerW = {}, sellerW = {};
  for (const id of teamIds) {
    const dist = (byTeam[id] && byTeam[id].finishDist) || [];
    let b = 0, s = 0;
    for (let p = 0; p < dist.length; p++) {
      if (p < 4) b += dist[p];
      if (p >= n - 5) s += dist[p];
    }
    buyerW[id] = b;
    sellerW[id] = s;
  }

  // Chips: each team's top rest-of-season players. Group the FUTURE stat lines
  // by player name — in Full-Season mode those carry _ros (YTD lines stay put:
  // banked stats never move in a trade); in ROS mode every line is future.
  const chipsPerTeam = opts.chipsPerTeam || DEADLINE_CHIPS_PER_TEAM;
  const chips = [];
  for (const id of teamIds) {
    const lines = rosters[id] || [];
    const hasTags = lines.some(l => l && l._ros);
    const future = hasTags ? lines.filter(l => l && l._ros) : lines;
    const byName = new Map();
    for (const l of future) {
      if (!l || !l.name) continue;
      if (!byName.has(l.name)) byName.set(l.name, []);
      byName.get(l.name).push(l);
    }
    const cand = [];
    for (const [name, pls] of byName) {
      // aggregateTeamCats on one player's lines yields his component vector
      // (two-way players' hitter+pitcher lines merge into a single chip).
      const comp = _dlComponentsFromTotals(aggregateTeamCats(pls));
      const value = _dlChipValue(comp);
      if (value > 0) cand.push({ name, teamId: id, comp, value });
    }
    cand.sort((a, b) => b.value - a.value);
    chips.push(...cand.slice(0, chipsPerTeam));
  }
  if (!chips.length) return null;

  const windowFrac = Math.max(0, Math.min(1, opts.windowFrac != null ? opts.windowFrac : 1));
  const lambda = (opts.lambda != null ? opts.lambda : DEADLINE_TRADES_PER_SEASON) * windowFrac;

  // Per-team chip index for fast seller→chips lookup during sampling.
  const chipsByTeam = {};
  chips.forEach((c, i) => {
    (chipsByTeam[c.teamId] || (chipsByTeam[c.teamId] = [])).push(i);
  });

  return { chips, chipsByTeam, buyerW, sellerW, lambda, windowFrac, net: DEADLINE_NET_TRANSFER, teamIds };
}

// Draw one simulated season's trades: [{ chip, from, to }]. Each chip moves at
// most once per season.
function _dlSampleTrades(model) {
  const k = Math.min(_dlPoisson(model.lambda), model.chips.length);
  if (!k) return null;
  const trades = [];
  const used = new Set();
  for (let t = 0; t < k; t++) {
    // Seller ∝ seller weight, among teams that still have an untraded chip.
    const sellers = model.teamIds.filter(id =>
      (model.chipsByTeam[id] || []).some(ci => !used.has(ci)));
    const si = _dlWeightedPick(sellers.map(id => model.sellerW[id]));
    if (si < 0) break;
    const seller = sellers[si];
    // Chip ∝ value among the seller's remaining chips.
    const avail = model.chipsByTeam[seller].filter(ci => !used.has(ci));
    const ci = avail[_dlWeightedPick(avail.map(i => model.chips[i].value))];
    if (ci == null) break;
    // Buyer ∝ buyer weight, anyone but the seller.
    const buyers = model.teamIds.filter(id => id !== seller);
    const bi = _dlWeightedPick(buyers.map(id => model.buyerW[id]));
    if (bi < 0) break;
    used.add(ci);
    trades.push({ chip: ci, from: seller, to: buyers[bi] });
  }
  return trades.length ? trades : null;
}

// Expose for the browser test harness / console.
if (typeof window !== "undefined") {
  window.UDDeadline = {
    buildTradeModel, _dlSampleTrades, _dlApplyTrade, _dlComponentsFromTotals,
    _dlCatValues, _dlChipValue, _dlPoisson,
    DEADLINE_TRADES_PER_SEASON, DEADLINE_NET_TRANSFER, DEADLINE_CHIPS_PER_TEAM,
  };
}
