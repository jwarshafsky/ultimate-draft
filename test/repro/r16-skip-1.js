// r16-skip-1 — SEAM #3 (skip correctness) + #2 (pause/skip interplay).
// Sandbox setTimeout is a NO-OP here (synchronous skip paths only), matching the
// real test harness for these functions.
//   (A) skip while a lot is OPEN with the USER as current winner: do they win it
//       at the right price, and is it recorded exactly once?
//   (B) skip while PAUSED: skipInteractivePicks is gated (finished||paused) — is
//       it a clean no-op, and is state coherent after resume?
//   (C) skip-to-end: no team over 26 slots, none negative budget, pumping cleared,
//       picks recorded exactly once (no dup player names).

const { makeSandbox } = require("./r16-harness");

function freshDraft(ud) {
  ud.eval("try{stopInteractiveMock()}catch(e){}; try{clearMockDraft()}catch(e){}");
  ud.eval("setLeagueOverride(''); getEffectiveKeeperSelections = () => ({}); startInteractiveCockpitMock();");
}

const { ud, sandbox } = makeSandbox(11, {});

console.log("--- (A) skip while lot open, USER is current winner ---");
freshDraft(ud);
// Open a lot and make the USER the high bidder at $7.
ud.eval("_startAuction(getInteractiveState().pool[1], 'corey', 1); userBid(7);");
const openPlayer = ud.eval("getInteractiveState().current.name");
const userIsWinner = ud.eval("getInteractiveState().currentWinner === getMyTeam().id");
console.log("lot open on " + openPlayer + ", user winner? " + userIsWinner + " at $" + ud.eval("getInteractiveState().currentBid"));
const picksBefore = ud.eval("getInteractiveState().picks.length");
// _icSkipPicks(1) auto-passes lots the user does NOT lead — but should let a lot
// the user LEADS resolve to them. Directly drive the engine synchronous skip.
ud.eval("_icSkipPicks(1);");
const lastPick = JSON.parse(ud.eval("JSON.stringify(getInteractiveState().picks[getInteractiveState().picks.length-1])"));
console.log("after skip 1: picks +" + (ud.eval("getInteractiveState().picks.length") - picksBefore));
console.log("  last pick: " + lastPick.player + " -> " + lastPick.winnerOwner + " $" + lastPick.price);
console.log("  user WON the lot they led? " + (lastPick.player === openPlayer && lastPick.winnerTeamId === "jeff"));
// Dedup check: player appears exactly once across picks.
const dupA = ud.eval("(function(){var s={},d=0;getInteractiveState().picks.forEach(function(p){if(s[p.player])d++;s[p.player]=1});return d})()");
console.log("  duplicate picks: " + dupA);

console.log("\n--- (B) skip while PAUSED (should be gated no-op) ---");
freshDraft(ud);
ud.eval("pauseMockFeed();");
const bPicksBefore = ud.eval("getInteractiveState().picks.length");
ud.eval("skipInteractivePicks(5);");   // public wrapper: gated on _mockFeed.paused
const bPicksAfterGated = ud.eval("getInteractiveState().picks.length");
console.log("skipInteractivePicks(5) while paused: picks changed by " + (bPicksAfterGated - bPicksBefore) + " (expect 0)");
console.log("pumping flag after gated skip: " + ud.eval("_mockFeed.pumping") + " (expect false)");
ud.eval("resumeMockFeed();");
console.log("after resume: paused=" + ud.eval("_mockFeed.paused") + " phase=" + ud.eval("getInteractiveState().phase") + " active=" + ud.eval("getInteractiveState().active"));

console.log("\n--- (C) skip-to-end: roster/budget/pumping/dedup ---");
freshDraft(ud);
ud.eval("_icSkipToEnd();");
const totalPicks = ud.eval("getInteractiveState().picks.length");
const overSlots = ud.eval("Object.values(getInteractiveState().states).filter(s => s.slotsRemaining < 0).length");
const negBudget = ud.eval("Object.values(getInteractiveState().states).filter(s => s.budget < 0).length");
const over26 = ud.eval("Object.values(getInteractiveState().states).filter(s => (s.drafted.length + s.kept.length) > 26).length");
const pumping = ud.eval("_mockFeed.pumping");
const finished = ud.eval("_mockFeed.finished");
const dupC = ud.eval("(function(){var s={},d=0;getInteractiveState().picks.forEach(function(p){if(s[p.player])d++;s[p.player]=1});return d})()");
console.log("picks=" + totalPicks + "  teams<0 slots=" + overSlots + "  teams<0 budget=" + negBudget +
  "  teams>26 roster=" + over26 + "  pumping=" + pumping + "  finished=" + finished + "  dup picks=" + dupC);
// Are rosters actually FULL (all 26)? Count teams not full.
const notFull = ud.eval("Object.values(getInteractiveState().states).filter(s => s.slotsRemaining > 0).length");
console.log("  teams with slots STILL remaining: " + notFull + "  (pool left: " + ud.eval("getInteractiveState().pool.length") + ")");
