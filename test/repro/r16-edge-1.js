// r16-edge-1 — SEAM #3 (user leads, no bot tops → must win+charge), #7 (restart
// hygiene), #8 (nomination edge), #6 (keeper cost lookup throws).

const { makeSandbox } = require("./r16-harness");

function freshDraft(ud) {
  ud.eval("try{stopInteractiveMock()}catch(e){}; try{clearMockDraft()}catch(e){}");
  ud.eval("setLeagueOverride(''); getEffectiveKeeperSelections = () => ({}); startInteractiveCockpitMock();");
}

console.log("--- (A) skip a lot the user leads at a HIGH price no bot will top ---");
{
  const { ud } = makeSandbox(11, {});
  freshDraft(ud);
  // Open a cheap-value player and have the user bid ABOVE its value so no AI tops.
  ud.eval("_startAuction(getInteractiveState().pool[200], 'corey', 1);");   // low-value player
  const pname = ud.eval("getInteractiveState().current.name");
  const pval = ud.eval("getInteractiveState().current.value");
  ud.eval("userBid(" + (Math.max(2, 1)) + "); userBid(getInteractiveState().currentBid+1);");
  // Force user to a high bid nobody will match (well above value).
  ud.eval("var s=getInteractiveState(); s.currentBid=Math.max(s.currentBid, s.current.value+15); s.currentWinner=getMyTeam().id;");
  const budgetBefore = ud.eval("getInteractiveState().states['jeff'].budget");
  const bid = ud.eval("getInteractiveState().currentBid");
  ud.eval("_icSkipPicks(1);");
  const last = JSON.parse(ud.eval("JSON.stringify(getInteractiveState().picks[getInteractiveState().picks.length-1])"));
  const budgetAfter = ud.eval("getInteractiveState().states['jeff'].budget");
  console.log("player " + pname + " (val " + pval + "), user forced-led at $" + bid);
  console.log("  won by: " + last.winnerOwner + " $" + last.price + "  (expect Jeff)");
  console.log("  jeff budget " + budgetBefore + " -> " + budgetAfter + " (delta " + (budgetBefore-budgetAfter) + ", expect =price)");
}

console.log("\n--- (B) restart hygiene: clear->start->clear->start, no cross-gen bleed ---");
{
  const { ud } = makeSandbox(11, {});
  freshDraft(ud);
  const gen1 = ud.eval("getInteractiveState().gen");
  ud.eval("_icSkipPicks(3);");
  const picks1 = ud.eval("getInteractiveState().picks.length");
  ud.eval("clearMockDraft(); startInteractiveCockpitMock();");
  const gen2 = ud.eval("getInteractiveState().gen");
  const picks2 = ud.eval("getInteractiveState().picks.length");
  console.log("gen1=" + gen1 + " picks1=" + picks1 + " -> after clear+start gen2=" + gen2 + " picks2=" + picks2);
  console.log("  gen advanced? " + (gen2 > gen1) + "  picks reset to 0? " + (picks2 === 0));
}

console.log("\n--- (C) nomination edge: userNominate opening > affordable max (clamp?) ---");
{
  const { ud } = makeSandbox(11, {});
  freshDraft(ud);
  // Put the user up to nominate.
  ud.eval("var s=getInteractiveState(); s.nominationOrder = ['jeff'].concat(s.nominationOrder.filter(x=>x!=='jeff')); s.currentNominator=0;");
  ud.eval("var s=getInteractiveState(); s.phase='nominating'; s.current=null;");
  const budget = ud.eval("getInteractiveState().states['jeff'].budget");
  const slots = ud.eval("getInteractiveState().states['jeff'].slotsRemaining");
  const pname = ud.eval("getInteractiveState().pool[0].name");
  const res = JSON.parse(ud.eval("JSON.stringify(userNominate('" + pname + "', 9999))"));
  const opened = ud.eval("getInteractiveState().currentBid");
  console.log("jeff budget=" + budget + " slots=" + slots + ", nominate '" + pname + "' opening 9999");
  console.log("  result ok=" + res.ok + (res.error?(" err="+res.error):"") + "  opened at $" + opened);
  console.log("  clamped to <= budget-(slots-1) = " + (budget-(slots-1)) + "? " + (opened <= budget-(slots-1)));
}

console.log("\n--- (D) keeper cost lookup THROWS (old <12-team bug) — catch still safe? ---");
{
  const KEEP = () => ({ corey: { "C_0": { keeper: true }, "SP_0": { keeper: true } } });
  const { ud } = makeSandbox(11, {
    getEffectiveKeeperSelections: KEEP,
    getKeeperSelections: KEEP,
    getLeagueContractByName: (name) => { if (name === "C_0") throw new Error("boom contract"); return null; },
    getCurrentKeeperSalary: (name) => { if (name === "SP_0") throw new Error("boom salary"); return 5; },
  });
  let built, count, err = null;
  try {
    count = ud.eval("Object.keys(buildMockTeamStates({})).length");
    built = true;
  } catch (e) { built = false; err = e.message; }
  console.log("buildMockTeamStates with throwing keeper lookups: built=" + built + (err?(" ERR="+err):"") + " teams=" + count + " (expect 12)");
  if (built) {
    const coreyBudget = ud.eval("buildMockTeamStates({})['corey'].budget");
    const coreyKept = ud.eval("buildMockTeamStates({})['corey'].kept.length");
    console.log("  corey budget=" + coreyBudget + " kept.length=" + coreyKept + " (skipped throwers, team survives)");
  }
}
