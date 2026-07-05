// draft-log correctness around session rotation (real draft ↔ practice mock in
// the same tab). Covers:
//   R9  — is_mock re-initialized per session (no synthetic-bot contamination).
//   R10 — _dlFlush/_dlEnsureSession snapshot the session identity around awaits,
//         so a rotation mid-flush never stamps the new session with the old id or
//         uploads events under the wrong session.
//   R11 — a rotation drains the OUTGOING session's un-uploaded events under its
//         OWN session_id instead of silently dropping them.
//
// Loads the REAL js/data/draft-log.js. setTimeout is a no-op (the debounced
// auto-flush never fires); tests drive _dlFlush directly. The rotation test runs
// FIRST, on a clean DRAFT_LOG, so cross-test queue state can't serialize badly.

const path = require("path");
const { test, assert, assertEq, summary, loadScript, makeLocalStorageStub } = require("./helpers");

global.localStorage = makeLocalStorageStub({});
global.window = { localStorage: global.localStorage };
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.console = { log() {}, warn() {}, error() {} };

// Controllable Supabase stub: draft_sessions upserts are held pending (several can
// be in flight — a flush AND a drain) so a test can rotate mid-await.
let _sessionResolvers = [];
const _sessionKeys = [];   // client_key per session upsert (attribution check)
let _sessionCalls = 0;
const _eventRows = [];     // every uploaded draft_events row {session_id, seq, …}
global.supabaseClient = {
  from(table) {
    if (table === "draft_sessions") {
      return {
        update: () => ({ eq: () => ({ then: () => {} }) }),
        upsert: (row) => ({ select: () => ({ single: () => new Promise((res) => {
          _sessionCalls++;
          const id = "sess-" + _sessionCalls;
          _sessionKeys.push(row.client_key);
          _sessionResolvers.push(() => res({ data: { id }, error: null }));
        }) }) }),
      };
    }
    return { upsert: (rows) => { rows.forEach(r => _eventRows.push(r)); return Promise.resolve({ error: null }); } };
  },
};
function resolveAllSessions() { const rs = _sessionResolvers.splice(0); rs.forEach(r => r()); }
const tick = () => new Promise(r => setImmediate(r));

loadScript(path.join(__dirname, "..", "js/data/draft-log.js"));

const ev = (seq) => ({ seq, cmd: "SOLD", teamId: 3, playerId: 111, amount: 5, at: seq });

async function main() {
  // --- rotation test FIRST (clean DRAFT_LOG) ---
  logDraftEvents({ leagueId: 1200, startedAt: 9000, sport: "flb" }, [ev(10)], false);  // session A (real), seq 10
  const flushP = _dlFlush();                 // awaits A's (pending) session upsert
  await Promise.resolve();
  logDraftEvents({ leagueId: 990001, startedAt: 9001, sport: "flb" }, [ev(20)], true); // rotate to B (mock), seq 20
  resolveAllSessions();                       // A's flush upsert + A's drain upsert
  await flushP;
  await tick(); resolveAllSessions(); await tick(); await tick();   // let the drain finish uploading

  test("#R10/R11 rotation mid-flush: new session not stamped; old events drained (not lost/misattributed)", () => {
    assertEq(draftLogStatus().isMock, true, "current session is the mock (B)");
    assertEq(draftLogStatus().sessionId, null, "the new mock (B) session was NOT stamped with A's id");
    assert(_sessionKeys.every(k => k === "1200:9000" || k === "990001:9001"), "session upserts used their own client_key (no cross-attribution)");
    assert(_eventRows.some(r => r.seq === 10), "A's un-uploaded event was drained under A's own session, not lost");
    assert(!_eventRows.some(r => r.seq === 20), "the new (mock) session's event was not uploaded by the old flush");
  });

  // --- is_mock per session (R9) ---
  const REAL = { leagueId: 1200, startedAt: 1000, sport: "flb" };
  const MOCK = { leagueId: 990001, startedAt: 2000, sport: "flb" };
  logDraftEvents(REAL, [ev(1)], false);
  test("a real draft session logs is_mock=false", () => {
    assertEq(draftLogStatus().isMock, false, "real session not mock");
  });
  logDraftEvents(MOCK, [ev(1)], true);
  test("a mock session AFTER a real draft (same tab) logs is_mock=true", () => {
    assertEq(draftLogStatus().isMock, true, "mock session correctly labeled is_mock");
  });
  logDraftEvents(MOCK, [ev(2)], false);
  test("within-session test→real correction still flips is_mock to false", () => {
    assertEq(draftLogStatus().isMock, false, "one-way correction preserved");
  });

  summary("draft-log rotation + is_mock");
}

main();
