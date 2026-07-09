// r16-proxy-1 — SEAM #4 (proxy > seat max), #5 (timer expiry vs userBid race),
// and whether the seam#1 divergence trips an invariant or stays silent.

const { makeSandbox } = require("./r16-harness");
function freshDraft(ud) {
  ud.eval("try{stopInteractiveMock()}catch(e){}; try{clearMockDraft()}catch(e){}");
  ud.eval("setLeagueOverride(''); getEffectiveKeeperSelections = () => ({}); startInteractiveCockpitMock();");
}

console.log("--- (A) proxyMax set ABOVE the user's affordable seat max ---");
{
  const { ud } = makeSandbox(3, { captureTimers: true });
  freshDraft(ud);
  // Shrink jeff's budget so seat max is small, then set a huge proxy.
  ud.eval("var s=getInteractiveState(); s.states['jeff'].budget=10; s.states['jeff'].slotsRemaining=5;");
  const seatMax = ud.eval("var st=getInteractiveState().states['jeff']; st.budget - Math.max(0, st.slotsRemaining-1)");
  ud.eval("_startAuction(getInteractiveState().pool[0], 'corey', 1);");
  ud.eval("setProxyMax(500);");   // way above seat max
  // Drive: _giveUserTheClock proxy branch steps userBid. userBid itself clamps to seatMax.
  ud.eval("_giveUserTheClock();");
  const bid = ud.eval("getInteractiveState().currentBid");
  const win = ud.eval("getInteractiveState().currentWinner");
  console.log("seatMax=" + seatMax + ", proxy=500. After one proxy step: bid=" + bid + " winner=" + win);
  console.log("  never exceeds seatMax? " + (bid <= seatMax));
}

console.log("\n--- (B) timer expiry racing a userBid (same tick) ---");
{
  const { ud, clock, timers } = makeSandbox(3, { captureTimers: true });
  freshDraft(ud);
  ud.eval("_startAuction(getInteractiveState().pool[0], 'corey', 3);");
  // Give the user the clock (starts the countdown).
  ud.eval("_giveUserTheClock();");
  // Simulate: countdown at 1s (about to expire) AND the user clicks Bid.
  ud.eval("getInteractiveState().secondsLeft = 1;");
  const bidRes = JSON.parse(ud.eval("JSON.stringify(userBid(getInteractiveState().currentBid+1))"));
  // Now fire the pending timer tick (expiry) that was queued BEFORE the bid.
  clock.t += 2000;
  let fired = 0;
  while (true) { const i = timers.findIndex(t=>t.at<=clock.t); if(i<0)break; const t=timers.splice(i,1)[0]; try{t.fn()}catch(e){} fired++; if(fired>50)break; }
  const winner = ud.eval("getInteractiveState().currentWinner");
  const passed = ud.eval("getMyTeam() && getInteractiveState().passedTeams.has(getMyTeam().id)");
  console.log("userBid ok=" + bidRes.ok + ", then stale expiry tick fired. winner=" + winner + " userPassed=" + passed);
  console.log("  user stayed winner despite a stale expiry tick? " + (winner === "jeff" && !passed));
  console.log("  NOTE: userBid calls _clearMockTimer, so the queued tick's _timerId is gone;");
  console.log("        but the tick closure captured secondsLeft on _interactive, and re-checks phase/gen.");
}

console.log("\n--- (C) does the getBudgetAdjustment divergence trip an invariant? ---");
{
  const KEEP = () => ({});
  const { ud } = makeSandbox(3, {
    getBudgetAdjustment: (id) => (id === "corey" ? 25 : 0),
  });
  ud.eval("setLeagueOverride(''); startInteractiveCockpitMock();");
  ud.eval("_icSkipToEnd();");
  const errs = JSON.parse(ud.eval(
    "JSON.stringify(checkDraftInvariants().violations.filter(function(v){" +
    "return v.severity==='error' && !(v.id==='I-MONEY' && /maxBid \\d+ != max/.test(v.detail));}))"
  ));
  console.log("corey has +25 draft dollars. corruption-severity invariant errors: " + errs.length);
  if (errs.length) console.log("  " + JSON.stringify(errs.slice(0,3)));
  // Show the divergence directly for a rich team.
  const eng = ud.eval("stopInteractiveMock(); startInteractiveCockpitMock(); buildMockTeamStates({})['corey'].budget");
  const cock = ud.eval("computeLiveTeamStates()['corey'].budget");
  console.log("  engine corey start budget=" + eng + "  cockpit corey start budget=" + cock + "  (diverge by adj)");
}
