// r16-pause-1 — SEAM #2 (pause) + #5 (user clock) + #4 (proxy vs pause).
// Uses captureTimers so the user countdown + AI churn timers are real callbacks
// we fire manually. Question set:
//   (1) Pause DURING the user's countdown: does the timer tick keep firing?
//       (gen bump should kill it — verify no auto-pass after resume.)
//   (2) Resume double-scheduling: does resume spawn a SECOND churn loop while an
//       old one is still queued? (two _runAiBidsUntilUserTurn alive → double bids)
//   (3) Proxy vs pause: with proxyMax set, does the engine bid while paused?

const { makeSandbox } = require("./r16-harness");

function fireDue(timers, clock, maxSteps) {
  // Fire all timers whose `at` <= clock.t, in order, up to maxSteps.
  let n = 0;
  while (n < (maxSteps || 1000)) {
    const idx = timers.findIndex(t => t.at <= clock.t);
    if (idx < 0) break;
    const t = timers.splice(idx, 1)[0];
    try { t.fn(); } catch (e) { console.log("timer threw:", e.message); }
    n++;
  }
  return n;
}
function advance(clock, ms) { clock.t += ms; }

const { ud, clock, timers } = makeSandbox(7, { captureTimers: true });

ud.eval("setLeagueOverride(''); startInteractiveCockpitMock();");
// Open a lot as an AI (Corey) so the user is on the clock, bid speed realistic.
ud.eval("setMockBidSpeed('realistic'); _startAuction(getInteractiveState().pool[2], 'corey', 3);");
// Drive AI churn until it's the user's turn (fires _giveUserTheClock → _startMockTimer).
advance(clock, 2000); fireDue(timers, clock, 200);

console.log("\n--- (1) pause during user countdown ---");
console.log("phase=" + ud.eval("getInteractiveState().phase") +
  "  secondsLeft=" + ud.eval("getInteractiveState().secondsLeft") +
  "  currentWinner=" + ud.eval("getInteractiveState().currentWinner"));
const genBefore = ud.eval("getInteractiveState().gen");
ud.eval("pauseMockFeed();");
console.log("after pause: paused=" + ud.eval("_mockFeed.paused") +
  "  gen bumped? " + (ud.eval("getInteractiveState().gen") !== genBefore) +
  "  secondsLeft=" + ud.eval("getInteractiveState().secondsLeft") +
  "  timer cleared? " + (ud.eval("getInteractiveState()._timerId") == null));
// Advance time well past the clock and fire any stragglers. A leaked tick would
// call userPass() and change passedTeams / winner.
const winnerBefore = ud.eval("getInteractiveState().currentWinner");
advance(clock, 20000); fireDue(timers, clock, 200);
console.log("after advancing 20s while paused: currentWinner=" +
  ud.eval("getInteractiveState().currentWinner") +
  "  userPassed? " + ud.eval("getMyTeam() && getInteractiveState().passedTeams.has(getMyTeam().id)"));
console.log("  winner unchanged by leaked tick? " + (ud.eval("getInteractiveState().currentWinner") === winnerBefore));

console.log("\n--- (2) resume double-scheduling churn ---");
const timersBeforeResume = timers.length;
ud.eval("resumeMockFeed();");
// resume schedules ONE _runAiBidsUntilUserTurn. Count churn loops that fire.
let churnBids = 0;
const bidCountBefore = ud.eval("getInteractiveState().bidLog.length");
advance(clock, 1000); fireDue(timers, clock, 50);
const bidCountAfter = ud.eval("getInteractiveState().bidLog.length");
console.log("timers queued before resume=" + timersBeforeResume +
  "  bidLog grew by " + (bidCountAfter - bidCountBefore) + " on first churn wave");
console.log("phase=" + ud.eval("getInteractiveState().phase"));

console.log("\n--- (3) proxy vs pause: engine must NOT bid while paused ---");
// Fresh lot, set a proxy cap, pause, then advance — proxy step is a _later(userBid).
ud.eval("_completeSale && getInteractiveState().current && _clearMockTimer();");
ud.eval("stopInteractiveMock(); startInteractiveCockpitMock();");
ud.eval("_startAuction(getInteractiveState().pool[3], 'corey', 2);");
ud.eval("setProxyMax(40);");
ud.eval("pauseMockFeed();");
const bidBeforeProxy = ud.eval("getInteractiveState().currentBid");
const winBeforeProxy = ud.eval("getInteractiveState().currentWinner");
advance(clock, 5000); fireDue(timers, clock, 200);
const bidAfterProxy = ud.eval("getInteractiveState().currentBid");
const winAfterProxy = ud.eval("getInteractiveState().currentWinner");
console.log("proxy set to 40, paused. currentBid " + bidBeforeProxy + "->" + bidAfterProxy +
  "  winner " + winBeforeProxy + "->" + winAfterProxy);
console.log("engine bid while paused? " + (bidAfterProxy !== bidBeforeProxy || winAfterProxy !== winBeforeProxy));
// NOTE: userBid itself is gated by _icPaused, so even a leaked proxy _later(userBid)
// should no-op. Confirm.
