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
  const selections = getKeeperSelections();
  // Pre-compute history-derived profiles if available
  const historyProfiles = (typeof computeAllOwnerProfiles === "function") ? computeAllOwnerProfiles() : {};
  for (const t of LEAGUE.teams) {
    const teamSel = selections[t.id] || {};
    const kept = [];
    let keptCost = 0;
    for (const [name, flags] of Object.entries(teamSel)) {
      if (flags.minorKeeper) continue;
      if (flags.keeper) {
        const price = getCurrentKeeperSalary(name) ?? 0;
        const pv = getPlayerValue(name);
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

// What's the most this team would bid for player p in the current state?
// Returns an integer (auction prices are whole dollars).
//
// Real-world calibration:
//   - Owners spend 95-99% of budgets every year. Force-spend at high $/slot.
//   - Stars-and-scrubs drafters pay 10-20% over value for T1/T2; underpay T4/T5.
//   - Spread drafters underpay T1, bid AT value for T3/T4.
//   - Position need scales bid 0.4 (full position) → 1.0 (unfilled).
//   - Owner-specific position biases (history-derived) tilt bids by position.
//   - Auction natural inflation: even average bidders pay 3-5% over baseline.
function computeMaxBid(state, p, inflation) {
  if (state.slotsRemaining <= 0) return 0;
  const baseValue = inflatedValue(p, inflation);
  if (!isFinite(baseValue)) return 0;

  // Hard safety: reserve $1 per future slot.
  const safetyCap = state.budget - Math.max(0, state.slotsRemaining - 1) - state.profile.safetyMargin;
  if (safetyCap <= 0) return 0;

  const profile = state.profile;
  const elig = p.elig && p.elig.length ? p.elig : [p.posKey];
  const need = positionNeedFor(state, elig);
  const dollarsPerSlot = state.budget / Math.max(1, state.slotsRemaining);

  // Tier classification
  const tier = baseValue >= 35 ? "T1" : baseValue >= 20 ? "T2" : baseValue >= 10 ? "T3" : baseValue >= 5 ? "T4" : "T5";

  // Tendency-driven tier aggression.
  // Stars+scrubs profile (topTierAppetite >= 1.2) hits T1/T2 hard, saves on T4/T5.
  // Spread profile (topTierAppetite < 1.0) underpays T1, pays at value for mid tiers.
  let tierAgg = profile.aggression;
  const tta = profile.topTierAppetite || 1;
  if (tta >= 1.25) {
    if (tier === "T1") tierAgg *= 1.18;
    else if (tier === "T2") tierAgg *= 1.10;
    else if (tier === "T4") tierAgg *= 0.85;
    else if (tier === "T5") tierAgg *= 0.7;
  } else if (tta < 1.05) {
    if (tier === "T1") tierAgg *= 0.90;
    else if (tier === "T3") tierAgg *= 1.05;
    else if (tier === "T4") tierAgg *= 1.08;
  }

  // Position bias from history (e.g., closer hoarder, SP-heavy)
  const posMult = profile.posBias[p.posKey] || 1;

  // Need factor scaled to the slot-weight range (0.3 bench … 1.0 catcher).
  // need === 0 means the player fits NO open slot (not even bench) — don't bid,
  // so a team can never buy a player it can't actually roster.
  let needFactor;
  if (need <= 0) return 0;
  else if (need <= 0.35) needFactor = 0.55;   // bench-only fit
  else if (need < 0.65) needFactor = 0.82;    // flex (MI/CI/UTIL)
  else if (need < 0.85) needFactor = 0.95;    // OF / RP open
  else needFactor = 1.00;                      // dedicated infield/C/SP open

  // Forced-fill pressure: pay up to avoid an unfillable required slot.
  const fillBoost = mustFillBoost(state, elig);

  // Auction natural inflation — even neutral bidders pay slightly above raw value.
  const auctionInflation = 1.03;

  // Random per-pick noise (5-15% swing)
  const noise = 1 + (Math.random() - 0.5) * profile.noise * 2;

  // Owner loyalty: pay a premium for "their guys" (repeat draft targets).
  const targetMult = (profile.targets && profile.targets[p.name]) || 1;

  let perceived = baseValue * tierAgg * posMult * needFactor * fillBoost * targetMult * auctionInflation * noise;

  // Graduated $/slot pressure: teams sitting on excess cash bid above value to
  // avoid stranding money (owners spend 95-99% of budget every year), teams
  // that are tight pull back. Scales with how hot their $/slot is.
  let dpsPressure = 1;
  if (dollarsPerSlot > 18) dpsPressure = 1.42;
  else if (dollarsPerSlot > 13) dpsPressure = 1.28;
  else if (dollarsPerSlot > 9) dpsPressure = 1.12;
  else if (dollarsPerSlot < 4) dpsPressure = 0.82;
  perceived *= dpsPressure;

  // Spread, don't dump: in the endgame, cap a single buy so a cash-rich team
  // can't sink its whole wad into one player — real owners spread leftover
  // money across several. (Doesn't bind early, where value/safetyCap govern.)
  if (state.slotsRemaining <= 8) {
    const spreadCap = Math.floor(dollarsPerSlot * (state.slotsRemaining <= 3 ? 4 : 2.6)) + 6;
    perceived = Math.min(perceived, Math.max(baseValue * 1.3, spreadCap));
  }

  return Math.max(0, Math.floor(Math.min(perceived, safetyCap)));
}

// Nomination logic — tendency-driven. Stars+scrubs owners drop big names
// early to drain opponents. Spread owners nominate mid-tier value plays.
// Endgame: everyone nominates pricier players to burn budgets.
function chooseNomination(state, pool, inflation) {
  if (!pool.length) return null;
  const profile = state.profile;
  const tta = profile.topTierAppetite || 1;
  const dollarsPerSlot = state.budget / Math.max(1, state.slotsRemaining);

  // Loyalty: with budget to spend, owners often nominate a repeat target early
  // to lock in "their guy".
  if (profile.targets && state.budget > 30) {
    const mine = pool.filter(p => profile.targets[p.name] && positionNeedFor(state, p.elig || [p.posKey]) > 0.3);
    if (mine.length && Math.random() < 0.45) return mine[Math.floor(Math.random() * Math.min(3, mine.length))];
  }

  // ENDGAME (slots low + budget hot): nominate biggest remaining to burn cash
  if (state.slotsRemaining <= 8 && dollarsPerSlot > 9) {
    const splashy = pool.filter(p => p.value > 6);
    if (splashy.length) return splashy[Math.floor(Math.random() * Math.min(6, splashy.length))];
  }

  // EARLY (lots of budget): stars+scrubs hammers T1/T2 to drain or grab.
  // Spread drafters nominate mid-tier they actually want.
  if (state.budget > 180) {
    if (tta >= 1.2) {
      const big = pool.filter(p => p.value > 28);
      if (big.length && Math.random() < 0.5) return big[Math.floor(Math.random() * Math.min(5, big.length))];
    }
    // Standard target: a player in a position I need, in my tier preference
    const targetTier = tta >= 1.2 ? 25 : tta < 1.05 ? 10 : 15;
    const targets = pool.filter(p => p.value >= targetTier && positionNeedFor(state, p.elig || [p.posKey]) > 0.4);
    if (targets.length) return targets[Math.floor(Math.random() * Math.min(8, targets.length))];
  }

  // MID: position-need targets, with some random dumps
  if (Math.random() < 0.6) {
    const need = pool.filter(p => positionNeedFor(state, p.elig || [p.posKey]) > 0.4 && p.value > 5);
    if (need.length) return need[Math.floor(Math.random() * Math.min(8, need.length))];
  }
  // Dump: nominate a buzzy player at a position I'm full on
  const dumpCandidates = pool.filter(p => p.value > 20 && positionNeedFor(state, p.elig || [p.posKey]) <= 0.45);
  if (dumpCandidates.length) return dumpCandidates[Math.floor(Math.random() * Math.min(4, dumpCandidates.length))];

  // Default: cheap value play
  const cheap = pool.filter(p => p.value > 1 && p.value < 10);
  if (cheap.length) return cheap[Math.floor(Math.random() * cheap.length)];
  return pool[0];
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
  // Solo-buyer correction: if the winner has WAY more $/slot than league
  // norm and nobody else challenged them seriously, real owners would have
  // paid more to avoid stockpiling cash they can't use. Push the final price
  // toward what equalizes their $/slot pace.
  const winnerSlots = currentWinner.slotsRemaining;
  const winnerDPerS = currentWinner.budget / Math.max(1, winnerSlots);
  const targetDPerS = 10;  // league norm
  if (winnerDPerS > targetDPerS * 1.4 && winnerSlots <= 12 && winnerSlots > 0) {
    // What price would bring this winner closer to league $/slot pace?
    const targetSpendThisPick = Math.max(currentBid, Math.floor(currentWinner.budget - (winnerSlots - 1) * targetDPerS));
    const maxAllowed = computeMaxBid(currentWinner, player, inflation);
    const newPrice = Math.min(targetSpendThisPick, maxAllowed);
    if (newPrice > currentBid) currentBid = newPrice;
  }

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
    for (const d of s.drafted) { draftedNames.add(d.name); spent += d.price; }
  }
  const keptNames = new Set(collectKeepers().map(k => k.name));
  const values = getValues();
  const totalBudget = LEAGUE.draftBudget * LEAGUE.numTeams;
  const totalKeptCost = Object.values(states).reduce((s, t) => s + (LEAGUE.draftBudget - t.budget - t.drafted.reduce((x, d) => x + d.price, 0)), 0);
  const remaining = Math.max(0, totalBudget - totalKeptCost - spent);

  // Only the players who will actually be rostered carry the remaining money —
  // i.e. the top (open-slots) remaining by value. Counting the long $1 tail
  // would dilute the multiplier and make the AI chronically underbid.
  const openSlots = Object.values(states).reduce((n, s) => n + Math.max(0, s.slotsRemaining), 0);
  const avail = values
    .filter(p => p.value > 0 && !keptNames.has(p.name) && !draftedNames.has(p.name))
    .sort((a, b) => b.value - a.value);
  const rosterable = avail.slice(0, Math.max(1, openSlots));
  const remainingValue = rosterable.reduce((s, p) => s + p.value, 0);

  let mult = remainingValue > 0 ? remaining / remainingValue : 1;
  if (!isFinite(mult) || mult < 0) mult = 1;
  // Clamp to a sane range so noise doesn't explode at end-of-draft
  mult = Math.max(0.3, Math.min(3.0, mult));

  return {
    mode: "tiered",
    multiplier: mult,
    hitMultiplier: mult,
    pitMultiplier: mult,
    tierMult: { T1: mult * 1.15, T2: mult * 1.08, T3: mult, T4: mult * 0.9, T5: mult * 0.7 },
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
  for (const p of rosterable) {
    if (supply[p.posKey] != null) supply[p.posKey] += 1;
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
  const keptNames = new Set(collectKeepers().map(k => k.name));
  // Pool: positive-value, not kept players. Sort by value desc for nomination defaults.
  let pool = getValues().filter(p => p.value > 0 && !keptNames.has(p.name)).slice();
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
    const median = s.prices[Math.floor(s.prices.length / 2)];
    const p10 = s.prices[Math.floor(s.prices.length * 0.1)];
    const p90 = s.prices[Math.floor(s.prices.length * 0.9)];
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
