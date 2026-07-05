// P2R2 FINDING 2 (MEDIUM — data integrity of the tendency DB)
// ---------------------------------------------------------------------------
// SCENARIO: after the REAL draft (league 1200) is captured in a tab, flipping
// the feed mode to TEST in the SAME tab (to start practice mocks) relabels the
// just-finished real draft as a mock in Supabase.
//
// Jeff drafts for real.  draft-log.js is mirroring with is_mock=false; the
// in-memory DRAFT_LOG.isMock is false and the 1200 session row exists.  Still in
// that tab, he switches the feed to TEST.  Any subsequent event for the 1200
// stream (a straggler frame, a re-sync, or the ~3s post-load re-send after a
// reload where DRAFT_LOG re-learned isMock=false from a same-session capture)
// calls logDraftEvents with is_mock = (getFeedMode() !== "real") = TRUE.
// draft-log.js:62 then sees wasMock(false) !== isMock(true) and UPDATEs the real
// draft's draft_sessions row to is_mock=true.
//
// NOTE on the aged/reload path: a genuinely fresh process defaults
// DRAFT_LOG.isMock=true and the ud_draft_sessions_v1 cache does NOT persist
// is_mock, so a reload-then-flip does NOT reproduce (wasMock default true ==
// isMock true → no update).  The reachable trigger is the SAME-tab flip while
// isMock is still false in memory — which this repro drives.
//
// WHAT JEFF SEES: nothing at the moment — but his REAL draft is silently flagged
// as a mock in the owner-tendency database.
//
// VIOLATED SPEC: S-109 ("a session MUST be is_mock=true whenever the feed mode
// is not real, and false ONLY for the real league draft") + S-110 (mid-session
// test→real updates the row — the reverse real→test must NOT relabel a finished
// real draft).  The is_mock flag tracks the CURRENT mode, not the mode the
// events were captured under.
//
// This repro captures the is_mock value the app writes to Supabase and FAILS if
// it is true (real draft relabeled mock).

const fs = require("fs");
const path = require("path");
const { install, realConsole } = require("./_apploader.js");

// Record every draft_sessions.update({is_mock}) the app issues.
const isMockUpdates = [];
// A stub Supabase client that captures the update chain draft-log.js uses.
const supabaseStub = {
  from(table) {
    return {
      update(patch) {
        if (table === "draft_sessions" && "is_mock" in patch) isMockUpdates.push(patch.is_mock);
        return { eq() { return Promise.resolve({ data: null, error: null }); } };
      },
      upsert() { return { select() { return { single() { return Promise.resolve({ data: { id: "sess-1200" }, error: null }); } }; } }; },
    };
  },
};

// Aged REAL-league (1200) event backup + its cached session (is_mock=false).
const startedAt = Date.now() - 7 * 24 * 3600 * 1000;  // last week's real draft
const realEvents = [
  { seq: 1, at: startedAt, cmd: "NOMINATION", teamId: 5, playerId: 2001, text: "" },
  { seq: 2, at: startedAt + 1000, cmd: "BID", teamId: 6, playerId: 2001, amount: 10 },
  { seq: 3, at: startedAt + 2000, cmd: "SOLD", teamId: 6, playerId: 2001, amount: 12 },
];
const agedEventBackup = JSON.stringify({ leagueId: 1200, sport: "flb", startedAt, events: realEvents });
// The real draft's session was already created + partly uploaded (watermark 0
// so the re-send re-queues; the row already exists so the is_mock UPDATE path
// fires).  is_mock was false when captured.
const agedSessions = JSON.stringify({ ["1200:" + startedAt]: { id: "sess-1200", uploadedSeq: 0 } });

// COLD START: device now in TEST mode (Jeff moved on to practice mocks), aged
// REAL-league backup + session still present.
install({
  localStorage: {
    ud_feed_mode: "test",                     // moved on to mocks
    ud_draft_events_v1: agedEventBackup,      // aged REAL 1200 stream
    ud_draft_sessions_v1: agedSessions,       // real draft's session (is_mock=false)
  },
  logDraftEvents: undefined,   // use the REAL draft-log.js
});

// Load the real draft-log.js + wire the supabase/currentUser globals it needs.
global.supabaseClient = supabaseStub;
global.currentUser = { id: "jeff" };
// Pin DRAFT_LOG (a top-level const) onto global so we can inspect it, mirroring
// the app-engines loader's export trick.
(0, eval)(fs.readFileSync(path.join(__dirname, "../../js/data/draft-log.js"), "utf8") +
  "\n;globalThis.DRAFT_LOG=DRAFT_LOG;");

// COLD START (fresh process, no priming): logDraftEvents picks up the cached
// session id + watermark from ud_draft_sessions_v1 on its first call, and reads
// the row's prior is_mock state from the CACHE... except the cache does NOT
// store is_mock — so DRAFT_LOG.isMock starts at its default `true` (draft-log.js
// line 22). We therefore reproduce with the accurate default: the fresh process
// believes wasMock=true (default) — which HIDES the bug in a fresh process but
// EXPOSES a subtler one below. To model the true incident (a same-tab mode flip
// AFTER a real capture, no reload) we set the pre-flip state the app actually
// held: isMock=false because the real draft was just captured.
global.DRAFT_LOG.clientKey = "1200:" + startedAt;
global.DRAFT_LOG.sessionId = "sess-1200";
global.DRAFT_LOG.isMock = false;             // was a REAL draft (captured is_mock=false)
global.DRAFT_LOG.uploadedSeq = 0;

// Fire the exact call draft.js:919-923 makes on load, with the CURRENT mode's
// is_mock flag.
const isMockArg = global.getFeedMode() !== "real";   // test mode → true
realConsole.log("3s re-send will pass is_mock=" + isMockArg + " for the aged 1200 real-draft stream");

// The is_mock UPDATE (draft-log.js:62-65) fires SYNCHRONOUSLY inside
// logDraftEvents when wasMock !== isMock and a sessionId exists.
global.logDraftEvents({ leagueId: 1200, sport: "flb", startedAt }, realEvents, isMockArg);

realConsole.log("draft_sessions is_mock updates issued: " + JSON.stringify(isMockUpdates));
realConsole.log("DRAFT_LOG.isMock is now: " + global.DRAFT_LOG.isMock);
const relabeled = isMockUpdates.includes(true);
if (relabeled) {
  realConsole.log("\n\x1b[31mFAIL (bug reproduced)\x1b[0m: the aged REAL draft (league 1200) " +
    "was RELABELED is_mock=true in Supabase because the post-load re-send used the CURRENT " +
    "(test) mode, not the mode the events were captured under. Spec S-109 violated: the real " +
    "draft is now a 'mock' in the tendency DB.");
  process.exitCode = 1;
} else {
  realConsole.log("\n\x1b[32mPASS\x1b[0m: the real draft's is_mock label was preserved.");
}
