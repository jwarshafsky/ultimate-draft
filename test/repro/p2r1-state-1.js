// p2r1-state-1 — SAME-LEAGUE RE-DRAFT: app-side pick list is never rotated.
//
// STATE TRACE (feed lifecycle + session identity chain):
//   Draft #1 on league 1200 runs to completion. _liveDraft.picks holds its picks
//   (the AUTHORITATIVE board/budget/inflation source). Later a NEW draft starts on
//   the SAME league. The extension's draft-bridge.rotateDraft() correctly rotates
//   its stores (fresh startedAt, cleared seen/picks). ud-bridge forwards the fresh
//   stream; the app's _onDraftEvents sees a new (leagueId,startedAt) and resets
//   _dlog.events. But NOTHING resets _liveDraft.picks. _applyDraftFeed has no
//   new-stream awareness at all, and processEspnPicks dedups the incoming (rotated,
//   fresh) feed against the STALE _liveDraft.picks.
//
//   Result: draft #1's picks persist into draft #2 — their players stay off the
//   board, their prices keep counting toward spent/inflation, and any player
//   re-drafted in #2 who was also in #1 is SWALLOWED by processEspnPicks'
//   existing.has(playerId) dedup. This mis-attributes picks and shows wrong
//   budget/inflation numbers Jeff would act on for the ENTIRE new draft.
//
// VIOLATES: S-060 (rotation must give a "fresh dedup"), S-062 (a stream whose
//   (leagueId,startedAt) differs MUST be treated as a new stream — the pick list
//   is part of that stream), S-102 (picks must never exceed teams×rosterSize),
//   S-101 (no player in two of drafted/excluded/available — here draft-#1 players
//   are wrongly "drafted" in draft #2).
//
// This script exits NONZERO while the bug exists.

const H = require("./_apploader.js");
H.install();
const log = H.realConsole;

let failed = false;
function bad(msg) { log.error("BUG PRESENT: " + msg); failed = true; }

(async function run() {
  H.setRealMode();
  H.resetDraftState();
  // ESPN draft tab open so the staleness gate (S-053) does not reject the feed
  // on age — this trace is about rotation, not staleness.
  global._feed.tabAt = Date.now();

  // ---- Draft #1: 20 picks land on league 1200 ----
  const started1 = Date.now();
  global._onDraftEvents({
    full: true,
    log: { leagueId: 1200, sport: "flb", startedAt: started1 },
    events: [{ seq: 1, at: started1, cmd: "SOCKET_OPEN" }],
  });
  // The feed delivers draft #1's 20 completed picks (players 50000..50019).
  const draft1Picks = Array.from({ length: 20 }, (_, i) => ({
    playerId: 50000 + i, teamId: 1, price: 5, seq: i,
  }));
  await global._applyDraftFeed({
    leagueId: 1200, sport: "flb", updatedAt: started1, picks: draft1Picks,
  });

  const afterFirst = global._liveDraft.picks.length;
  if (afterFirst !== 20) {
    log.error("(setup) expected 20 picks after draft #1, got " + afterFirst);
  }

  // ---- A NEW draft starts on the SAME league (fresh startedAt) ----
  // Extension rotated: fresh startedAt=9000, its feed.seen/picks are cleared, and
  // the new draft has only 3 picks so far.
  const started2 = 9000;
  global._onDraftEvents({
    full: true,
    log: { leagueId: 1200, sport: "flb", startedAt: started2 },
    events: [{ seq: 1, at: started2, cmd: "SOCKET_OPEN" }],
  });

  // The rotated feed now carries ONLY draft #2's 3 picks.
  const draft2Picks = [
    { playerId: 60000, teamId: 2, price: 40, seq: 0 },
    { playerId: 60001, teamId: 3, price: 30, seq: 1 },
    // Re-uses a player from draft #1 (50000) — a real re-draft can pick the same
    // player. New seq, new team/price.
    { playerId: 50000, teamId: 4, price: 12, seq: 2 },
  ];
  await global._applyDraftFeed({
    leagueId: 1200, sport: "flb", updatedAt: started2, picks: draft2Picks,
  });

  const picks = global._liveDraft.picks;

  // EXPECTED (spec): after a same-league re-draft rotation, the board reflects
  // ONLY draft #2 — 3 picks. draft #1's 20 stale picks must be gone.
  if (picks.length > 3) {
    bad("_liveDraft.picks still holds " + picks.length + " picks after a same-league " +
      "re-draft rotation — draft #1's picks were never cleared (expected 3, the new draft's).");
  }

  // Player 50000 was re-drafted in draft #2 to a NEW team (espn id 4 → glix) for
  // $12. Because the stale draft-#1 pick for 50000 (team 1 → matt, $5) is still
  // present, processEspnPicks' existing.has(50000) SWALLOWED the re-draft: the
  // board shows the WRONG owner/price for 50000.
  const p50000 = picks.filter((p) => p.espnPlayerId === 50000);
  if (p50000.length && p50000[0].espnSeq === 0) {
    bad("player 50000 re-drafted in draft #2 (new seq 2, team glix, $12) was swallowed — " +
      "the board still shows the stale draft-#1 sale (seq " + p50000[0].espnSeq +
      ", team " + p50000[0].team + ", $" + p50000[0].price + ").");
  }

  if (!failed) {
    log.log("OK — app-side pick list rotated correctly on same-league re-draft.");
    process.exit(0);
  }
  log.error("\nSpec violated: S-060 / S-062 / S-101 / S-102 — the same-league re-draft " +
    "rotation resets the extension feed and _dlog.events but NOT _liveDraft.picks, so the " +
    "prior draft contaminates the new one (mis-attributed picks + wrong budgets/inflation).");
  process.exit(1);
})();
