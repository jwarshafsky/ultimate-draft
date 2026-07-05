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

// Controllable Supabase stub: the draft_sessions upsert can be held pending so a
// test can rotate the session mid-await (R10 events-supabase-fidelity).
let _sessionResolve = null, _sessionCalls = 0;
const _eventUpserts = [];
global.supabaseClient = {
  from(table) {
    if (table === "draft_sessions") {
      return {
        update: () => ({ eq: () => ({ then: () => {} }) }),
        upsert: () => ({ select: () => ({ single: () => new Promise((res) => {
          _sessionCalls++;
          const id = "sess-" + _sessionCalls;
          _sessionResolve = () => res({ data: { id }, error: null });
        }) }) }),
      };
    }
    return { upsert: (rows) => { _eventUpserts.push(rows); return Promise.resolve({ error: null }); } };
  },
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

// #R10-3 — a session rotation (real → mock in the same tab) that lands DURING an
// in-flight session upsert must not stamp the new session with the old id, and
// must not upload the new session's events under the old session_id.
async function rotationTest() {
  logDraftEvents({ leagueId: 1200, startedAt: 9000, sport: "flb" }, [ev(1)], false);   // session A (real)
  const flushP = _dlFlush();               // awaits the (pending) session upsert
  await Promise.resolve();                  // let _dlFlush reach the await
  // Rotate to session B (mock) while A's upsert is still pending.
  logDraftEvents({ leagueId: 990001, startedAt: 9001, sport: "flb" }, [ev(1)], true);
  const eventsBefore = _eventUpserts.length;
  if (_sessionResolve) _sessionResolve();   // now resolve A's upsert
  await flushP;
  test("#R10-3 a rotation mid-flush doesn't stamp the new session or misattribute events", () => {
    assertEq(draftLogStatus().isMock, true, "current session is the mock (B)");
    assertEq(draftLogStatus().sessionId, null, "the new mock session was NOT stamped with session A's id");
    assertEq(_eventUpserts.length, eventsBefore, "no events uploaded under the old session_id");
  });
}

rotationTest().then(() => summary("draft-log is_mock per session"));
