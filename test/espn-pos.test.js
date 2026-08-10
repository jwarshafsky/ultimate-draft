// SP/RP position labels (Jeff, Aug 10 2026): the Keepers page showed SPs as
// "RP" and relievers as "UT". Root cause: _espnPosLabel assumed eligibleSlot
// 14 = RP. ESPN's real flb schema: defaultPositionId 1 = SP, 11 = RP;
// eligibleSlots 13 = generic P (every pitcher has it), 14 = SP, 15 = RP.
// Verified against live league-1200 mRoster data — e.g. Tarik Skubal is
// dpid 1 slots [13,14,16,17], Josh Hader is dpid 11 slots [13,15,16,17].
const { test, summary, assertEq, makeLocalStorageStub } = require("./helpers.js");
const { loadScript } = require("./helpers.js");

global.window = global;
global.localStorage = makeLocalStorageStub();
loadScript(__dirname + "/../js/data/espn.js");

// Real shapes captured from ESPN league 1200, 2026-08-10.
const mk = (dpid, slots) => ({
  playerPoolEntry: { player: { id: 1, fullName: "X", defaultPositionId: dpid, eligibleSlots: slots, stats: [] } },
  lineupSlotId: 16,
});

test("starter (dpid 1, slots 13+14) labels SP", () => {
  const p = _normalizeEspnPlayer(mk(1, [13, 14, 16, 17]), 2026, 0);
  assertEq(p.pos, "SP");
  assertEq(p.type, "P");
});

test("reliever (dpid 11, slots 13+15) labels RP, not UT", () => {
  const p = _normalizeEspnPlayer(mk(11, [13, 15, 16, 17]), 2026, 0);
  assertEq(p.pos, "RP");
  assertEq(p.type, "P");
});

test("true swingman (slots 14+15) labels SP/RP", () => {
  const p = _normalizeEspnPlayer(mk(1, [13, 14, 15, 16, 17]), 2026, 0);
  assertEq(p.pos, "SP/RP");
});

test("pitcher with only the generic P slot falls back to defaultPositionId", () => {
  assertEq(_normalizeEspnPlayer(mk(1, [13, 16, 17]), 2026, 0).pos, "SP");
  assertEq(_normalizeEspnPlayer(mk(11, [13, 16, 17]), 2026, 0).pos, "RP");
});

test("hitters are unaffected", () => {
  const p = _normalizeEspnPlayer(mk(6, [4, 6, 7, 12, 16, 17]), 2026, 0);
  assertEq(p.pos, "SS");
  assertEq(p.type, "H");
});

test("two-way (hit + pitch slots) still detected", () => {
  const p = _normalizeEspnPlayer(mk(10, [10, 11, 12, 13, 14, 16, 17]), 2026, 0);
  assertEq(p.twoWay, true);
  assertEq(p.type, "H");
});

summary();
