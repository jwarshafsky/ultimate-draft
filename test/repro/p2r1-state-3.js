// p2r1-state-3 — FEED STALENESS: an "absorbing stale" state that does not clear
// when the ESPN draft tab later opens.
//
// STATE TRACE (feed lifecycle):
//   A capture is stale (>15 min old, no ESPN tab) → _applyDraftFeed sets
//   _feed.staleInfo, _feed.connected=false, and returns WITHOUT ingesting (S-051).
//   The panel shows "Last capture … (not live)". Correct so far.
//
//   Now the ESPN draft tab OPENS — a heartbeat arrives → _onDraftTabPresent sets
//   _feed.tabAt, so draftTabOpen() flips TRUE. Per S-053 the tab (not age) now
//   decides "live": the same capture MUST become ingestible. But _onDraftTabPresent
//   only re-renders; it never clears _feed.staleInfo, never flips _feed.connected,
//   and never re-applies / re-requests the retained feed. _applyDraftFeed is only
//   re-entered when a NEW draftFeed storage change arrives. If the draft is between
//   picks / paused when Jeff opens the tab, no new frame arrives, so:
//     - the panel keeps showing "Last capture … (not live)" though the tab is open;
//     - the already-captured picks stay OFF the board (0 picks ingested).
//   This is an absorbing display+data state: "tab open" cannot by itself heal it.
//
// VIOLATES: S-053 (a capture stale by time but with a live ESPN tab MUST still be
//   ingestible — the tab decides live), S-165 / S-052 (the "not live" label must
//   apply only when there is NO live tab), S-173 (recovery must be automatic).
//
// This script exits NONZERO while the bug exists.

const H = require("./_apploader.js");
H.install();
const log = H.realConsole;

H.setRealMode();
H.resetDraftState();
global._espnIdToName = { 39832: "Corbin Carroll" };

(async function run() {
  // --- stale capture, no tab ---
  global._feed.tabAt = 0;
  const stale = Date.now() - 20 * 60 * 1000;   // 20 min ago (> 15-min gate)
  await global._applyDraftFeed({
    leagueId: 1200, sport: "flb", updatedAt: stale,
    picks: [{ playerId: 39832, teamId: 6, price: 12, seq: 10, ts: stale }],
  });

  if (global._feed.connected !== false || !global._feed.staleInfo) {
    log.error("(setup) expected a stale capture (connected=false, staleInfo set); got connected=" +
      global._feed.connected + " staleInfo=" + !!global._feed.staleInfo);
  }

  // --- the ESPN draft tab now OPENS (heartbeat) ---
  global._onDraftTabPresent({ at: Date.now(), leagueId: 1200, sport: "flb" });
  await new Promise(r => setTimeout(r, 20));   // healing re-applies the feed asynchronously

  const tabOpen = global.draftTabOpen();
  let failed = false;

  if (tabOpen && global._feed.staleInfo) {
    failed = true;
    log.error("BUG PRESENT: the ESPN draft tab is open (draftTabOpen()=" + tabOpen +
      ") but _feed.staleInfo is still set — the panel keeps showing 'Last capture … (not live)' " +
      "even though the tab, per S-053, now decides 'live'.");
  }
  if (tabOpen && global._liveDraft.picks.length === 0) {
    failed = true;
    log.error("BUG PRESENT: with the tab open, the retained capture's picks were never ingested " +
      "(_liveDraft.picks is empty). Opening the tab into a paused/between-picks draft cannot heal " +
      "the stale state — recovery is neither automatic nor ≤1 click.");
  }

  if (!failed) {
    log.log("OK — opening the ESPN tab clears the stale state and ingests the capture.");
    process.exit(0);
  }
  log.error("\nSpec violated: S-053 / S-052 / S-165 / S-173 — 'tab open' is an absorbing " +
    "no-op against a stale capture: _onDraftTabPresent never clears staleInfo, re-applies, or " +
    "re-requests the feed, so a live tab still reads as 'Last capture (not live)' with 0 picks.");
  process.exit(1);
})();
