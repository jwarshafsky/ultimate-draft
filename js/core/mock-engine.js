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
function computeMaxBid(state, p, inflation) {
  if (state.slotsRemaining <= 0) return 0;
  const baseValue = inflatedValue(p, inflation);
  if (!isFinite(baseValue)) return 0;
  const posMult = state.profile.posBias[p.posKey] || 1;
  const noise = 1 + (Math.random() - 0.5) * state.profile.noise * 2;
  let perceived = baseValue * state.profile.aggression * posMult * noise;

  // Need adjustment — discount if they don't really need this pos.
  // When slots are tight, NEED any roster spot more (drives aggressive end-draft bidding).
  const need = positionNeed(state, p.posKey);
  const slotPressure = state.slotsRemaining <= 4 ? 1 : (state.slotsRemaining <= 8 ? 0.85 : 0.7);
  perceived *= (0.4 + 0.6 * need) * slotPressure;

  // Hard safety: budget - (slotsRemaining - 1). Always keep at least $1 per
  // remaining future slot.
  const safetyCap = state.budget - Math.max(0, state.slotsRemaining - 1) - state.profile.safetyMargin;

  return Math.max(0, Math.floor(Math.min(perceived, safetyCap)));
}

// Nomination logic — pick a player to nominate based on the owner's strategy
// mix. For now, simple weighted draws.
function chooseNomination(state, pool, inflation) {
  if (!pool.length) return null;
  const mix = state.profile.nomMix;
  const r = Math.random();
  let cum = 0;
  let kind = "target";
  for (const [k, v] of Object.entries(mix)) {
    cum += v;
    if (r < cum) { kind = k; break; }
  }

  // Target: nominate someone valuable they actually want
  if (kind === "target") {
    // Find a player above $10 in a position this team needs
    const candidates = pool.filter(p => p.value > 10 && positionNeed(state, p.posKey) > 0.4);
    if (candidates.length) return candidates[Math.floor(Math.random() * Math.min(8, candidates.length))];
  }
  // Dump: nominate a buzzy player they don't want, hope to drain budgets
  if (kind === "dump") {
    const candidates = pool.filter(p => p.value > 25 && positionNeed(state, p.posKey) < 0.5);
    if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
  }
  // Drain: nominate at scarce positions opponents still need
  if (kind === "drain") {
    const scarce = pool.filter(p => ["C", "SS", "RP"].includes(p.posKey) && p.value > 5);
    if (scarce.length) return scarce[Math.floor(Math.random() * scarce.length)];
  }
  // Blocker: low-cost endgame
  const cheap = pool.filter(p => p.value > 1 && p.value < 8);
  if (cheap.length) return cheap[Math.floor(Math.random() * cheap.length)];

  // Fallback: top of pool
  return pool[0];
}

// Simulate the bidding war for one nomination. Returns {winner: teamState, price}.
function runBiddingRound(states, player, nominatorId, opening, inflation) {
  let currentBid = Math.max(1, Math.floor(opening || 1));
  let currentWinner = states[nominatorId];
  let activeIds = Object.keys(states).filter(id => states[id].slotsRemaining > 0 && states[id].budget > currentBid);
  let rounds = 0;
  while (activeIds.length && rounds < 50) {
    rounds++;
    let anyBumped = false;
    for (const id of activeIds) {
      if (id === currentWinner.teamId) continue;
      const s = states[id];
      const max = computeMaxBid(s, player, inflation);
      if (max > currentBid) {
        const increment = currentBid < 10 ? 1 : currentBid < 30 ? 2 : 3;
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
  // Ensure winner can afford it (their max calc factored slotsRemaining, but
  // the nominator was forced in at the opening price — guard against that).
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

    const { winner, price } = runBiddingRound(states, nominee, nominatorId, opening, inflation);
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
