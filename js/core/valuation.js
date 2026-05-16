// Valuation engine — SGP-based dollar values customized to The League's
// categories (OBP, QS, SV+HLD). Builds per-player values from projections.
//
// Approach:
//   1. Compute league-wide replacement levels (top N at each position counts).
//   2. For each player, compute SGP (standings gain points) per category as
//      (player_stat - replacement_stat) / SGP_denominator. For rate stats
//      (OBP, ERA, WHIP), use the impact-vs-replacement formula.
//   3. Convert total SGP to dollars: scale so total $ = league budget * H/P
//      split, with replacement-level player = $0 (clamped to $1 floor).

// Jeff's exact FanGraphs Auction Calculator settings (decoded from URL):
//   teams=12, dollars=260, mb=1 (min bid $1), mp=10 (min PA/IP eligibility)
//   msp=5 (min 5 starts for SP), mrp=5 (min 5 relief apps for RP)
//   proj=steamer (variable), split=70 (70/30 hitter/pitcher)
//   points=c|1,2,3,4,5|2,3,4,13,14 → R/HR/RBI/SB/OBP + K/ERA/WHIP/QS/SV+HLD
//   rep=1 (replacement = fill positions then 1 backup)
//   drp=30 (only top 30 RPs counted in pricing pool — past that, $1)
//   pp=C,SS,2B,3B,OF,1B (positional priority for multi-eligibility)
//   pos=1,1,1,1,5,1,1,1,0,1,6,4,0,0,0 →
//     C:1, 1B:1, 2B:1, 3B:1, OF:5, SS:1, MI:1, CI:1, DH:0, UTIL:1, SP:6, RP:4
const FANGRAPHS_SETTINGS = {
  url: "https://www.fangraphs.com/fantasy-tools/auction-calculator?teams=12&lg=MLB&dollars=260&mb=1&mp=10&msp=5&mrp=5&type=RP&proj=steamer&split=70&points=c%7C1%2C2%2C3%2C4%2C5%7C2%2C3%2C4%2C13%2C14&rep=1&drp=30&pp=C%2CSS%2C2B%2C3B%2COF%2C1B&pos=1%2C1%2C1%2C1%2C5%2C1%2C1%2C1%2C0%2C1%2C6%2C4%2C0%2C0%2C0",
  minBid: 1,
  hitterSplit: 0.70,
  rpCap: 30,                    // drp=30 — RP pool capped, past 30 get $1
  spPerTeam: 6,
  rpPerTeam: 4,
  positionalPriority: ["C", "SS", "2B", "3B", "OF", "1B"],  // pp= order
  // Per-team starter slots (excludes 4 bench)
  slotsPerTeam: { C:1, "1B":1, "2B":1, "3B":1, OF:5, SS:1, MI:1, CI:1, UTIL:1, SP:6, RP:4 },
};

const VALUATION = {
  // League-wide starter slots (12 teams × per-team count). Bench (4 × 12 = 48
  // slots) is excluded from value pool — bench players get the $1 floor.
  hitSlots: {
    C: 12, "1B": 12, "2B": 12, "SS": 12, "3B": 12,
    MI: 12, CI: 12, OF: 60, UTIL: 12,
  }, // 156 hitter slots
  // 6 SP + 4 RP per team = 120 P slots, but drp=30 caps RP value pool. So
  // 72 SP + 30 RP = 102 pitcher slots that earn $ above $1 floor.
  pitSlots: 102,
  // Hitter / pitcher budget split — FanGraphs split=70.
  hitBudgetPct: 0.70,
  // SGP denominators — derived from historical 12-team roto standings (1-pt
  // gap in each category). These get refined from actual league history.
  // Default rough numbers for 12-team 5x5 with OBP/QS/SV+HLD.
  sgp: {
    R: 14, HR: 5.4, RBI: 13, SB: 4.5, OBP: 0.0027,
    QS: 4.7, K: 19, SV_HLD: 6.5, ERA: -0.026, WHIP: -0.0072,
  },
  // Replacement-level ranks per position. rep=1 means replacement is at "fill
  // every starter slot + 1 backup". Slot counts (12-team):
  //   C: 12 starters → replacement at #14 (12 + UTIL overflow)
  //   1B/CI: 12 + ~6 CI-spill → #18
  //   2B/MI: 12 + ~6 MI-spill → #18
  //   3B/CI: 12 + ~6 CI-spill → #18
  //   SS/MI: 12 + ~6 MI-spill → #18
  //   OF: 60 + 12 UTIL → #72
  //   SP: 72 starters → replacement at #75 (just past the slot count)
  //   RP: 30 (drp=30 cap — anything past 30 gets $1 floor)
  replacement: {
    C: 14, "1B": 18, "2B": 18, "SS": 18, "3B": 18, OF: 72,
    SP: 75, RP: 30,
  },
  // Minimum dollar value (auction floor)
  minDollar: 1,
};

// Normalize position. Multi-eligibility resolves to the scarcest position
// per FanGraphs pp= (positional priority): C → SS → 2B → 3B → OF → 1B.
// DH/UT collapses to UTIL.
function normalizePos(posStr) {
  if (!posStr) return "UTIL";
  const tokens = String(posStr).toUpperCase().split(/[,/\s]+/).filter(Boolean);
  // Apply FanGraphs positional priority order
  for (const p of FANGRAPHS_SETTINGS.positionalPriority) {
    if (tokens.includes(p)) return p;
  }
  // Catch-alls: DH/UT → UTIL, OF variants → OF
  if (tokens.some(t => t === "LF" || t === "CF" || t === "RF")) return "OF";
  if (tokens.some(t => t === "DH" || t === "UT" || t === "UTIL")) return "UTIL";
  // Pitchers
  for (const p of ["SP", "RP", "P"]) {
    if (tokens.includes(p)) return p === "P" ? "SP" : p;
  }
  return tokens[0] || "UTIL";
}

// Best-effort SP/RP classification using IP and (W vs SV+HLD).
function classifyPitcher(p) {
  // If listed pos says it, trust it.
  const pos = normalizePos(p.pos);
  if (pos === "SP" || pos === "RP") return pos;
  // Heuristic: IP > 100 AND QS > 5 => SP; else RP.
  if ((p.IP || 0) >= 100 && (p.QS || 0) >= 5) return "SP";
  if ((p.SV || 0) + (p.HLD || 0) >= 5) return "RP";
  return (p.IP || 0) >= 100 ? "SP" : "RP";
}

// Computes hits, BB and AVG-from-PA-style stats needed for OBP impact.
function hitterCounts(h) {
  // If OBP missing, derive from AVG (approx). Most FG exports include OBP.
  const PA = h.PA || 0;
  const H = h.H || (h.AB && h.AVG ? h.AB * h.AVG : 0);
  const BB = h.BB || (PA && h.AB ? Math.max(0, PA - h.AB - 0) : 0);
  return { PA, AB: h.AB || 0, H, BB };
}

// SGP for a hitter — counting stats normalize by SGP denominator; OBP uses
// impact: ((h.OBP - 0.320) * h.PA) / SGP_denom * (1/teamPAweight). We use the
// classic "OBP points above .320 per PA" form.
function hitterSGP(h) {
  const r  = (h.R  || 0) / VALUATION.sgp.R;
  const hr = (h.HR || 0) / VALUATION.sgp.HR;
  const rb = (h.RBI|| 0) / VALUATION.sgp.RBI;
  const sb = (h.SB || 0) / VALUATION.sgp.SB;
  // OBP impact: (player OBP - .320) * PA / 9000 / sgp (rough — refined later).
  const obpImpact = ((h.OBP || 0) - 0.320) * (h.PA || 0) / 9000;
  const obp = obpImpact / VALUATION.sgp.OBP;
  return { R: r, HR: hr, RBI: rb, SB: sb, OBP: obp, total: r + hr + rb + sb + obp };
}

function pitcherSGP(p, role) {
  const qs = (p.QS || 0) / VALUATION.sgp.QS;
  const k  = (p.K  || 0) / VALUATION.sgp.K;
  const svh = ((p.SV || 0) + (p.HLD || 0)) / VALUATION.sgp.SV_HLD;
  // ERA / WHIP impact — (player_rate - 4.00 / 1.30) * IP / lg_innings.
  const ipw = (p.IP || 0) / 1450; // 1450 IP scoring innings per team
  const eraImpact = ((p.ERA || 0) - 4.00) * ipw;
  const whipImpact = ((p.WHIP || 0) - 1.30) * ipw;
  const era = eraImpact / VALUATION.sgp.ERA;   // bad ERA => big negative SGP
  const whip = whipImpact / VALUATION.sgp.WHIP;
  return { QS: qs, K: k, SV_HLD: svh, ERA: era, WHIP: whip, total: qs + k + svh + era + whip, role };
}

// Computes replacement-level SGP at each position by sorting players and
// taking the rank-N value. Returns { posKey: replacementSGP }.
function computeReplacementLevels(players) {
  const buckets = {};
  for (const pl of players) {
    const k = pl.posKey;
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(pl.totalSGP);
  }
  const repl = {};
  for (const [k, arr] of Object.entries(buckets)) {
    arr.sort((a, b) => b - a);
    const n = VALUATION.replacement[k] || arr.length;
    repl[k] = arr[Math.min(n - 1, arr.length - 1)] || 0;
  }
  return repl;
}

// Computes all dollar values. Returns array of player objects with .value $.
function computeValues() {
  const hitters = getHitterProjections();
  const pitchers = getPitcherProjections();
  if (!hitters.length && !pitchers.length) return [];

  // Stage 1: compute SGP per player
  const all = [];
  for (const h of hitters) {
    const sgp = hitterSGP(h);
    const pos = normalizePos(h.pos);
    all.push({
      name: h.name, team: h.team, pos: pos, type: "H",
      posKey: pos === "DH" ? "UTIL" : pos,
      proj: h, sgp, totalSGP: sgp.total,
    });
  }
  for (const p of pitchers) {
    const role = classifyPitcher(p);
    const sgp = pitcherSGP(p, role);
    all.push({
      name: p.name, team: p.team, pos: role, type: "P",
      posKey: role,
      proj: p, sgp, totalSGP: sgp.total,
    });
  }

  // Stage 2: replacement levels per position bucket
  const repl = computeReplacementLevels(all);

  // Stage 3: SGP above replacement
  for (const pl of all) {
    pl.sgpAbove = pl.totalSGP - (repl[pl.posKey] || 0);
  }

  // Stage 4: convert SGP above to $. Sum positive SGPAbove for hitters/pitchers
  // separately, then scale to (budget * pct) - (slots * $1 floor).
  const totalBudget = LEAGUE.draftBudget * LEAGUE.numTeams; // 3120
  const hitBudget = totalBudget * VALUATION.hitBudgetPct;
  const pitBudget = totalBudget * (1 - VALUATION.hitBudgetPct);
  // Total draftable slots (positive-value players we expect to draft)
  const hitSlotCount = Object.values(VALUATION.hitSlots).reduce((s, n) => s + n, 0);
  const pitSlotCount = VALUATION.pitSlots;
  // Total SGP above replacement
  const hitPosSGP = all.filter(p => p.type === "H" && p.sgpAbove > 0).reduce((s, p) => s + p.sgpAbove, 0);
  const pitPosSGP = all.filter(p => p.type === "P" && p.sgpAbove > 0).reduce((s, p) => s + p.sgpAbove, 0);
  // Money available above $1 floor
  const hitMoneyAbove = hitBudget - hitSlotCount * VALUATION.minDollar;
  const pitMoneyAbove = pitBudget - pitSlotCount * VALUATION.minDollar;
  const hitPerSGP = hitPosSGP > 0 ? hitMoneyAbove / hitPosSGP : 0;
  const pitPerSGP = pitPosSGP > 0 ? pitMoneyAbove / pitPosSGP : 0;

  for (const pl of all) {
    const perSGP = pl.type === "H" ? hitPerSGP : pitPerSGP;
    const raw = pl.sgpAbove > 0 ? pl.sgpAbove * perSGP + VALUATION.minDollar : pl.sgpAbove * perSGP + VALUATION.minDollar;
    // Clamp positive players to $1 floor; allow negatives for non-rosterable.
    pl.value = pl.sgpAbove > 0 ? Math.max(VALUATION.minDollar, raw) : raw;
    pl.replacementSGP = repl[pl.posKey] || 0;
  }

  // Sort by value desc
  all.sort((a, b) => b.value - a.value);
  return all;
}

// Cached value list — recomputed when projections change.
let _valuesCache = null;
let _valuesByName = null;

function refreshValues() {
  _valuesCache = computeValues();
  _valuesByName = new Map(_valuesCache.map(p => [p.name, p]));
  return _valuesCache;
}

function getValues() {
  if (!_valuesCache) refreshValues();
  return _valuesCache;
}

function getPlayerValue(name) {
  if (!_valuesByName) refreshValues();
  return _valuesByName.get(name) || null;
}

// Wire cache invalidation to projection updates
if (typeof onProjectionsChange === "function") {
  onProjectionsChange(() => { _valuesCache = null; _valuesByName = null; });
}
