// Season transaction log → contract roots (js/data/transactions.js).
// Jeff, Jul 9 2026: "why can't you monitor ESPN data to know all league
// transactions?" — validated against the real 2026 season (6,059 transactions,
// 369/373 rostered players resolved; the other 4 were mid-FAAB-run timing).
// Key facts encoded here:
//   - trades are TRANSPARENT: the root is decided by the most recent
//     draft/add/drop trail alone (ESPN hides trade items from public reads).
//   - commissioner "manual trades" (drop on team A + instant add on team B,
//     within minutes, outside FAAB runs) are hops that PRESERVE the chain —
//     the real Corey Seager case (dropped by team 12, added by team 2 29s
//     later, contract = his $19 draft).
//   - pending/canceled transactions must be ignored (a pending waiver claim
//     carries a conditional DROP of a rostered player).
const { test, section, summary, assertEq, makeLocalStorageStub } = require("./helpers.js");
const fs = require("fs");

global.window = global;
global.localStorage = makeLocalStorageStub();
global.normalizePlayerName = (s) => String(s || "").toLowerCase().trim();
global.ESPN = { season: 2026, leagueId: 1200 };

const IDS = { "corey seager": 101, "faab guy": 102, "drafted guy": 103,
  "mystery guy": 104, "instant guy": 105, "chained faab": 106 };
global.espnPlayerIdByName = (name) => IDS[global.normalizePlayerName(name)] || null;

eval(fs.readFileSync(__dirname + "/../js/data/transactions.js", "utf8"));

const MIN = 60 * 1000;
const T0 = 1774000000000;

section("Transaction extraction (_txExtract)");
test("keeps executed ADD/DROP/DRAFT, tags waiver adds, skips pending", () => {
  const raw = [
    { status: "EXECUTED", type: "WAIVER", processDate: T0, bidAmount: 13,
      items: [{ type: "ADD", playerId: 1, toTeamId: 12 }, { type: "DROP", playerId: 2, fromTeamId: 12 }] },
    { status: "EXECUTED", type: "DRAFT", proposedDate: T0 - 1000,
      items: [{ type: "DRAFT", playerId: 3, toTeamId: 7 }] },
    { status: "EXECUTED", type: "ROSTER", processDate: T0,
      items: [{ type: "LINEUP", playerId: 4 }] },                      // lineup noise → dropped
    { status: "EXECUTED", type: "WAIVER", isPending: true, processDate: T0,
      items: [{ type: "DROP", playerId: 5, fromTeamId: 3 }] },         // pending → dropped
    { status: "CANCELED", type: "WAIVER", processDate: T0,
      items: [{ type: "ADD", playerId: 6, toTeamId: 3 }] },            // canceled → dropped
  ];
  const evs = _txExtract(raw);
  assertEq(evs.length, 3);
  assertEq(evs[0].k, "A"); assertEq(evs[0].w, true);
  assertEq(evs[1].k, "D");
  assertEq(evs[2].k, "R");
});

// Seed the cache directly (the fetch walk is exercised in the browser).
function seedLog(eventsByPeriod) {
  localStorage.setItem("ud_espn_tx_v1", JSON.stringify({ periods: eventsByPeriod, lastPeriod: 99, at: "x" }));
  _txResetForTest();   // force re-read from localStorage
}

section("Contract roots (txContractRoot)");
test("drafted and held → live (trades along the way are invisible and irrelevant)", () => {
  seedLog({ 1: [{ p: 103, d: T0, k: "R", to: 7 }] });
  assertEq(txContractRoot("Drafted Guy"), "live");
});
test("FAAB add → fa, even after later trades", () => {
  seedLog({ 1: [{ p: 102, d: T0, k: "A", w: true, to: 9 }] });
  assertEq(txContractRoot("Faab Guy"), "fa");
});
test("drafted, dropped, re-FAABed → fa (drop killed the contract)", () => {
  seedLog({ 1: [
    { p: 106, d: T0, k: "R", to: 6 },
    { p: 106, d: T0 + 10*MIN, k: "D", from: 6 },
    { p: 106, d: T0 + 20*MIN, k: "A", w: true, to: 5 },
  ] });
  assertEq(txContractRoot("Chained Faab"), "fa");
});
test("manual trade (drop + instant cross-team add 29s later) → hop, root stays live", () => {
  // Real Corey Seager pattern: drafted $19 by 12, commish-dropped, instantly
  // added by 2. NOT a $6 FA.
  seedLog({ 1: [
    { p: 101, d: T0, k: "R", to: 12 },
    { p: 101, d: T0 + 100*MIN, k: "D", from: 12 },
    { p: 101, d: T0 + 100*MIN + 29000, k: "A", w: false, to: 2 },
  ] });
  assertEq(txContractRoot("Corey Seager"), "live");
});
test("manual-trade hop over a FAAB root stays fa", () => {
  // FAABed by A, manual-traded to B: still a $6 FA keeper.
  seedLog({ 1: [
    { p: 101, d: T0, k: "A", w: true, to: 12 },
    { p: 101, d: T0 + 100*MIN, k: "D", from: 12 },
    { p: 101, d: T0 + 100*MIN + 29000, k: "A", w: false, to: 2 },
  ] });
  assertEq(txContractRoot("Corey Seager"), "fa");
});
test("instant add with NO matching drop → fa", () => {
  seedLog({ 1: [{ p: 105, d: T0, k: "A", w: false, to: 4 }] });
  assertEq(txContractRoot("Instant Guy"), "fa");
});
test("trail ending in a drop → null (mid-transaction timing skew — fall back)", () => {
  seedLog({ 1: [
    { p: 104, d: T0, k: "R", to: 8 },
    { p: 104, d: T0 + MIN, k: "D", from: 8 },
  ] });
  assertEq(txContractRoot("Mystery Guy"), null);
});
test("unknown player or empty log → null", () => {
  assertEq(txContractRoot("Nobody"), null);
  seedLog({});
  assertEq(txContractRoot("Drafted Guy"), null);
});
summary();
