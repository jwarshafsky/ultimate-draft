// p2r2-interact-1 — PURGE-ON-REAL (mechanism b) × STREAM IDENTITY (mechanism e):
// a TEST-mode mock played ON THE HOME LEAGUE (1200) is NOT purged when Jeff
// switches to Real, so its picks contaminate the real-league board.
//
// INTERACTION TRACE (setFeedMode purge  ×  streamKey home-league guard):
//   setFeedMode("real") purges leftover mock picks ONLY when the pick list's
//   streamKey does NOT start with "<HOME>:" (draft.js ~L748):
//       if (!_liveDraft.streamKey.startsWith(home + ":")) { picks = []; ... }
//   The guard exists so a REAL draft's own picks (streamKey "1200:…") aren't
//   wiped on a mode toggle. But test mode accepts ANY league id (spec S-010),
//   and a mock CAN run on league 1200 — ESPN's own pre-draft mock lobby for the
//   league, or a practice capture Jeff points at 1200. Such a mock's picks are
//   recorded on generic "espn:N" teams (test-mode isolation, S-016) and carry
//   streamKey "1200:<startedAt>". Because that DOES start with "1200:", the
//   purge is SKIPPED and the mock picks survive into Real mode.
//
// USER-VISIBLE HARM (draft day): the surviving picks are on "espn:N" teams that
//   match NO real owner (LEAGUE.teams have no espnTeamId), so their $ lands on
//   nobody's ledger — exactly the "$2413 of mock spending attributed to nobody"
//   the purge was written to prevent. Worse, they are counted GLOBALLY by name:
//   - computeLiveInflation counts their price as spent + drops their value from
//     remainingValue → the live inflation multiplier Jeff bids against is wrong;
//   - availableDraftPool / getDraftedNames mark those real players DRAFTED →
//     they vanish from the board (Jeff can't nominate players who are still
//     available), and show as phantom "espn:N" picks in Recent Picks.
//
// VIOLATES: S-008/S-019 (Real mode uses only real owners; no mock attribution),
//   the Round-5 amendment ("a cross-league switch clears _liveDraft.picks +
//   tombstones") — the SAME safety must hold for a same-(home-)league mock→real
//   switch, S-100/S-101 (pool partition), S-097/S-098 (inflation from real
//   spending only), S-018 (no espn:N owner strings leaking into real context).
//
// This script exits NONZERO while the bug exists.

const H = require("./_apploader.js");
const { VALUES } = H.install();
const log = H.realConsole;

let failed = false;
function bad(msg) { log.error("BUG PRESENT: " + msg); failed = true; }

(function run() {
  // ---- A TEST-mode mock is captured on the HOME league (1200) ----
  H.setTestMode();
  H.resetDraftState();
  global._feed.tabAt = Date.now();   // mock ESPN tab open (not the subject here)

  // Two REAL value-pool players get mock-drafted (so pool/inflation harm is
  // measurable), attributed to generic espn:N teams per test-mode isolation.
  const started = 5000;
  global._liveDraft.streamKey = "1200:" + started;
  global._liveDraft.picks.push(
    { player: "Mookie Betts", pos: "OF", team: "espn:3", espnTeamId: 3, price: 40, ts: Date.now(), espnPlayerId: 70001, espnSeq: 2 },   // non-keeper (Judge is keeper-checked in the loader fixture)
    { player: "Gerrit Cole", pos: "SP", team: "espn:7", espnTeamId: 7, price: 25, ts: Date.now(), espnPlayerId: 70002, espnSeq: 3 },
  );
  global.saveLiveDraft();

  if (global._liveDraft.picks.length !== 2) {
    log.error("(setup) expected 2 mock picks, got " + global._liveDraft.picks.length);
  }

  // ---- Jeff switches to REAL mode for the actual draft ----
  global.setFeedMode("real");

  // EXPECTED: entering Real mode purges mock leftovers (same as a cross-league
  // switch). The board must start clean for the real draft.
  const survived = global._liveDraft.picks.length;
  if (survived > 0) {
    bad(survived + " mock picks survived into Real mode — the purge's home-league guard " +
      "(streamKey.startsWith(\"1200:\")) skips a mock that ran ON league 1200.");
  }

  // Attribution harm: espn:N teams match no real owner → picks land on nobody,
  // but their money + player value still distort the shared inflation/pool math.
  const orphaned = global._liveDraft.picks.filter(p => String(p.team).startsWith("espn:"));
  if (orphaned.length) {
    bad(orphaned.length + " surviving picks are on generic espn:N teams in REAL mode " +
      "(owners: " + orphaned.map(p => p.team).join(", ") + ") — attributed to no real leaguemate.");
  }

  // Pool/inflation harm: the two real players are wrongly OFF the board.
  const pool = new Set(global.availableDraftPool().map(p => p.name));
  if (!pool.has("Mookie Betts") || !pool.has("Gerrit Cole")) {
    const gone = ["Mookie Betts", "Gerrit Cole"].filter(n => !pool.has(n));
    bad("real players still available are HIDDEN from the draft board (" + gone.join(", ") +
      ") — the leftover mock picks mark them drafted; live inflation counts their $65 as spent.");
  }

  if (!failed) {
    log.log("OK — a home-league mock is purged on entering Real mode; board clean.");
    process.exit(0);
  }
  log.error("\nSpec violated: Round-5 clear-on-switch amendment / S-008 / S-019 / S-100 / S-101 / S-097 — " +
    "setFeedMode('real')'s streamKey home-league guard has a blind spot: a TEST mock captured on " +
    "league 1200 is not purged, so mock spending + drafted players leak into the real-league board.");
  process.exit(1);
})();
