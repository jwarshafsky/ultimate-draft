// Supabase roster adjustments in league-rosters.js (Jeff, Aug 10 2026):
// data.js is only the baseline — trades / callups / demotes / drops made in
// The League App live in Supabase, and UD loaded but never APPLIED them, so a
// traded minor-leaguer (Cole Young → Larry) kept showing on his old team's
// keeper board. These tests drive the real league-rosters.js against stubbed
// Supabase accessors.
const { test, summary, assert, assertEq, makeLocalStorageStub, loadScript } = require("./helpers.js");

global.window = global;
global.normalizePlayerName = (s) => String(s || "").toLowerCase().trim();

// Mutable Supabase state the real accessors are stubbed around.
const sb = { trades: [], rosterMoves: [], callupOverrides: {} };
global.getTrades = () => sb.trades;
global.getRosterMoves = () => sb.rosterMoves;
global.getCallupOverrides = () => sb.callupOverrides;
const dataListeners = [];
global.onDataChange = (fn) => dataListeners.push(fn);

// Baseline "data.js" (what the league-rosters cache would hold).
const baseline = {
  season: 2026,
  teams: [
    { id: "jeff", majors: [{ name: "Bryce Harper", price: 24, yearAcquired: 2023 }],
      callups: [{ name: "Coby Mayo", yearAcquired: 2024, careerStat: 0, statType: "AB" }],
      minors: [{ name: "Cole Young", yearAcquired: 2025, careerStat: 0, statType: "AB" },
               { name: "Ryan Sloan", yearAcquired: 2026, careerStat: 0, statType: "IP" }] },
    { id: "larry", majors: [], callups: [],
      minors: [{ name: "Ace Reese", yearAcquired: 2026, careerStat: 0, statType: "AB" }] },
    { id: "jesse", majors: [], callups: [], minors: [] },
  ],
};

global.localStorage = makeLocalStorageStub();
localStorage.setItem("ud_league_rosters_v1", JSON.stringify({ data: baseline, at: new Date().toISOString() }));
loadScript(__dirname + "/../js/data/league-rosters.js");

const invalidate = () => dataListeners.forEach(fn => fn());
const minorsOf = (tid) => getLeagueTeamRoster(tid).minors.map(p => p.name);
const callupsOf = (tid) => getLeagueTeamRoster(tid).callups.map(p => p.name);

test("no Supabase data → baseline passes through", () => {
  assertEq(minorsOf("jeff").join(","), "Cole Young,Ryan Sloan");
  assertEq(minorsOf("larry").join(","), "Ace Reese");
});

test("minor-typed trade moves the player between teams", () => {
  sb.trades = [{ created_at: "2026-08-01T00:00:00Z", team1: "larry", team2: "jeff",
    team1_receives: [{ type: "minor", value: "Cole Young" }], team2_receives: [] }];
  invalidate();
  assert(!minorsOf("jeff").includes("Cole Young"), "still on jeff");
  assert(minorsOf("larry").includes("Cole Young"), "not on larry");
  // Contract lookup follows: kind + teamId reflect the trade, terms travel.
  const ci = getLeagueContractByName("Cole Young");
  assertEq(ci.teamId, "larry");
  assertEq(ci.kind, "minor");
});

test("chained trade (recorded fromTeam is stale) still relocates", () => {
  sb.trades.push({ created_at: "2026-08-02T00:00:00Z", team1: "jesse", team2: "jeff",
    team1_receives: [{ type: "minor", value: "Cole Young" }], team2_receives: [] });
  invalidate();
  assert(minorsOf("jesse").includes("Cole Young"), "not on jesse");
  assert(!minorsOf("larry").includes("Cole Young"), "duplicated on larry");
});

test("callup-typed trade moves a call-up record", () => {
  sb.trades.push({ created_at: "2026-08-03T00:00:00Z", team1: "larry", team2: "jeff",
    team1_receives: [{ type: "callup", value: "Coby Mayo" }], team2_receives: [] });
  invalidate();
  assert(callupsOf("larry").includes("Coby Mayo"), "not on larry");
  assert(!callupsOf("jeff").includes("Coby Mayo"), "still on jeff");
});

test("roster_moves: callup promotes minors → callups, drop removes entirely", () => {
  sb.rosterMoves = [
    { at: "2026-08-04T00:00:00Z", kind: "callup", team_id: "jeff", player_name: "Ryan Sloan" },
    { at: "2026-08-05T00:00:00Z", kind: "drop", team_id: "larry", player_name: "Ace Reese" },
  ];
  invalidate();
  assert(callupsOf("jeff").includes("Ryan Sloan"), "not promoted");
  assert(!minorsOf("jeff").includes("Ryan Sloan"), "still in minors");
  assert(!minorsOf("larry").includes("Ace Reese"), "not dropped");
});

test("demote returns a call-up to minors with sentDown", () => {
  sb.rosterMoves.push({ at: "2026-08-06T00:00:00Z", kind: "demote", team_id: "jeff", player_name: "Ryan Sloan" });
  invalidate();
  const p = getLeagueTeamRoster("jeff").minors.find(x => x.name === "Ryan Sloan");
  assert(p, "not back in minors");
  assertEq(p.sentDown, true);
  assertEq(p.sendDownCount, 1);
});

test("majors membership is untouched (ESPN owns it)", () => {
  assertEq(getLeagueTeamRoster("jeff").majors.map(p => p.name).join(","), "Bryce Harper");
});

summary();
