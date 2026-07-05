// p2r1-math-1 — FINDING: computeLiveTeamStates prices major keepers from
// getLeagueContractByName().cost (The League App next-year price), but the spec
// and every OTHER money engine (collectKeepers / computeTeamBudgets /
// computeFlatInflation) price them from getCurrentKeeperSalary. These two data
// sources are DIFFERENT numbers in production (League App nextYearPrice vs ESPN
// draft-history +$2/yr salary), so the team strip budget + MAX BID that Jeff
// bids against disagrees with the inflation/budget math on the same screen.
//
// Violated spec: S-089 ("keptCost is the sum of its major-keeper salaries"),
// S-030 (major keeper "at his current keeper salary (getCurrentKeeperSalary,
// else $0 fallback)"), and S-104 (one source of truth for max bid).
//
// HAND COMPUTATION (spec-correct):
//   jeff keeps Aaron Judge. getCurrentKeeperSalary("Aaron Judge") = 10.
//   base 260, adj 0, spent 0  ->  budget = 260 - 10 = 247
//   slotsRemaining = 26 - 1 keeper - 0 picks = 25  ->  maxBid = 247 - 24 = 223
//
// ACTUAL (app, when League App has a contract with a different nextYearPrice):
//   getLeagueContractByName("Aaron Judge").cost = 13  (nextYearPrice, +$3 escalation)
//   -> keptCost 13, budget 247, maxBid 223.

const realLog = console.log.bind(console);
const { installGlobals, resetDraftState } = require("./_scaffold.js");

installGlobals({
  VALUES: [{ name: "Aaron Judge", posKey: "OF", team: "NYY", type: "H", value: 40 }],
  KEEPER_SELECTIONS: { jeff: { "Aaron Judge": { keeper: true } } },
  getCurrentKeeperSalary: () => 10,             // ESPN keeper salary (spec source of truth)
  getLeagueContractByName: () => ({ kind: "major", cost: 13 }), // League App next-year price (differs)
});
resetDraftState();
global.localStorage.setItem("ud_feed_mode", "real");
global.localStorage.removeItem("ud_league_override");

// AMENDED SPEC (Round 5): keeperCostFor = League contract cost (13) first —
// the true invariant is that ALL money engines agree on it.
const EXPECT = { keptCost: 13, budget: 247, maxBid: 223 };
const st = global.computeLiveTeamStates().jeff;
const actual = { keptCost: st.keptCost, budget: st.budget, maxBid: st.maxBid };

// Cross-check: the inflation/budget engines DO price at getCurrentKeeperSalary=10.
const inflKept = global.computeFlatInflation().keptCost;
const budgetKept = global.computeTeamBudgets().jeff.keepers;

realLog("Spec-correct (keeperCostFor → League cost 13):", JSON.stringify(EXPECT));
realLog("computeLiveTeamStates (actual)           :", JSON.stringify(actual));
realLog("computeFlatInflation.keptCost             :", inflKept, "(agrees with spec)");
realLog("computeTeamBudgets.keepers                :", budgetKept, "(agrees with spec)");

let ok = true;
for (const k of Object.keys(EXPECT)) {
  if (actual[k] !== EXPECT[k]) {
    realLog("  MISMATCH " + k + ": expected " + EXPECT[k] + " got " + actual[k]);
    ok = false;
  }
}
// Also assert the two engines diverge from each other (the core bug).
if (st.keptCost === inflKept) { realLog("  (engines agree — bug not reproduced)"); }
else { realLog("  DIVERGENCE: computeLiveTeamStates keptCost=" + st.keptCost + " != inflation keptCost=" + inflKept); ok = false; }

if (ok) { realLog("\nPASS (no bug)"); process.exit(0); }
realLog("\nFAIL — computeLiveTeamStates keeper cost source diverges from spec + other money engines");
process.exit(1);
