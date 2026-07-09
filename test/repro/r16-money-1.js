// r16-money-1 — SEAM #1 (dual money models) + #6 (keeper money).
// The ENGINE (buildMockTeamStates) and the COCKPIT (computeLiveTeamStates)
// compute a team's budget INDEPENDENTLY. Do they agree on starting budget for a
// keeper-laden team? Jeff's visible "max bid" comes from computeLiveTeamStates;
// the AI he bids against uses computeMaxBid on the engine state. If they read
// keeper cost differently, the number he sees is wrong.
//
// Probe A: contract exists but ci.cost is NON-NUMERIC (undefined).
//   engine: `ci ? ci.cost : salary` → reads undefined → keptCost += undefined → NaN.
//   cockpit: keeperCostFor requires typeof===number → falls through to salary/0.
// Probe B: getBudgetAdjustment (traded draft dollars). cockpit ADDS it; engine ignores.

const { makeSandbox } = require("./r16-harness");

function run(label, opts) {
  const { ud } = makeSandbox(7, opts);
  // Corey keeps the top player. Look at Corey's budget in BOTH models.
  const engineBudget = ud.eval(
    "var st = buildMockTeamStates({}); st['corey'].budget;"
  );
  const engineKeptCost = ud.eval("buildMockTeamStates({})['corey'].keptCost");
  const cockpitBudget = ud.eval("computeLiveTeamStates()['corey'].budget");
  const cockpitKeptCost = ud.eval("computeLiveTeamStates()['corey'].keptCost");
  const cockpitMaxBid = ud.eval("computeLiveTeamStates()['corey'].maxBid");
  console.log("\n=== " + label + " ===");
  console.log("engine  budget=" + engineBudget + "  keptCost=" + engineKeptCost);
  console.log("cockpit budget=" + cockpitBudget + "  keptCost=" + cockpitKeptCost + "  maxBid=" + cockpitMaxBid);
  const diverge = engineBudget !== cockpitBudget;
  console.log("DIVERGE? " + diverge + (Number.isNaN(engineBudget) ? "  (engine budget is NaN!)" : ""));
  return { engineBudget, cockpitBudget, cockpitMaxBid };
}

const KEEP = () => ({ corey: { "C_0": { keeper: true } } });

// Probe A: contract present, cost undefined (a real shape when The League App
// returns a partial contract row — cost field missing).
run("A: contract with NON-NUMERIC cost (undefined)", {
  getEffectiveKeeperSelections: KEEP,
  getKeeperSelections: KEEP,
  getLeagueContractByName: (name) => (name === "C_0" ? { name: "C_0" /* no cost */ } : null),
  getCurrentKeeperSalary: (name) => (name === "C_0" ? 30 : null),
});

// Probe A2: contract present, cost null.
run("A2: contract with cost: null", {
  getEffectiveKeeperSelections: KEEP,
  getKeeperSelections: KEEP,
  getLeagueContractByName: (name) => (name === "C_0" ? { name: "C_0", cost: null } : null),
  getCurrentKeeperSalary: (name) => (name === "C_0" ? 30 : null),
});

// Probe B: traded draft dollars via getBudgetAdjustment. Corey got +20.
run("B: getBudgetAdjustment(+20) — cockpit adds, engine ignores", {
  getEffectiveKeeperSelections: KEEP,
  getKeeperSelections: KEEP,
  getLeagueContractByName: () => null,
  getCurrentKeeperSalary: (name) => (name === "C_0" ? 30 : null),
  getBudgetAdjustment: (id) => (id === "corey" ? 20 : 0),
});

// Control: clean numeric contract — should agree.
run("CONTROL: numeric contract cost=25", {
  getEffectiveKeeperSelections: KEEP,
  getKeeperSelections: KEEP,
  getLeagueContractByName: (name) => (name === "C_0" ? { name: "C_0", cost: 25 } : null),
  getCurrentKeeperSalary: (name) => (name === "C_0" ? 30 : null),
});
