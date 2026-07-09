// r15 mock-engine Monte Carlo harness (standalone node).
// Loads the REAL js/core/mock-engine.js + js/core/inflation.js against a
// realistic full-size value pool, then runs Monte Carlo and reports the
// money-conservation / star-price / stranded-cash bands for BOTH
// noKeepers:true (what mock-live-feed.js drives) and keepers (Mock Draft tab).
//
// No source edits. Pure read of the shipped engine.

const fs = require("fs");
const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

// ---- Build a realistic value pool ---------------------------------------
// 12 teams x 26 = 312 roster slots. ROSTER_SLOT_CAP hard/soft slots per team:
//   C1 1B1 2B1 3B1 SS1 MI1 CI1 OF5 UTIL1 SP6 RP4 = 23 starters + 3 bench = 26.
// League-wide hard demand: C12 1B12 2B12 3B12 SS12 OF60 SP72 RP48 (+flex).
// We want a pool ~1.4x rosterable so there's a $1 tail. ~430 players.
// Value distribution: a few elite $35+, a stars band, a long mid/endgame tail,
// summing to roughly 12*260 = $3120 of "value" (so flat inflation ~1.0).

let _seed = 12345;
function rng() { // deterministic LCG so runs are reproducible across invocations
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}

function buildPool() {
  const pool = [];
  let id = 0;
  // position mix roughly matching demand
  const posPlan = [
    ["C", 24, "H"], ["1B", 30, "H"], ["2B", 30, "H"], ["3B", 30, "H"],
    ["SS", 30, "H"], ["OF", 95, "H"], ["SP", 110, "P"], ["RP", 70, "P"],
  ];
  // Assign values from a descending curve per position so each position has
  // studs + filler. Global target sum ~3120.
  const rows = [];
  for (const [pos, count, type] of posPlan) {
    for (let i = 0; i < count; i++) {
      // value curve: top few high, decaying
      const frac = i / count;
      let v;
      if (frac < 0.05) v = 40 + Math.round(rng() * 18);       // elite
      else if (frac < 0.15) v = 18 + Math.round(rng() * 12);  // stars
      else if (frac < 0.35) v = 9 + Math.round(rng() * 9);    // solid
      else if (frac < 0.6) v = 4 + Math.round(rng() * 5);     // mid
      else v = 1 + Math.round(rng() * 3);                     // endgame tail
      // Real eligibility model (mirrors valuation.js eligibleSlots): hitters
      // get UTIL, and MI (2B/SS) / CI (1B/3B) flex; pitchers stay single-slot.
      let elig;
      if (type === "P") elig = [pos];
      else {
        elig = [pos, "UTIL"];
        if (pos === "2B" || pos === "SS") elig.push("MI");
        if (pos === "1B" || pos === "3B") elig.push("CI");
      }
      rows.push({ name: pos + "-" + (i + 1) + "-" + (id++), posKey: pos, elig, team: "T", type, value: v });
    }
  }
  // scale to ~3120 total
  const sum = rows.reduce((s, r) => s + r.value, 0);
  const scale = 3120 / sum;
  for (const r of rows) r.value = Math.max(1, Math.round(r.value * scale));
  return rows;
}

const VALUES = buildPool();
const VAL_BY_NAME = Object.fromEntries(VALUES.map(v => [v.name.toLowerCase(), v]));

function normalizePlayerName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

const LEAGUE = {
  draftBudget: 260, rosterSize: 26, numTeams: 12,
  teams: Array.from({ length: 12 }, (_, i) => ({ id: "t" + i, owner: "Owner" + i, name: "Team" + i, isMe: i === 4 })),
};

// Keeper selections for the WITH-keepers run: each team keeps 2-4 players at a
// discount to their value (typical keeper-league surplus).
const KEEPER_SELECTIONS = {};
const KEEPER_SALARY = {};
(function seedKeepers() {
  // Keep a REALISTIC mix (some studs, some mid) at a discount, but leave plenty
  // of $25+ stars in the auction so the star-price band is measurable.
  let ci = 0;
  const kept = VALUES.filter(v => v.value >= 10 && v.value <= 30)
    .sort((a, b) => b.value - a.value);
  for (const t of LEAGUE.teams) {
    const sel = {};
    const n = 2 + (ci % 3); // 2..4 keepers
    for (let k = 0; k < n && ci < kept.length; k++, ci += 2) { // skip every other → spread
      const p = kept[ci];
      if (!p) break;
      sel[p.name] = { keeper: true };
      KEEPER_SALARY[p.name.toLowerCase()] = Math.max(1, Math.round(p.value * 0.5)); // ~50% of value
    }
    KEEPER_SELECTIONS[t.id] = sel;
  }
})();

// ---- Install globals the engine calls -----------------------------------
const g = {
  LEAGUE,
  getValues: () => VALUES,
  getPlayerValue: (name) => VAL_BY_NAME[normalizePlayerName(name)] || null,
  normalizePlayerName,
  getKeeperSelections: () => KEEPER_SELECTIONS,
  getEffectiveKeeperSelections: () => KEEPER_SELECTIONS,
  getCurrentKeeperSalary: (name) => {
    const v = KEEPER_SALARY[normalizePlayerName(name)];
    return typeof v === "number" ? v : null;
  },
  getLeagueContractByName: () => null,
  getDraftDollarAdjustment: () => 0,
  Math, Date,
};
const _realConsole = global.console;
global.console = { log() {}, warn() {}, error() {} };  // silence engine load-time noise
for (const k of Object.keys(g)) global[k] = g[k];

// collectKeepers / draftExcludedNames live in inflation.js — load it too.
const files = ["core/inflation.js", "core/mock-engine.js"];
let bundle = files.map(f => fs.readFileSync(APP + f, "utf8")).join("\n;\n");
// export module-level consts we may want
bundle += "\n;globalThis.runMockDraft=runMockDraft;globalThis.runMockDraftMonteCarlo=runMockDraftMonteCarlo;globalThis.buildMockTeamStates=buildMockTeamStates;globalThis.tierForValue=tierForValue;";
(0, eval)(bundle);
global.console = _realConsole;   // restore for the caller

module.exports = { VALUES, VAL_BY_NAME, LEAGUE, KEEPER_SELECTIONS, KEEPER_SALARY, normalizePlayerName, rng };
