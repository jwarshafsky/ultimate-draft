// Mock draft simulator — runs a full auction with heuristic AI bidders.
//
// Architecture: a pure-function engine that takes a config and returns picks.
// AI agents have per-owner bias profiles (will be filled in from history and
// from Jeff's notes on each owner). For now, all owners use the same default
// profile and we expose hooks so individual owners can be tuned later.
//
// Each "tick" of the simulator:
//   1. Current nominator picks a player from their target list (or strategic).
//   2. All other teams bid up to their max, in turn-based fashion.
//   3. Highest bidder wins; roster slot consumed; budget decremented.
//   4. Nomination order advances. Inflation recomputes.
//
// The engine returns an array of Picks plus per-team summaries. The UI can
// either show the full result at once or replay pick-by-pick.

const DEFAULT_PROFILE = {
  // Multiplicative bias on every bid. >1 = aggressive overpay, <1 = bargain hunter.
  aggression: 1.0,
  // Variance per bid (random noise added to perceived value)
  noise: 0.07,
  // Penalty on bidding past max(budget - remaining slots) safety floor
  safetyMargin: 0,
  // Per-position multipliers (e.g. {SP: 1.1, RP: 0.9} = pays more for SP, less for RP)
  posBias: {},
  // Stars-and-scrubs vs balanced: probability of jumping in on top-tier players
  topTierAppetite: 1.0,
  // Whether this owner adheres to filling out positions sensibly (1) or freelances (0.5)
  rosterDiscipline: 1.0,
  // Nomination strategy mix (probabilities should sum to ~1)
  nomMix: { target: 0.35, dump: 0.25, drain: 0.25, blocker: 0.15 },
};

// Build a per-team state at simulation start, given current keepers.
// Owner profiles auto-apply from draft history if available; explicit
// opts.profiles[teamId] overrides.
function buildMockTeamStates(opts) {
  const states = {};
  // Keepers come from the Keepers tab (predicted keepers), not league-site marks.
  const selections = (typeof getEffectiveKeeperSelections === "function") ? getEffectiveKeeperSelections() : getKeeperSelections();
  // Pre-compute history-derived profiles if available
  const historyProfiles = (typeof computeAllOwnerProfiles === "function") ? computeAllOwnerProfiles() : {};
  for (const t of LEAGUE.teams) {
    const teamSel = selections[t.id] || {};
    const kept = [];
    let keptCost = 0;
    for (const [name, flags] of Object.entries(teamSel)) {
      if (flags.minorKeeper) continue;
      if (flags.keeper) {
        const ci = (typeof getLeagueContractByName === "function") ? getLeagueContractByName(name) : null;
        const price = ci ? ci.cost : (getCurrentKeeperSalary(name) ?? 0);
        const pv = _mockPlayerValue(name);
        kept.push({ name, price, pos: pv?.posKey || "UTIL", elig: pv?.elig || [pv?.posKey || "UTIL"] });
        keptCost += price;
      }
    }
    // Layer profiles: DEFAULT_PROFILE → history overlay → opts overlay
    let profile = { ...DEFAULT_PROFILE };
    const histProfile = historyProfiles[t.owner];
    if (histProfile && typeof profileToMockOverlay === "function") {
      const overlay = profileToMockOverlay(histProfile);
      if (overlay) profile = { ...profile, ...overlay, posBias: { ...profile.posBias, ...overlay.posBias } };
    }
    if (opts.profiles?.[t.id]) profile = { ...profile, ...opts.profiles[t.id] };
    const startingBudget = LEAGUE.draftBudget - keptCost;
    const slotsToFill = LEAGUE.rosterSize - kept.length;
    // Floor budget at slotsToFill ($1 per remaining slot minimum) so a team
    // with very expensive keepers can still afford $1 picks the rest of the way.
    const safeBudget = Math.max(slotsToFill, startingBudget);
    // Seed the flex slot model with kept players assigned to their best slot.
    const openSlots = initOpenSlots();
    for (const k of kept) assignToSlot(openSlots, k.elig);
    states[t.id] = {
      teamId: t.id,
      teamName: t.name,
      ownerName: t.owner,
      isMe: !!t.isMe,
      profile,
      budget: safeBudget,
      keptCost,            // true keeper spend (for accurate inflation)
      kept,
      drafted: [],
      slotsByPos: countSlotsByPos(kept),
      openSlots,
      slotsRemaining: slotsToFill,
    };
  }
  return states;
}

function countSlotsByPos(roster) {
  const counts = {};
  for (const r of roster) {
    counts[r.pos] = (counts[r.pos] || 0) + 1;
  }
  return counts;
}

// Roster slot targets per team (matching constitution). Kept for endgame.js.
const POS_TARGETS = { C: 1, "1B": 1, "2B": 1, "SS": 1, "3B": 1, MI: 1, CI: 1, OF: 5, UTIL: 1, SP: 6, RP: 3 };

// --- Flex-aware roster slot model ---------------------------------------
// Per-team slot capacities (matches the FanGraphs valuation slot config). The
// engine tracks remaining capacity per slot so multi-eligible players count
// toward whatever slot they actually fill (e.g. a 2B/SS with 2B taken fills MI).
const ROSTER_SLOT_CAP = { C: 1, "1B": 1, "2B": 1, "3B": 1, SS: 1, MI: 1, CI: 1, OF: 5, UTIL: 1, SP: 6, RP: 4 };
// "Hard" slots a legal roster MUST fill — these drive late forced-fill bidding.
// Flex/bench (MI, CI, UTIL, BENCH) are soft (substitutable).
const HARD_SLOTS = new Set(["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP"]);
// How badly a team wants a player whose best open slot is this. Catcher is the
// scarcest single slot; flex slots are worth less than a dedicated need.
const SLOT_NEED_WEIGHT = { C: 1.0, "1B": 0.9, "2B": 0.9, "3B": 0.9, SS: 0.9, OF: 0.85, SP: 0.9, RP: 0.8, MI: 0.62, CI: 0.62, UTIL: 0.5, BENCH: 0.3 };
// Assignment priority: fill the player's specific position first, then middle/
// corner flex, then UTIL, then bench — mirrors how a real lineup is filled.
const SLOT_FILL_ORDER = ["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP", "MI", "CI", "UTIL", "BENCH"];

function initOpenSlots() {
  const o = {};
  for (const [k, v] of Object.entries(ROSTER_SLOT_CAP)) o[k] = v;
  // Bench absorbs whatever roster spots remain beyond the starter slots.
  const starters = Object.values(ROSTER_SLOT_CAP).reduce((s, n) => s + n, 0);
  o.BENCH = Math.max(0, LEAGUE.rosterSize - starters);
  return o;
}

// Assign a player (by eligibility list) to the best open slot, mutating
// openSlots. Returns the slot used. Falls back to BENCH, then null if full.
function assignToSlot(openSlots, elig) {
  const set = new Set(elig && elig.length ? elig : ["UTIL"]);
  for (const slot of SLOT_FILL_ORDER) {
    if (slot === "BENCH") continue;
    if (set.has(slot) && (openSlots[slot] || 0) > 0) { openSlots[slot]--; return slot; }
  }
  if ((openSlots.BENCH || 0) > 0) { openSlots.BENCH--; return "BENCH"; }
  return null;
}

// Need score in [0..1] for a player with these eligible slots: the weight of
// the best slot they could still fill. 0 if the team is completely full.
function positionNeedFor(state, elig) {
  const slots = elig && elig.length ? elig : ["UTIL"];
  let best = 0;
  for (const slot of slots) {
    if ((state.openSlots[slot] || 0) > 0) best = Math.max(best, SLOT_NEED_WEIGHT[slot] || 0.5);
  }
  if (best === 0 && (state.openSlots.BENCH || 0) > 0) best = SLOT_NEED_WEIGHT.BENCH;
  return best;
}

// Backward-compatible shim: need by a single position key (used by nomination
// helpers and any caller that only has a posKey).
function positionNeed(state, posKey) {
  if (state.openSlots) return positionNeedFor(state, [posKey]);
  return 0.5;
}

// Count of still-open HARD (must-fill) slots a player with this eligibility
// could satisfy. Used to detect "I have to buy a catcher now" pressure.
function openHardSlotsFor(state, elig) {
  let n = 0;
  for (const slot of (elig || [])) {
    if (HARD_SLOTS.has(slot)) n += Math.max(0, state.openSlots[slot] || 0);
  }
  return n;
}

// Total open hard slots across the whole roster.
function totalOpenHardSlots(state) {
  let n = 0;
  for (const slot of HARD_SLOTS) n += Math.max(0, state.openSlots[slot] || 0);
  return n;
}

// Forced-fill multiplier: when a team is running out of flexibility and this
// player fills an otherwise-open required slot, real owners pay up rather than
// be left unable to field a legal roster. Catcher (no substitute) hits hardest.
function mustFillBoost(state, elig) {
  const hardOpenForPlayer = openHardSlotsFor(state, elig);
  if (hardOpenForPlayer <= 0) return 1;
  const totalHard = totalOpenHardSlots(state);
  const slack = state.slotsRemaining - totalHard;   // spare picks beyond requirements
  if (slack > 3) return 1;                            // plenty of room, no pressure
  let boost = slack <= 0 ? 1.45 : slack === 1 ? 1.28 : slack === 2 ? 1.15 : 1.07;
  // Catcher with no open catcher elsewhere is the canonical squeeze.
  if ((state.openSlots.C || 0) > 0 && (elig || []).includes("C")) boost *= 1.12;
  return boost;
}

// Normalized-name helpers so keepers/drafted match the valuation list even when
// names differ by accents / suffixes (e.g. "Iván Herrera" vs "Ivan Herrera").
function _mockNk(s) { return (typeof normalizePlayerName === "function") ? normalizePlayerName(s) : String(s || "").toLowerCase(); }
function _mockKeptSet() { return new Set(collectKeepers().map(k => _mockNk(k.name))); }

// Player value looked up by EXACT then NORMALIZED name, so an accented keeper
// (e.g. "José Ramírez") resolves to the value row "Jose Ramirez" and gets its
// real position/eligibility — otherwise it falls back to UTIL and corrupts the
// team's open-slot/needs model.
let _mockValIdx = null, _mockValIdxLen = -1;
function _mockPlayerValue(name) {
  const direct = (typeof getPlayerValue === "function") ? getPlayerValue(name) : null;
  if (direct) return direct;
  const vals = getValues();
  if (_mockValIdx === null || _mockValIdxLen !== vals.length) {
    _mockValIdx = {}; _mockValIdxLen = vals.length;
    for (const p of vals) { const k = _mockNk(p.name); if (!(k in _mockValIdx)) _mockValIdx[k] = p; }
  }
  return _mockValIdx[_mockNk(name)] || null;
}

// What's the most this team would bid for player p, in whole dollars?
//
// Model (calibrated for realistic auction clearing):
//   market = inflatedValue(p) — a BUDGET-CONSERVING price (value × inflation ×
//     positional scarcity). Summed over a draft it ≈ total budget, so clearing
//     near `market` keeps total spend right and star prices near projection.
//   We tilt `market` by a few MODEST factors (need, owner tendency, cash on
//     hand, forced-fill) to get this team's willingness-to-pay. The English
//     auction in runBiddingRound then clears near the 2nd-highest WTP.
// Market heat — a global willingness multiplier simulating a hot vs cold room.
// 1.0 = normal; >1 everyone reaches a bit higher (early stars clear hot, late
// players go cheap — budget stays conserved); <1 = a bargain room. Applies to
// both interactive and auto sims.
let MOCK_MARKET_HEAT = 1.0;
function setMockMarketHeat(f) { MOCK_MARKET_HEAT = (typeof f === "number" && isFinite(f) && f > 0) ? f : 1.0; }
function getMockMarketHeat() { return MOCK_MARKET_HEAT; }

// Baseline price level — a gentle global trim so winning bids sit a touch under
// par on average. Lower = teams are more frugal (some budget left unspent).
let MOCK_PRICE_LEVEL = 0.92;
function setMockPriceLevel(f) { MOCK_PRICE_LEVEL = (typeof f === "number" && isFinite(f) && f > 0) ? f : 1.0; }
function getMockPriceLevel() { return MOCK_PRICE_LEVEL; }

function computeMaxBid(state, p, inflation) {
  if (state.slotsRemaining <= 0) return 0;
  const market = inflatedValue(p, inflation);
  if (!isFinite(market) || market <= 0) return 0;

  // Hard safety: reserve $1 per remaining future slot.
  const safetyCap = state.budget - Math.max(0, state.slotsRemaining - 1) - (state.profile.safetyMargin || 0);
  if (safetyCap <= 0) return 0;

  const profile = state.profile;
  const elig = p.elig && p.elig.length ? p.elig : [p.posKey];
  const need = positionNeedFor(state, elig);
  if (need <= 0) return 0;   // no slot to roster this player

  // Need: pay full market for a real open need; discount flex/bench-only fits so
  // teams don't overpay to stash players they can't start.
  const needMult = need >= 0.85 ? 1.00 : need >= 0.65 ? 0.93 : need >= 0.5 ? 0.84 : 0.70;

  // Owner tendency tilt (MODEST). Stars+scrubs pay a little over for studs and
  // under for filler; spread does the opposite. Tier by market price.
  const tier = market >= 30 ? "T1" : market >= 18 ? "T2" : market >= 8 ? "T3" : market >= 4 ? "T4" : "T5";
  const tta = profile.topTierAppetite || 1;
  let profMult = profile.aggression || 1;
  if (tta >= 1.2) {
    if (tier === "T1") profMult *= 1.10; else if (tier === "T2") profMult *= 1.05;
    else if (tier === "T4") profMult *= 0.90; else if (tier === "T5") profMult *= 0.82;
  } else if (tta < 0.95) {
    if (tier === "T1") profMult *= 0.90; else if (tier === "T3" || tier === "T4") profMult *= 1.05;
  }
  const posMult = (profile.posBias && profile.posBias[p.posKey]) || 1;
  const targetMult = (profile.targets && profile.targets[p.name]) || 1;

  // Use-it-or-lose-it: a team with above-norm $/slot pays a bit over market to
  // deploy cash; a tight team pulls back. Modest — real owners spend ~97% of
  // budget across MANY picks, not by massively overpaying one.
  const dps = state.budget / Math.max(1, state.slotsRemaining);
  let cashMult = 1;
  if (dps > 15) cashMult = 1.14; else if (dps > 11) cashMult = 1.07;
  else if (dps < 6) cashMult = 0.90; else if (dps < 8) cashMult = 0.96;
  // ENDGAME scramble: a cash-rich team with few slots left MUST deploy money or
  // strand it — so it pays well above market for the last good players (real
  // owners would rather overpay than leave $20 unspent). This is what stops
  // stars from "falling" to a hoarder for $1 late, and lets a team get squeezed.
  if (state.slotsRemaining <= 6 && dps > 16) cashMult = Math.max(cashMult, 1.45);
  else if (state.slotsRemaining <= 8 && dps > 12) cashMult = Math.max(cashMult, 1.22);

  // Forced-fill: pay up for the last open REQUIRED slot late (gated to low slack).
  const fill = mustFillBoost(state, elig);

  const noise = 1 + (Math.random() - 0.5) * 2 * (profile.noise || 0.07);

  let wtp = market * needMult * profMult * posMult * targetMult * cashMult * fill * noise * MOCK_MARKET_HEAT * MOCK_PRICE_LEVEL;
  // Cap a single buy so it can't dump the whole wad early; loosen the cap in the
  // endgame so cash-rich teams can actually deploy money on the last good players.
  const overCap = state.slotsRemaining <= 6 ? 2.4 : state.slotsRemaining <= 10 ? 1.9 : 1.6;
  wtp = Math.min(wtp, market * overCap);
  return Math.max(0, Math.floor(Math.min(wtp, safetyCap)));
}

function _weightedPick(weights) {
  const entries = Object.entries(weights || {});
  const sum = entries.reduce((s, [, w]) => s + (w > 0 ? w : 0), 0);
  if (sum <= 0) return entries.length ? entries[0][0] : null;
  let r = Math.random() * sum;
  for (const [k, w] of entries) { r -= (w > 0 ? w : 0); if (r <= 0) return k; }
  return entries[entries.length - 1][0];
}

// Nomination logic — strategy chosen from each owner's nomMix, and reactive to
// positional scarcity so realistic RUNS emerge (a hot position keeps getting
// nominated → drafted → scarcer → hotter). Strategies:
//   target — a player at a position I need, in my tier band (grab hot ones early)
//   drain  — a big-ticket player to drain rivals' budgets (stars+scrubs love this)
//   dump   — a pricey player at a position I'm FULL on (others pay, I don't)
//   blocker— a player at a HOT (drying-up) position to force rivals to pay the premium
function chooseNomination(state, pool, inflation) {
  if (!pool.length) return null;
  const profile = state.profile;
  const tta = profile.topTierAppetite || 1;
  const dps = state.budget / Math.max(1, state.slotsRemaining);
  const scar = (inflation && inflation.posScarcity) || {};
  const isHot = p => (scar[p.posKey] || 1) >= 1.12;
  const need = p => positionNeedFor(state, p.elig || [p.posKey]);
  const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
  const pick = (arr, k) => arr.length ? rnd(arr.slice(0, Math.min(k || 6, arr.length))) : null;

  // ENDGAME (slots low + cash hot): burn budget on the biggest remaining.
  if (state.slotsRemaining <= 8 && dps > 9) {
    const splashy = pool.filter(p => p.value > 6).sort((a, b) => b.value - a.value);
    if (splashy.length) return pick(splashy, 6);
  }

  // Loyalty: lock in a repeat target early.
  if (profile.targets && state.budget > 30) {
    const mine = pool.filter(p => profile.targets[p.name] && need(p) > 0.3);
    if (mine.length && Math.random() < 0.4) return pick(mine, 3);
  }

  const sortDesc = arr => arr.sort((a, b) => b.value - a.value);
  const strat = _weightedPick(profile.nomMix || { target: 0.35, dump: 0.25, drain: 0.25, blocker: 0.15 });

  if (strat === "drain") {
    const floor = tta >= 1.2 ? 25 : 18;
    const big = sortDesc(pool.filter(p => p.value > floor));
    if (big.length) return pick(big, 6);
  }
  if (strat === "dump") {
    const dumps = sortDesc(pool.filter(p => p.value > 15 && need(p) <= 0.45));
    if (dumps.length) return pick(dumps, 5);
  }
  if (strat === "blocker") {
    const hot = sortDesc(pool.filter(p => isHot(p) && p.value > 5));
    if (hot.length) return pick(hot, 5);
  }
  // target (default): prefer a HOT position I need (grab before the run).
  const hotNeed = sortDesc(pool.filter(p => need(p) > 0.5 && isHot(p)));
  if (hotNeed.length && Math.random() < 0.55) return pick(hotNeed, 5);
  const tierFloor = tta >= 1.2 ? 22 : tta < 0.95 ? 8 : 14;
  const targets = pool.filter(p => need(p) > 0.4 && p.value >= tierFloor);
  if (targets.length) return pick(targets, 8);
  const anyNeed = pool.filter(p => need(p) > 0.4 && p.value > 3);
  if (anyNeed.length) return pick(anyNeed, 8);
  return pick(pool.filter(p => p.value > 1), 10) || pool[0];
}

// Simulate the bidding war for one nomination. Returns {winner: teamState, price}.
// Bid increments scale with current price — real auctions jump $3-5 at high
// dollar levels, not $1.
function runBiddingRound(states, player, nominatorId, opening, inflation) {
  let currentBid = Math.max(1, Math.floor(opening || 1));
  let currentWinner = states[nominatorId];
  let activeIds = Object.keys(states).filter(id => states[id].slotsRemaining > 0 && states[id].budget > currentBid);
  let rounds = 0;
  while (activeIds.length && rounds < 80) {
    rounds++;
    let anyBumped = false;
    // Shuffle each round so no team is structurally first-to-bid (the headless
    // engine previously iterated in fixed object-key order).
    shuffleInPlace(activeIds);
    for (const id of activeIds) {
      if (id === currentWinner.teamId) continue;
      const s = states[id];
      const max = computeMaxBid(s, player, inflation);
      if (max > currentBid) {
        // Real-world auction increments
        const increment = currentBid < 5 ? 1 : currentBid < 12 ? 1 : currentBid < 25 ? 2 : currentBid < 40 ? 3 : 4;
        const newBid = Math.min(max, currentBid + increment);
        if (newBid > currentBid) {
          currentBid = Math.floor(newBid);
          currentWinner = s;
          anyBumped = true;
        }
      }
    }
    if (!anyBumped) break;
    activeIds = activeIds.filter(id => states[id].budget > currentBid);
  }
  // (No artificial solo-buyer markup — an uncontested player clears cheap, which
  // is realistic. Budget gets spent via the cash-on-hand tilt + inflation, which
  // raise prices as teams accumulate unspent money over the draft.)
  if (currentWinner.budget < currentBid) {
    currentBid = Math.max(1, currentWinner.budget);
  }
  return { winner: currentWinner, price: Math.max(1, currentBid) };
}

// Recompute inflation given current draft state (kept + already drafted are out).
function inflationForMockState(states) {
  const draftedNames = new Set();
  let spent = 0;
  for (const s of Object.values(states)) {
    for (const d of s.drafted) { draftedNames.add(_mockNk(d.name)); spent += d.price; }
  }
  const keptNames = _mockKeptSet();
  const values = getValues();
  const totalBudget = (LEAGUE.draftBudget * LEAGUE.numTeams)
    + (typeof getDraftDollarAdjustment === "function" ? LEAGUE.teams.reduce((s, t) => s + getDraftDollarAdjustment(t.id), 0) : 0);
  // Use the TRUE keeper spend stored on each state (back-computing it from a
  // floored budget understated it for over-keepered teams and inflated the mult).
  const totalKeptCost = Object.values(states).reduce((s, t) => s + (t.keptCost || 0), 0);
  const remaining = Math.max(0, totalBudget - totalKeptCost - spent);

  // Only the players who will actually be rostered carry the remaining money —
  // i.e. the top (open-slots) remaining by value. Counting the long $1 tail
  // would dilute the multiplier and make the AI chronically underbid.
  const openSlots = Object.values(states).reduce((n, s) => n + Math.max(0, s.slotsRemaining), 0);
  const avail = values
    .filter(p => p.value > 0 && !keptNames.has(_mockNk(p.name)) && !draftedNames.has(_mockNk(p.name)))
    .sort((a, b) => b.value - a.value);
  const rosterable = avail.slice(0, Math.max(1, openSlots));
  const remainingValue = rosterable.reduce((s, p) => s + p.value, 0);

  let mult = remainingValue > 0 ? remaining / remainingValue : 1;
  if (!isFinite(mult) || mult < 0) mult = 1;
  // Clamp to a sane range so noise doesn't explode at end-of-draft
  mult = Math.max(0.3, Math.min(3.0, mult));

  // MILD star concentration (keeper-league realism): cheap keepers are off the
  // board, so surplus money chases the remaining elite tier harder than the $1
  // tail. Weights are NORMALIZED over the rosterable pool so the overall level
  // (total spend) is unchanged — it only REDISTRIBUTES toward stars. Tame
  // weights keep stars ~10-15% over value, not the old 1.4x overpricing.
  const W = { T1: 1.08, T2: 1.04, T3: 1.00, T4: 0.94, T5: 0.86 };
  // Use the SAME tier thresholds inflatedValue applies (tierForValue), so the
  // normalization exactly conserves total spend.
  const tierOf = (typeof tierForValue === "function") ? tierForValue
    : (v => v >= 35 ? "T1" : v >= 20 ? "T2" : v >= 10 ? "T3" : v >= 5 ? "T4" : "T5");
  let s0 = 0, s1 = 0;
  for (const p of rosterable) { s0 += p.value; s1 += p.value * W[tierOf(p.value)]; }
  const norm = s1 > 0 ? s0 / s1 : 1;   // keeps Σ(value × tierMult) == remaining
  const tierMult = {};
  for (const t of ["T1", "T2", "T3", "T4", "T5"]) tierMult[t] = mult * W[t] * norm;

  return {
    mode: "tiered",
    multiplier: mult,
    hitMultiplier: mult,
    pitMultiplier: mult,
    tierMult,
    posScarcity: computePosScarcity(states, rosterable),
  };
}

// Per-position scarcity tilt. Compares remaining league-wide demand (open hard
// slots at each position) against remaining rosterable supply at that position.
// Scarce positions tilt up, deep positions tilt down. Normalized to mean ~1 so
// it only REDISTRIBUTES money (the global multiplier still sets the level) —
// this is what produces realistic positional "runs".
function computePosScarcity(states, rosterable) {
  const HARD = ["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP"];
  const demand = {}, supply = {};
  for (const pos of HARD) { demand[pos] = 0; supply[pos] = 0; }
  for (const s of Object.values(states)) {
    for (const pos of HARD) demand[pos] += Math.max(0, s.openSlots?.[pos] || 0);
  }
  // Count supply against EVERY hard slot a player qualifies for (fractionally),
  // matching how demand is summed across flex slots — otherwise a multi-eligible
  // player (2B/SS/OF) counts as supply for one slot but demand for several,
  // overstating scarcity.
  for (const p of rosterable) {
    const hardElig = (p.elig || [p.posKey]).filter(s => supply[s] != null);
    if (!hardElig.length) { if (supply[p.posKey] != null) supply[p.posKey] += 1; continue; }
    const share = 1 / hardElig.length;
    for (const slot of hardElig) supply[slot] += share;
  }
  // Raw scarcity = demand/supply, dampened by sqrt; clamp per-position.
  const raw = {};
  let wSum = 0, wN = 0;
  for (const pos of HARD) {
    const ratio = demand[pos] / Math.max(1, supply[pos]);
    raw[pos] = Math.max(0.80, Math.min(1.35, Math.sqrt(ratio || 1)));
    // weight the normalization by supply so thin positions don't skew the mean
    wSum += raw[pos] * Math.max(1, supply[pos]);
    wN += Math.max(1, supply[pos]);
  }
  const mean = wN > 0 ? wSum / wN : 1;
  const out = {};
  for (const pos of HARD) out[pos] = mean > 0 ? raw[pos] / mean : 1;
  return out;
}

// Runs the full simulation. Returns { picks, finalStates }.
function runMockDraft(opts) {
  opts = opts || {};
  const states = buildMockTeamStates(opts);
  const keptNames = _mockKeptSet();
  // Pool: positive-value, not kept players. Sort by value desc for nomination defaults.
  let pool = getValues().filter(p => p.value > 0 && !keptNames.has(_mockNk(p.name))).slice();
  pool.sort((a, b) => b.value - a.value);
  const picks = [];

  // Nomination order: shuffle teams once
  const order = Object.values(states).map(s => s.teamId);
  shuffleInPlace(order);

  let nomPointer = 0;     // stable rotation pointer through `order`
  let safety = 0;
  while (pool.length && safety < 400) {
    safety++;
    // Advance to the next team (in fixed order) that still has open slots.
    let nominatorId = null;
    for (let i = 0; i < order.length; i++) {
      const cand = order[(nomPointer + i) % order.length];
      if (states[cand].slotsRemaining > 0) { nominatorId = cand; nomPointer = (nomPointer + i + 1) % order.length; break; }
    }
    if (!nominatorId) break;

    const inflation = inflationForMockState(states);
    const nominee = chooseNomination(states[nominatorId], pool, inflation);
    if (!nominee) break;

    // Open at $1 like a real auction: the nominator is only the provisional
    // winner at the floor, so a "drain" nomination of a player they don't want
    // doesn't stick them with it — contenders bid it up to fair value, and an
    // uncontested nomination is won cheap (also realistic).
    const { winner, price: rawPrice } = runBiddingRound(states, nominee, nominatorId, 1, inflation);

    // Hard guard: actual price can never exceed winner's available budget.
    // Reserve $1 per future remaining slot.
    const winnerReserve = Math.max(0, winner.slotsRemaining - 1);
    const winnerMaxPrice = Math.max(1, winner.budget - winnerReserve);
    const price = Math.min(rawPrice, winnerMaxPrice);

    // If the winner has no slot for this player (only happens for an
    // uncontested $1 nomination of an unrosterable player), let them go
    // undrafted rather than corrupt the winner's roster accounting.
    const filledSlot = assignToSlot(winner.openSlots, nominee.elig || [nominee.posKey]);
    if (!filledSlot) { pool = pool.filter(p => p.name !== nominee.name); continue; }

    winner.budget = Math.max(0, winner.budget - price);
    winner.drafted.push({ name: nominee.name, pos: nominee.posKey, slot: filledSlot, price, value: nominee.value, type: nominee.type });
    winner.slotsByPos[filledSlot || nominee.posKey] = (winner.slotsByPos[filledSlot || nominee.posKey] || 0) + 1;
    winner.slotsRemaining -= 1;

    picks.push({
      idx: picks.length + 1,
      player: nominee.name,
      pos: nominee.posKey,
      type: nominee.type,
      baseValue: nominee.value,
      inflatedValue: inflatedValue(nominee, inflation),
      price,
      surplus: nominee.value - price,
      winnerTeamId: winner.teamId,
      winnerOwner: winner.ownerName,
      nominatorTeamId: nominatorId,
    });

    // Remove from pool
    pool = pool.filter(p => p.name !== nominee.name);
  }

  return { picks, states };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Monte Carlo — run N simulations and aggregate per-player price distribution.
function runMockDraftMonteCarlo(n, opts) {
  n = n || 25;
  const playerStats = {};  // name -> { prices: [], teams: {} }
  for (let i = 0; i < n; i++) {
    const { picks } = runMockDraft(opts);
    for (const p of picks) {
      if (!playerStats[p.player]) playerStats[p.player] = { prices: [], teams: {}, value: p.baseValue, pos: p.pos };
      playerStats[p.player].prices.push(p.price);
      playerStats[p.player].teams[p.winnerOwner] = (playerStats[p.player].teams[p.winnerOwner] || 0) + 1;
    }
  }
  // Aggregate
  const out = [];
  for (const [name, s] of Object.entries(playerStats)) {
    s.prices.sort((a, b) => a - b);
    const mean = s.prices.reduce((a, b) => a + b, 0) / s.prices.length;
    // Linear-interpolated percentile (the old floor() indexing skewed bands,
    // and for tiny samples reported the max as the "median").
    const pct = (arr, q) => {
      if (!arr.length) return 0;
      const idx = (arr.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
      return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
    };
    const median = Math.round(pct(s.prices, 0.5));
    const p10 = Math.round(pct(s.prices, 0.1));
    const p90 = Math.round(pct(s.prices, 0.9));
    const topTeam = Object.entries(s.teams).sort((a, b) => b[1] - a[1])[0];
    out.push({
      name, pos: s.pos, value: s.value,
      n: s.prices.length, mean, median, p10, p90,
      topTeam: topTeam[0], topTeamShare: topTeam[1] / s.prices.length,
    });
  }
  out.sort((a, b) => b.mean - a.mean);
  return out;
}

// --- Backtest / calibration harness -------------------------------------
// Runs the sim N times and scores each owner's SIMULATED behavior against the
// behavioral profile derived from their real draft history. This is how we tell
// whether profiles actually shape the AI — and gives a target to tune against.
// Metrics per owner:
//   top3Share      — share of spend on their 3 priciest buys (stars vs spread)
//   bigBidsPerYear — count of buys ≥ $25
//   avgMaxBid      — their single biggest buy
//   posSpendPct    — share of spend by position
function _ownerMetricsFromPicks(picks) {
  const byOwner = {};
  for (const p of picks) {
    const o = p.winnerOwner;
    if (!byOwner[o]) byOwner[o] = { spend: 0, buys: [], posSpend: {} };
    byOwner[o].spend += p.price;
    byOwner[o].buys.push(p.price);
    byOwner[o].posSpend[p.pos] = (byOwner[o].posSpend[p.pos] || 0) + p.price;
  }
  const out = {};
  for (const [o, d] of Object.entries(byOwner)) {
    const sorted = d.buys.slice().sort((a, b) => b - a);
    const top3 = sorted.slice(0, 3).reduce((s, x) => s + x, 0);
    const posSpendPct = {};
    for (const [pos, amt] of Object.entries(d.posSpend)) posSpendPct[pos] = d.spend > 0 ? amt / d.spend : 0;
    out[o] = {
      top3Share: d.spend > 0 ? top3 / d.spend : 0,
      bigBids: sorted.filter(x => x >= 25).length,
      maxBid: sorted[0] || 0,
      posSpendPct,
    };
  }
  return out;
}

function runMockBacktest(n, opts) {
  n = n || 40;
  if (typeof computeAllOwnerProfiles !== "function") return { error: "History module unavailable." };
  const hist = computeAllOwnerProfiles();
  if (!hist || !Object.keys(hist).length) return { error: "No draft history imported — sync from ESPN on the History tab first." };

  // Accumulate simulated metrics per owner across N drafts.
  const acc = {};
  for (let i = 0; i < n; i++) {
    const { picks } = runMockDraft(opts || {});
    const m = _ownerMetricsFromPicks(picks);
    for (const [o, mm] of Object.entries(m)) {
      if (!acc[o]) acc[o] = { top3Share: [], bigBids: [], maxBid: [], posSpendPct: {} };
      acc[o].top3Share.push(mm.top3Share);
      acc[o].bigBids.push(mm.bigBids);
      acc[o].maxBid.push(mm.maxBid);
      for (const [pos, pct] of Object.entries(mm.posSpendPct)) {
        (acc[o].posSpendPct[pos] = acc[o].posSpendPct[pos] || []).push(pct);
      }
    }
  }
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

  const rows = [];
  const errs = { top3Share: [], bigBids: [], maxBid: [] };
  for (const [owner, h] of Object.entries(hist)) {
    const s = acc[owner];
    if (!s) continue;
    const simTop3 = avg(s.top3Share), simBig = avg(s.bigBids), simMax = avg(s.maxBid);
    if (h.top3Share != null) errs.top3Share.push(Math.abs(simTop3 - h.top3Share));
    if (h.bigBidsPerYear != null) errs.bigBids.push(Math.abs(simBig - h.bigBidsPerYear));
    if (h.avgMaxBidPerYear != null) errs.maxBid.push(Math.abs(simMax - h.avgMaxBidPerYear));
    rows.push({
      owner,
      sim: { top3Share: simTop3, bigBids: simBig, maxBid: simMax },
      hist: { top3Share: h.top3Share, bigBids: h.bigBidsPerYear, maxBid: h.avgMaxBidPerYear },
    });
  }
  rows.sort((a, b) => (b.hist.top3Share || 0) - (a.hist.top3Share || 0));
  const mae = {
    top3Share: avg(errs.top3Share),
    bigBids: avg(errs.bigBids),
    maxBid: avg(errs.maxBid),
  };
  return { n, rows, mae };
}
