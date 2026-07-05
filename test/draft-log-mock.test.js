// draft-log is_mock per-session reset (R9 finding #2). DRAFT_LOG.isMock was
// one-way (only ever set to false), so a practice mock run after a real draft in
// the same tab uploaded as is_mock=false — contaminating the human
// owner-tendency dataset with synthetic bot data. Each fresh session must
// re-initialize is_mock from the incoming flag.
//
// Loads the REAL js/data/draft-log.js with minimal stubs; the upload is deferred
// via setTimeout (stubbed no-op) so no network fires — we assert on the
// synchronous draftLogStatus().isMock.

const path = require("path");
const { test, assertEq, summary, loadScript, makeLocalStorageStub } = require("./helpers");

global.localStorage = makeLocalStorageStub({});
global.window = { localStorage: global.localStorage };
global.setTimeout = () => 0;          // defer uploads into the void
global.clearTimeout = () => {};
global.console = { log() {}, warn() {}, error() {} };
global.supabaseClient = {
  from: () => ({ update: () => ({ eq: () => ({ then: () => {} }) }) }),
};

loadScript(path.join(__dirname, "..", "js/data/draft-log.js"));

const REAL = { leagueId: 1200, startedAt: 1000, sport: "flb" };
const MOCK = { leagueId: 990001, startedAt: 2000, sport: "flb" };
const ev = (seq) => ({ seq, cmd: "SOLD", teamId: 3, playerId: 111, amount: 5, at: seq });

test("a real draft session logs is_mock=false", () => {
  logDraftEvents(REAL, [ev(1)], false);
  assertEq(draftLogStatus().isMock, false, "real session not mock");
});

test("a mock session AFTER a real draft (same tab) logs is_mock=true", () => {
  logDraftEvents(MOCK, [ev(1)], true);   // new clientKey → fresh session
  assertEq(draftLogStatus().isMock, true, "mock session correctly labeled is_mock");
});

test("within-session test→real correction still flips is_mock to false", () => {
  // Same clientKey as the mock session, now delivered as real (feed flipped).
  logDraftEvents(MOCK, [ev(2)], false);
  assertEq(draftLogStatus().isMock, false, "one-way correction preserved");
});

summary("draft-log is_mock per session");
