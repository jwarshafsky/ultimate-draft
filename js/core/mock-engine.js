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
        kept.push({ name, price, pos: getPlayerValue(name)?.posKey || "UTIL" });
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
    states[t.id] = {
      teamId: t.id,
      teamName: t.name,
      ownerName: t.owner,
      isMe: !!t.isMe,
      profile,
      budget: LEAGUE.draftBudget - keptCost,
      kept,
      drafted: [],
      slotsByPos: countSlotsByPos(kept),
      slotsRemaining: LEAGUE.rosterSize - kept.length,
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

// Roster slot targets per team (matching constitution). Used to decide whether
// a team still has appetite for a position. UTIL/BENCH absorb overflow.
const POS_TARGETS = { C: 1, "1B": 1, "2B": 1, "SS": 1, "3B": 1, MI: 1, CI: 1, OF: 5, UTIL: 1, SP: 6, RP: 3 };

// Returns the "need score" for this position on this team. Higher = wants more.
function positionNeed(state, posKey) {
  const have = state.slotsByPos[posKey] || 0;
  const target = POS_TARGETS[posKey] || 1;
  // Special handling: 1B/3B can fill CI, 2B/SS can fill MI, any hitter fills UTIL,
  // any pitcher fills overflow P slots, anyone fills bench.
  if (have >= target) {
    // Past primary slot — still some need for flex/bench but lower.
    return Math.max(0, 0.5 - (have - target) * 0.2);
  }
  return 1.0 - have / target;
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
  const need = positionNeed(state, p.posKey);
  const dollarsPerSlot = state.budget / Math.max(1, state.slotsRemaining);

  // Endgame force-spend: when budget overhangs slots, bid full cap.
  if (state.slotsRemaining <= 4 && dollarsPerSlot >= 5) return safetyCap;
  if (dollarsPerSlot >= 13) return safetyCap;

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

  // Need factor: full position → 40% of bid; partial → 75%; full need → 100%.
  let needFactor;
  if (need <= 0) needFactor = 0.40;
  else if (need < 0.3) needFactor = 0.75;
  else if (need < 0.6) needFactor = 0.92;
  else needFactor = 1.00;

  // Auction natural inflation — even neutral bidders pay slightly above raw value.
  const auctionInflation = 1.03;

  // Random per-pick noise (5-15% swing)
  const noise = 1 + (Math.random() - 0.5) * profile.noise * 2;

  let perceived = baseValue * tierAgg * posMult * needFactor * auctionInflation * noise;

  // Moderate $/slot pressure for mid-range
  if (dollarsPerSlot > 11) perceived *= 1.08;
  else if (dollarsPerSlot < 4) perceived *= 0.80;

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
    const targets = pool.filter(p => p.value >= targetTier && positionNeed(state, p.posKey) > 0.4);
    if (targets.length) return targets[Math.floor(Math.random() * Math.min(8, targets.length))];
  }

  // MID: position-need targets, with some random dumps
  if (Math.random() < 0.6) {
    const need = pool.filter(p => positionNeed(state, p.posKey) > 0.4 && p.value > 5);
    if (need.length) return need[Math.floor(Math.random() * Math.min(8, need.length))];
  }
  // Dump: nominate a buzzy player at a position I'm full on
  const dumpCandidates = pool.filter(p => p.value > 20 && positionNeed(state, p.posKey) <= 0.2);
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
  let remainingValue = 0;
  for (const p of values) {
    if (p.value <= 0) continue;
    if (keptNames.has(p.name) || draftedNames.has(p.name)) continue;
    remainingValue += p.value;
  }
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
  };
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

  let pickIdx = 0;
  let safety = 0;
  while (pool.length && safety < 400) {
    safety++;
    // Skip teams with no slots
    const activeOrder = order.filter(id => states[id].slotsRemaining > 0);
    if (!activeOrder.length) break;
    const nominatorId = activeOrder[pickIdx % activeOrder.length];

    const inflation = inflationForMockState(states);
    const nominee = chooseNomination(states[nominatorId], pool, inflation);
    if (!nominee) break;
    const opening = Math.max(1, Math.round(nominee.value * 0.4));

    // Higher opening (50% of value) so the auction starts closer to fair —
    // prevents nominators from winning cheap when no one else competes.
    const opening2 = Math.max(1, Math.round(nominee.value * 0.5));
    const { winner, price } = runBiddingRound(states, nominee, nominatorId, opening2, inflation);
    // Apply pick
    winner.budget -= price;
    winner.drafted.push({ name: nominee.name, pos: nominee.posKey, price, value: nominee.value, type: nominee.type });
    winner.slotsByPos[nominee.posKey] = (winner.slotsByPos[nominee.posKey] || 0) + 1;
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
    pickIdx++;
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
