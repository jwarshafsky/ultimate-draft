// Inflation engine. Two modes:
//   1. Flat — simple (remaining $) / (remaining value), one multiplier.
//   2. Tiered — stars absorb more inflation than mid/bottom tier players.
//      Floor of $1 still applies; bottom-tier flat-line ratio approaches 1.0.
//
// Input: a value list (from valuation.js) plus keepers (with cost). Output:
//   { multiplier, hitMultiplier, pitMultiplier, perPlayer: {name -> infl$} }

// Keeper source for inflation/budget math. Uses Jeff's PREDICTED keepers
// (treated as the actual keepers); see getEffectiveKeeperSelections. Falls back
// to the raw league-site marks if that helper isn't loaded.
function _inflationKeeperSelections() {
  return (typeof getEffectiveKeeperSelections === "function")
    ? getEffectiveKeeperSelections()
    : getKeeperSelections();
}

// Returns the kept-player cost for a player (if marked keeper or minorKeeper).
// Minor leaguers keep at $0; ML keepers keep at their salary (from ESPN
// current-year keeper pick price, or manual override).
function getKeptCost(playerName, teamId) {
  const sel = (_inflationKeeperSelections()[teamId] || {})[playerName];
  if (!sel) return null;
  if (sel.minorKeeper) return { cost: 0, kind: "minor" };
  if (sel.keeper) {
    const price = (typeof getCurrentKeeperSalary === "function") ? getCurrentKeeperSalary(playerName) : null;
    return { cost: typeof price === "number" ? price : 0, kind: "major" };
  }
  return null;
}

// Collects every kept player across the league with their cost/team. ML
// salaries come from the current-year ESPN keeper pick price (or override).
function collectKeepers() {
  const out = [];
  const selections = _inflationKeeperSelections();
  for (const [teamId, players] of Object.entries(selections)) {
    for (const [name, flags] of Object.entries(players)) {
      if (flags.minorKeeper) {
        out.push({ name, teamId, cost: 0, kind: "minor" });
      } else if (flags.keeper) {
        const price = (typeof getCurrentKeeperSalary === "function") ? getCurrentKeeperSalary(name) : null;
        out.push({ name, teamId, cost: typeof price === "number" ? price : 0, kind: "major" });
      }
    }
  }
  return out;
}

// Computes per-team remaining budget after keepers. Also accounts for traded
// draft dollars (settings.draftDollarAdjustments if present).
function computeTeamBudgets() {
  const map = {};
  for (const t of LEAGUE.teams) {
    map[t.id] = { teamId: t.id, base: LEAGUE.draftBudget, keepers: 0, spent: 0, remaining: 0, keeperCount: 0, minorCount: 0 };
  }
  const keepers = collectKeepers();
  for (const k of keepers) {
    const slot = map[k.teamId];
    if (!slot) continue;
    if (k.kind === "minor") {
      slot.minorCount += 1;
    } else {
      slot.keeperCount += 1;
      slot.keepers += k.cost || 0;
    }
  }
  for (const t of Object.values(map)) {
    t.remaining = t.base - t.keepers - t.spent;
  }
  return map;
}

// Standard flat inflation. multiplier = (league $ remaining) / (player value remaining).
// "Player value remaining" treats kept players as removed from the pool —
// their projected value no longer needs to be paid for by other teams.
function computeFlatInflation(opts) {
  const values = getValues();
  if (!values || !values.length) return null;
  const keepers = collectKeepers();
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const keptNames = new Set(keepers.map(k => _nk(k.name)));

  // Total league budget minus what's locked up in keepers
  const budgets = computeTeamBudgets();
  const leagueRemaining = Object.values(budgets).reduce((s, t) => s + t.remaining, 0);

  // Total projected value minus kept players' projected value
  let totalValue = 0, hitValue = 0, pitValue = 0;
  let remainingValue = 0, remainingHit = 0, remainingPit = 0;
  let keptValue = 0;
  for (const p of values) {
    if (p.value <= 0) continue; // skip negatives
    totalValue += p.value;
    if (p.type === "H") hitValue += p.value;
    else pitValue += p.value;
    if (keptNames.has(_nk(p.name))) {
      keptValue += p.value;
    } else {
      remainingValue += p.value;
      if (p.type === "H") remainingHit += p.value;
      else remainingPit += p.value;
    }
  }

  // Hitter / pitcher inflation — uses the H/P split of remaining budget vs.
  // remaining player value to derive separate multipliers.
  // Kept H/P value
  let keptHit = 0, keptPit = 0;
  for (const p of values) {
    if (keptNames.has(_nk(p.name)) && p.value > 0) {
      if (p.type === "H") keptHit += p.value;
      else keptPit += p.value;
    }
  }
  const hitBudget = LEAGUE.draftBudget * LEAGUE.numTeams * VALUATION.hitBudgetPct;
  const pitBudget = LEAGUE.draftBudget * LEAGUE.numTeams * (1 - VALUATION.hitBudgetPct);
  // Approximate hit/pit $ remaining: original split minus kept salaries weighted
  // by H/P share of total kept value. (Imperfect but close enough early; refined
  // once we know each kept player's actual salary.)
  const keptTotalCost = keepers.reduce((s, k) => s + (k.cost || 0), 0);
  const hitShareOfKept = keptValue > 0 ? keptHit / keptValue : VALUATION.hitBudgetPct;
  const pitShareOfKept = 1 - hitShareOfKept;
  const hitRemaining = Math.max(0, hitBudget - keptTotalCost * hitShareOfKept);
  const pitRemaining = Math.max(0, pitBudget - keptTotalCost * pitShareOfKept);

  // Normalize so the NO-KEEPER baseline is exactly 1.00. Raw remaining$/remaining
  // value only equals 1 if the projection pool happens to sum to the budget, so
  // we divide by that baseline ratio. Result: 0 keepers → 1.00, and keepers
  // (typically bargains) push it above 1. Inflation is purely the keeper premium.
  const totalBudget = LEAGUE.draftBudget * LEAGUE.numTeams;
  const totalValAll = remainingValue + keptValue;
  const baselineMultiplier = totalValAll > 0 ? totalBudget / totalValAll : 1;
  const norm = (rawNum, rawDen, base) => {
    if (rawDen <= 0 || base <= 0) return 1;
    return (rawNum / rawDen) / base;
  };
  const hitValAll = remainingHit + keptHit;
  const pitValAll = remainingPit + keptPit;
  const multiplier = norm(leagueRemaining, remainingValue, baselineMultiplier);
  const hitMult = norm(hitRemaining, remainingHit, hitValAll > 0 ? hitBudget / hitValAll : 1);
  const pitMult = norm(pitRemaining, remainingPit, pitValAll > 0 ? pitBudget / pitValAll : 1);

  return {
    mode: "flat",
    multiplier,
    hitMultiplier: hitMult,
    pitMultiplier: pitMult,
    baselineMultiplier,
    leagueRemaining,
    remainingValue,
    keptValue,
    keptCost: keptTotalCost,
    keeperCount: keepers.filter(k => k.kind === "major").length,
    minorCount: keepers.filter(k => k.kind === "minor").length,
  };
}

// Tiered (non-linear) inflation. The flat multiplier is split unevenly across
// tiers so stars absorb more and $1-bin players barely move. Constraint:
//   sum(tier_share_i * tier_value_i) = (flat_multiplier - 1) * total_remaining_value
// We define weights by tier (relative absorption) and solve for actual per-tier
// multipliers.
//
// Tier definition: by raw value bucket.
//   T1: $35+   (elite)
//   T2: $20-34 (stars)
//   T3: $10-19 (solid)
//   T4: $5-9   (mid)
//   T5: $1-4   (endgame)
function tierForValue(v) {
  if (v >= 35) return "T1";
  if (v >= 20) return "T2";
  if (v >= 10) return "T3";
  if (v >= 5)  return "T4";
  return "T5";
}

// Default absorption weights (heuristic from research): top tier picks up
// ~1.5x its share, bottom tier ~0.2x. Tuned so weighted sum stays balanced.
const TIER_ABSORPTION = { T1: 1.6, T2: 1.35, T3: 1.0, T4: 0.6, T5: 0.2 };

function computeTieredInflation() {
  const flat = computeFlatInflation();
  if (!flat) return null;
  const values = getValues();
  const _nk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const keptNames = new Set(collectKeepers().map(k => _nk(k.name)));

  // Bucket remaining (non-kept positive-value) players by tier
  const tierValue = { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 };
  for (const p of values) {
    if (keptNames.has(_nk(p.name)) || p.value <= 0) continue;
    tierValue[tierForValue(p.value)] += p.value;
  }

  // Excess to distribute = (flat_mult - 1) * remaining_value
  const totalRemaining = flat.remainingValue;
  const excess = (flat.multiplier - 1) * totalRemaining;
  // Weighted denom = sum(tierValue * absorption)
  const denom = Object.entries(tierValue).reduce((s, [k, v]) => s + v * TIER_ABSORPTION[k], 0);
  const tierMult = {};
  for (const k of Object.keys(tierValue)) {
    // per-tier multiplier = 1 + (absorption * excess / denom) / 1
    // Each $ in tier k gets (absorption * excess / denom) extra dollars.
    const extraPerDollar = denom > 0 ? (TIER_ABSORPTION[k] * excess) / denom : 0;
    tierMult[k] = 1 + extraPerDollar;
  }

  // Per-position multipliers (informational): same flat approach but bucketed.
  const posValue = {}, posKept = {};
  for (const p of values) {
    if (p.value <= 0) continue;
    posValue[p.posKey] = (posValue[p.posKey] || 0) + p.value;
    if (keptNames.has(_nk(p.name))) posKept[p.posKey] = (posKept[p.posKey] || 0) + p.value;
  }
  const posMult = {};
  for (const k of Object.keys(posValue)) {
    const rem = posValue[k] - (posKept[k] || 0);
    posMult[k] = rem > 0 ? rem / (rem) * flat.multiplier : 1;
    // (Position multipliers will be refined when we factor positional scarcity)
  }

  return {
    ...flat,
    mode: "tiered",
    tierMult,
    tierValue,
    posMult,
    absorption: TIER_ABSORPTION,
  };
}

// Apply inflation to a player's base value.
function inflatedValue(player, inflation) {
  if (!inflation || !player) return player ? player.value : 0;
  let v;
  if (inflation.mode === "tiered") {
    const t = tierForValue(player.value);
    v = player.value * inflation.tierMult[t];
  } else {
    // Flat
    const mult = player.type === "P" ? inflation.pitMultiplier : inflation.hitMultiplier;
    v = player.value * mult;
  }
  // Per-position scarcity tilt (mock engine only; absent for live inflation).
  if (inflation.posScarcity && player.posKey && inflation.posScarcity[player.posKey]) {
    v *= inflation.posScarcity[player.posKey];
  }
  return v;
}
