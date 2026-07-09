// R15-EPH-1 — CONFIRMED FINDING: a fast-forward / live-playback SOLD's in-flight
// async pick-add (_applyDraftFeed → processEspnPicks → saveLiveDraft) can resolve
// AFTER the mock has been torn down (clearMockDraft / setFeedMode sets
// _mockFeed.active=false), so saveLiveDraft() no longer no-ops — it writes the
// mock's SYNTHETIC picks to the REAL, cloud-synced ud_live_draft_v1 key, clobbering
// the real draft on disk and pushing that residue to Cloudflare KV. This is the
// SAME residue-clobber class Rounds 8–10 fixed, resurrected by the async gap
// between "emit SOLD (unawaited)" and "tear down".
//
// Root cause: saveLiveDraft() gates on mockFeedActive() at WRITE time, but the
// mock's pick-add is dispatched asynchronously and its saveLiveDraft runs a
// microtask later — by then active can already be false. The gate must be
// captured/held until the async add completes (or clearMockDraft must not flip
// active=false while _applyDraftFeed promises are pending).
//
// Exits nonzero (real draft on disk clobbered by mock picks) — a failing repro.

const { makeSandbox, drain } = require("./r15-eph-instrument.js");

let FAIL = 0;
function check(cond, msg) { if (!cond) { FAIL++; console.error("  FAIL: " + msg); } else console.log("  ok: " + msg); }

(async () => {
  const h = makeSandbox(7);
  const { ud } = h;

  // 1) A real draft exists on disk, one pick.
  ud.eval(
    "setLeagueOverride(''); setFeedMode('real'); " +
    "_liveDraft.picks=[{player:'Real Star', team:'jeff', price:30, ts:1}]; " +
    "_liveDraft.deleted={}; _liveDraft.streamKey='1200:1'; saveLiveDraft();"
  );
  const realBefore = JSON.parse(ud.eval("localStorage.getItem('ud_live_draft_v1')"));
  console.log("real draft on disk before mock:", realBefore.picks.map(p => p.player + "/" + p.team));

  // 2) Start a practice mock and drive live playback THROUGH a SOLD frame the way
  //    _mfScheduleNext does — _mfApplyFrame is called and its returned
  //    _applyDraftFeed promise is NOT awaited (a pending microtask).
  ud.eval("setFeedMode('test'); setLeagueOverride('990001'); _mockFeed.speed='instant'; startMockFeed();");
  ud.eval(
    "(function(){ var s=_mockFeed.script, i=0;" +
    " while(i<s.frames.length){ var fr=s.frames[i]; _mfApplyFrame(_mockFeed.ctx, fr, globalThis.Date.now());" +
    "   _mockFeed.idx=++i; if(fr.cmd==='SOLD'){ _mockFeed.soldLots++; break; } } })();"
  );

  // 3) SINGLE user gesture: flip the feed mode back to Real. setFeedMode() calls
  //    clearMockDraft() synchronously (draft.js:769) → _mockFeed.active=false.
  h.startRecording();
  ud.eval("setFeedMode('real');");

  // 4) NOW the pending _applyDraftFeed microtask resolves → processEspnPicks →
  //    saveLiveDraft with mockFeedActive()===false → writes to the REAL key.
  await drain(); await drain();

  const realAfter = JSON.parse(ud.eval("localStorage.getItem('ud_live_draft_v1')"));
  console.log("real draft on disk AFTER the mode flip:", realAfter.picks.map(p => p.player + "/" + p.team));

  const writes = [...new Set(h.writeLog.map(w => w.op + ":" + w.key))];
  console.log("writes after tear-down:", writes);
  console.log("cloud-sync would push:", h.snapshotCloud().dirty);

  // Assertions: the real draft must be UNCHANGED and no mock pick may reach the real key.
  const realIntact = JSON.stringify(realAfter.picks) === JSON.stringify(realBefore.picks);
  check(realIntact, "real ud_live_draft_v1 unchanged by the torn-down mock");
  const hasMockPick = realAfter.picks.some(p => typeof p.team === "string" && p.team.indexOf("espn:") === 0 || /^Player 9\d{5}$/.test(p.player || ""));
  check(!hasMockPick, "no synthetic mock pick landed on the real key");
  const wroteRealKey = writes.includes("set:ud_live_draft_v1");
  check(!wroteRealKey || realIntact, "saveLiveDraft did not clobber the real key with mock state");

  if (FAIL) {
    console.error("\nR15-EPH-1: RESIDUE-CLOBBER CONFIRMED — a mock's async pick-add wrote to the real synced draft key after tear-down.");
    process.exit(1);
  }
  console.log("\nR15-EPH-1: clean (no residue).");
})().catch(e => { console.error("crashed:", e && e.stack || e); process.exit(2); });
