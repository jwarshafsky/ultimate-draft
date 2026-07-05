// p2r2-interact-2 — STALE-HEAL (mechanism a) × STREAM-ROTATION (mechanism b/e):
// a same-league rotation clears the pick list but NOT the retained stale feed, so
// the closed→open heal re-ingests the OLD draft's picks onto the new board.
//
// INTERACTION TRACE:
//   1. Draft #1's capture goes stale (>15 min, no ESPN tab). _applyDraftFeed sets
//      _feed.staleInfo AND _feed.staleRetained = <draft #1's whole feed>, and
//      returns without ingesting (staleness gate, S-051). The heal path (P2R1
//      state-3 fix) keeps staleRetained so a later tab-open can re-apply it.
//   2. A NEW draft #2 starts on the SAME league. Its event stream arrives; the
//      P2R1 state-1 fix in _onDraftEvents sees a new (leagueId,startedAt),
//      CLEARS _liveDraft.picks/deleted and adopts the new streamKey.
//      BUT it does NOT clear _feed.staleInfo / _feed.staleRetained — those still
//      point at draft #1's feed.
//   3. The ESPN tab opens (closed→open, fresh beat). _onDraftTabPresent sees
//      _feed.staleInfo still set → heal: it re-applies _feed.staleRetained via
//      _applyDraftFeed. _applyDraftFeed has NO stream-identity awareness (the
//      state-1 guard lives only in _onDraftEvents), so draft #1's OLD picks are
//      ingested onto draft #2's freshly-rotated board.
//
//   Result: the rotation's whole purpose — a clean board for draft #2 — is
//   undone one tab-open later. Draft #1's players sit on draft #2's board:
//   off the pool, their prices counting toward spent/inflation, mis-attributed.
//
// USER-VISIBLE HARM: after re-running a mock (or a restarted real draft room) and
//   opening the ESPN tab, the previous draft's picks silently reappear — wrong
//   budgets/inflation and hidden players for the whole new draft, needing a manual
//   "Clear captured feed" + reset to recover (violates the ≤1-click / automatic
//   recovery bar).
//
// VIOLATES: S-060/S-062 (a rotated same-league re-draft must give a fresh board —
//   the heal must respect the rotation), the Round-5 stream-identity amendment
//   (a rotation clears picks+tombstones — the retained feed is part of that
//   stream and must go too), S-101/S-102 (pool partition / pick ceiling),
//   S-053 clarification (tab open re-applies the CURRENT feed, not a rotated-away
//   one).
//
// This script exits NONZERO while the bug exists.

const H = require("./_apploader.js");
H.install();
const log = H.realConsole;

// The apploader stubs setTimeout to a no-op; restore real timers so
// _applyDraftFeed's internal awaits (_ensureEspnNames) and the heal's
// fire-and-forget _applyDraftFeed can complete.
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

(async function run() {
  H.setRealMode();
  H.resetDraftState();
  global.fetchEspnPlayers = async () => ({ players: [] });
  global._espnIdToName = { 50000: "Old Star", 50001: "Old Guy" };

  // --- 1) draft #1 stale capture retained (no ESPN tab) ---
  global._feed.tabAt = 0;
  global._liveDraft.streamKey = "1200:1000";   // draft #1's stream identity
  const s1 = Date.now() - 20 * 60 * 1000;       // 20 min ago (> 15-min gate)
  await global._applyDraftFeed({
    leagueId: 1200, sport: "flb", updatedAt: s1,
    picks: [
      { playerId: 50000, teamId: 1, price: 5, seq: 0, ts: s1 },
      { playerId: 50001, teamId: 2, price: 6, seq: 1, ts: s1 },
    ],
  });
  if (!global._feed.staleInfo || !global._feed.staleRetained || global._liveDraft.picks.length !== 0) {
    log.error("(setup) expected a stale-gated capture (staleInfo+staleRetained set, 0 picks ingested); got " +
      "staleInfo=" + !!global._feed.staleInfo + " retained=" + !!global._feed.staleRetained +
      " picks=" + global._liveDraft.picks.length);
  }

  // --- 2) draft #2 begins on the SAME league — events rotate the app ---
  const s2 = Date.now();
  global._onDraftEvents({
    full: true, log: { leagueId: 1200, sport: "flb", startedAt: 2000 },
    events: [{ seq: 1, at: s2, cmd: "SOCKET_OPEN" }],
  });
  const rotated = global._liveDraft.streamKey === "1200:2000" && global._liveDraft.picks.length === 0;
  if (!rotated) {
    log.error("(setup) expected the rotation to clear picks + adopt streamKey 1200:2000; got streamKey=" +
      global._liveDraft.streamKey + " picks=" + global._liveDraft.picks.length);
  }

  // --- 3) the ESPN tab opens (closed→open, fresh beat) → heal fires ---
  global._onDraftTabPresent({ at: Date.now(), leagueId: 1200, sport: "flb" });
  // heal calls _applyDraftFeed(retained) fire-and-forget; drain microtasks.
  for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));

  // Draft #1's picks are ids 50000/50001; anything from that stream on draft #2's
  // board is contamination (whatever name they resolved to).
  const contaminated = global._liveDraft.picks.filter(p => p.espnPlayerId === 50000 || p.espnPlayerId === 50001);

  if (contaminated.length) {
    log.error("BUG PRESENT: after the same-league rotation cleared the board, the tab-open heal " +
      "re-ingested draft #1's OLD picks (ids " + contaminated.map(p => p.espnPlayerId).join(", ") +
      ", '" + contaminated.map(p => p.player).join("', '") + "') onto draft #2's board — " +
      "_feed.staleRetained survived the rotation and _applyDraftFeed has no streamKey guard.");
    log.error("\nSpec violated: S-060 / S-062 / Round-5 stream-identity amendment / S-101 / S-053 — " +
      "the stale-heal (a) and the same-league rotation (b) interact: the rotation clears " +
      "_liveDraft.picks but leaves _feed.staleInfo/staleRetained pointing at the old draft, and the " +
      "heal path re-applies that retained feed with no stream check.");
    process.exit(1);
  }

  log.log("OK — the rotation's retained stale feed did not re-contaminate the new draft.");
  process.exit(0);
})();
