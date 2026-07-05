// P2R2 AGED-STATE FINDING 1 (HIGH)
// ---------------------------------------------------------------------------
// SCENARIO: cross-device aged sync of mock picks into a Real-mode device.
//
// Desktop runs a mock (test mode). cloud-sync mirrors BOTH `ud_live_draft_v1`
// (the mock pick list, with a non-home streamKey like "9999999:...") AND
// `ud_feed_mode` to Cloudflare KV.  Days later Jeff opens the app on his laptop,
// which is set to REAL mode (ud_feed_mode="real") but has never seen those mock
// picks.  cloud-sync pulls `ud_live_draft_v1` (writing it straight to
// localStorage via _udOrigSetItem) and reloads the page.  On that reload the app
// COLD-STARTS with ud_feed_mode="real" and a localStorage `ud_live_draft_v1`
// full of mock picks.
//
// The purge-on-Real guard added after the 194-mock-pick production bug lives
// ONLY inside setFeedMode("real") (draft.js ~748).  It is NOT re-run when picks
// arrive via cloud-sync, and it is NOT run at load time — loadLiveDraft()
// (draft.js:708) just reads the picks in.  So the mock picks load and are
// evaluated under Real mode with real owners/keepers/budgets → exactly the
// 107-violation storm the production incident produced, now re-entering through
// the sync door instead of the mode-toggle door.
//
// WHAT JEFF SEES: opens the app on his second device (Real mode, draft day),
// the invariant panel is red with dozens of I-MONEY / I-POOL / I-MODE errors,
// the team strip shows real owners charged for mock picks, and inflation is
// garbage — with no toggle having been touched.
//
// This repro FAILS (throws) to prove the bug: after a cold load with aged mock
// picks + Real mode, checkDraftInvariants() reports errors.  The fix (re-run the
// non-home-stream purge at load, or key it to mode on load) makes it pass.

const fs = require("fs");
const path = require("path");
const { install, resetDraftState, realConsole } = require("./_apploader.js");

// A mock pick list from a DIFFERENT (throwaway) league, aged days.  These are
// exactly what cloud-sync would have mirrored from the desktop's mock: picks
// attributed to generic espn:N teams (test mode), with a non-home streamKey.
const MOCK_LEAGUE = 9999999;
const startedAt = Date.now() - 4 * 24 * 3600 * 1000;  // 4 days ago
const streamKey = MOCK_LEAGUE + ":" + startedAt;
const mockPicks = [
  { player: "Aaron Judge",   pos: "OF", team: "espn:1", espnTeamId: 1, price: 55, ts: startedAt, espnPlayerId: 1001, espnSeq: 10 },
  { player: "Mookie Betts",  pos: "SS", team: "espn:2", espnTeamId: 2, price: 48, ts: startedAt, espnPlayerId: 1002, espnSeq: 20 },
  { player: "Jose Ramirez",  pos: "3B", team: "espn:3", espnTeamId: 3, price: 41, ts: startedAt, espnPlayerId: 1003, espnSeq: 30 },
  { player: "Gerrit Cole",   pos: "SP", team: "espn:4", espnTeamId: 4, price: 35, ts: startedAt, espnPlayerId: 1004, espnSeq: 40 },
];
const agedLiveDraft = JSON.stringify({ v: 2, at: startedAt, picks: mockPicks, deleted: {}, streamKey });

// COLD START: Real mode already set, aged mock picks already in localStorage —
// exactly the state after cloud-sync writes ud_live_draft_v1 and reloads.
install({
  localStorage: {
    ud_feed_mode: "real",                // this device is Real (draft day)
    ud_live_draft_v1: agedLiveDraft,     // aged mock picks synced from desktop
  },
});

// Load the invariant checker into the same global scope (as index.html does).
(0, eval)(fs.readFileSync(path.join(__dirname, "../../js/core/invariants.js"), "utf8"));

// Sanity: the app cold-loaded the mock picks (loadLiveDraft ran at eval time).
const loaded = global._liveDraft.picks.length;
const mode = global.getFeedMode();
const test = global.draftTestMode();

realConsole.log("cold-start state: mode=" + mode + " draftTestMode=" + test +
  " loadedPicks=" + loaded + " streamKey=" + global._liveDraft.streamKey);

const r = global.checkDraftInvariants();
const errors = r.violations.filter(v => v.severity === "error");

realConsole.log("invariant errors after cold load: " + errors.length);
errors.slice(0, 6).forEach(v => realConsole.log("  " + v.id + ": " + v.detail));

// The bug: mock picks under Real mode trip the invariants with no user action.
if (mode === "real" && loaded === mockPicks.length && errors.length > 0) {
  realConsole.log("\n\x1b[31mFAIL (bug reproduced)\x1b[0m: cold-started in Real mode with " +
    loaded + " aged mock-stream picks; the non-home-stream purge did NOT run on load, " +
    "so checkDraftInvariants() reports " + errors.length + " errors (the 107-violation " +
    "class of bug, re-entered via cloud-sync instead of the mode toggle).");
  process.exitCode = 1;
} else if (errors.length === 0 && loaded === 0) {
  realConsole.log("\n\x1b[32mPASS\x1b[0m: aged mock-stream picks were purged on load under Real mode; invariants clean.");
} else {
  realConsole.log("\n\x1b[33mINCONCLUSIVE\x1b[0m: mode=" + mode + " loaded=" + loaded + " errors=" + errors.length);
  process.exitCode = 1;
}
