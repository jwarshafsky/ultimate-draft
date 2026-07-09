// R15 EPHEMERAL write-log INVENTORY (the required proof of ephemerality).
//
// For every mock lifecycle scenario, this records EVERY localStorage write, every
// key the REAL cloud-sync patch queued for a Cloudflare-KV push, every Supabase
// stub call, and the draft-log upload queue — then prints a scenario → keys → verdict
// table and a full-state diff (all storage + _liveDraft/_dlog/_feed) across a mock.
//
// VERDICT rule (from the spec):
//   • ud_saved_mocks_v1 written ONLY on an explicit Save → OK (user-authored keepsake)
//   • ud_draft_mode_v1 / ud_dm_layout_v1 written on Enter/Exit Draft Mode or layout
//     drag → OK (device-local view state, user-authored, not synced)
//   • ANY draft-STATE write (ud_live_draft_v1, ud_live_draft_mock_v1, ud_feed_mode,
//     ud_league_override, ud_test_my_team, ud_draft_events_v1, ud_draft_sessions_v1)
//     during a mock → FINDING (residue)
//   • ANY cloud-sync dirty/deleted entry during a mock → FINDING (crosses devices)
//   • ANY Supabase write during a mock → FINDING (bot data in the DB)
//
// Exits nonzero if any scenario's write set violates the rule (so it doubles as a
// regression gate). No app source touched.

const { makeSandbox, drain } = require("./r15-eph-instrument.js");

// keys that are ALWAYS residue if written during/around a mock
const DRAFT_STATE_KEYS = new Set([
  "ud_live_draft_v1", "ud_live_draft_bk_v1",
  "ud_live_draft_mock_v1", "ud_live_draft_mock_bk_v1",
  "ud_feed_mode", "ud_league_override", "ud_test_my_team",
  "ud_draft_events_v1", "ud_draft_sessions_v1",
]);
// keys that are OK (user-authored / explicit)
const OK_ON_SAVE = new Set(["ud_saved_mocks_v1"]);
const OK_VIEW_STATE = new Set(["ud_draft_mode_v1", "ud_dm_layout_v1"]);

let FAILS = 0;
const rows = [];

// Run one scenario. `body(h, ud)` performs the actions with recording ON. Returns
// the write inventory. `expect` optionally names keys that are legitimately written.
async function scenario(name, body, expectOk) {
  expectOk = expectOk || new Set();
  const h = makeSandbox(7);
  const { ud } = h;
  h.startRecording();
  await body(h, ud);
  await drain(); await drain();
  h.stopRecording();

  const writes = [...new Set(h.writeLog.map(w => w.op + ":" + w.key))];
  const writtenKeys = [...new Set(h.writeLog.map(w => w.key))];
  const cloud = h.snapshotCloud();
  const supa = h.supabaseWrites.length;
  const dlogQueue = ud.draftLog ? ud.draftLog.queue.length : 0;
  const dlogSess = ud.draftLog ? ud.draftLog.sessionId : null;

  // classify
  const findings = [];
  for (const k of writtenKeys) {
    if (DRAFT_STATE_KEYS.has(k) && !expectOk.has(k)) findings.push("wrote draft-state key " + k);
    else if (!OK_ON_SAVE.has(k) && !OK_VIEW_STATE.has(k) && !expectOk.has(k) && !DRAFT_STATE_KEYS.has(k)) {
      // unexpected non-draft key — surface it (could be notes/inflation/etc.)
      findings.push("wrote unexpected key " + k);
    }
  }
  for (const k of cloud.dirty) if (!expectOk.has(k)) findings.push("cloud-sync would PUSH " + k);
  for (const k of cloud.deleted) if (!expectOk.has(k)) findings.push("cloud-sync would DELETE " + k);
  if (supa > 0) findings.push(supa + " Supabase write(s)");

  const verdict = findings.length ? "FINDING" : "EPHEMERAL";
  if (findings.length) FAILS++;
  rows.push({ name, writes, cloud: [...cloud.dirty, ...cloud.deleted.map(k => "-" + k)], supa, dlogQueue, dlogSess, verdict, findings });

  // print per-scenario detail
  const tag = verdict === "EPHEMERAL" ? "\x1b[32mEPHEMERAL\x1b[0m" : "\x1b[31mFINDING\x1b[0m";
  console.log("\n[" + tag + "] " + name);
  console.log("   localStorage writes : " + (writes.length ? writes.join(", ") : "(none)"));
  console.log("   cloud-sync queued   : " + (cloud.dirty.length || cloud.deleted.length ? JSON.stringify({ push: cloud.dirty, del: cloud.deleted }) : "(none)"));
  console.log("   supabase writes     : " + supa + "   · draft-log queue: " + dlogQueue + "  sessionId: " + (dlogSess || "null"));
  if (findings.length) {
    console.log("   \x1b[31m! " + findings.join("; ") + "\x1b[0m");
    // show stacks for draft-state / cloud / supabase writes
    for (const w of h.writeLog) if (DRAFT_STATE_KEYS.has(w.key)) console.log("     write " + w.op + " " + w.key + "  @ " + w.stack);
    for (const s of h.supabaseWrites) console.log("     supabase " + s.table + "." + s.op + "  @ " + s.stack);
  }
  return { h, ud, writes, cloud, supa };
}

// helpers reused across scenarios
function seedRealDraft(ud) {
  ud.eval(
    "setLeagueOverride(''); setFeedMode('real'); " +
    "_liveDraft.picks=[{player:'Real Star', team:'jeff', price:30, ts:1}]; " +
    "_liveDraft.deleted={}; _liveDraft.streamKey='1200:1'; saveLiveDraft();"
  );
}

async function fullState(ud) {
  // snapshot the observable draft state for the deep-diff
  return {
    liveDraft: JSON.parse(ud.eval("JSON.stringify(_liveDraft)")),
    dlog: JSON.parse(ud.eval("JSON.stringify({events:_dlog.events.length, leagueId:_dlog.leagueId, startedAt:_dlog.startedAt, initState:_dlog.initState})")),
    feed: ud.feed ? JSON.parse(ud.eval("JSON.stringify({connected:_feed.connected, count:_feed.count, staleInfo:_feed.staleInfo, staleRetained:_feed.staleRetained})")) : null,
    storage: JSON.parse(ud.eval("JSON.stringify(Object.keys(globalThis).length ? {} : {})")), // placeholder
  };
}

(async () => {
  // ============ SCENARIO GROUP A: speeds ============
  for (const speed of ["1x", "4x", "instant"]) {
    await scenario("full mock @ " + speed + " (start → skip to end, stay finished)", async (h, ud) => {
      ud.eval("_mockFeed.speed='" + speed + "'; startMockFeed(); skipMockToEnd();");
    });
  }

  // ============ SCENARIO GROUP B: skip controls ============
  await scenario("skip: lot / N / to-end sequence", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockNomination(); skipMockPicks(5); skipMockPicks(20); skipMockToEnd();");
  });

  // ============ SCENARIO GROUP C: stop-then-save ============
  // REALISTIC (separate clicks — a drain between skip and Save lets the async
  // pick-adds settle, as the event loop would between two DOM clicks).
  await scenario("stop → Save & clear [REALISTIC: drained between clicks]", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockPicks(10);");
    await drain(); await drain();   // pick-adds settle before the next click
    ud.eval("stopMockFeed();");
    await drain();
    ud.eval("saveAndClearMock();");
  }, new Set(["ud_saved_mocks_v1"]));

  // SAME-TASK RACE (skip + stop + save in ONE synchronous task — the async
  // pick-add outlives the tear-down → residue). This is the R15-EPH-1 finding.
  await scenario("stop → Save & clear [RACE: one synchronous task]", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockPicks(10); stopMockFeed(); saveAndClearMock();");
  }, new Set(["ud_saved_mocks_v1"]));

  // ============ SCENARIO GROUP D: stop-then-clear ============
  await scenario("stop → Clear (discard) [REALISTIC: drained]", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockPicks(10);");
    await drain(); await drain();
    ud.eval("stopMockFeed();");
    await drain();
    ud.eval("clearMockDraft();");
  });
  await scenario("stop → Clear (discard) [RACE: one synchronous task]", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockPicks(10); stopMockFeed(); clearMockDraft();");
  });

  // ============ SCENARIO GROUP E: second mock over first ============
  await scenario("start second mock over a running first", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockPicks(8); startMockFeed(); skipMockPicks(8);");
  });

  // ============ SCENARIO GROUP F: leave to another view mid-mock ============
  await scenario("leave to another view mid-mock (currentView flip)", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockPicks(5); currentView='overview'; skipMockPicks(5);");
  });

  // ============ SCENARIO GROUP G: app 'reload' mid-mock (sandbox rebuild) ============
  // A real reload rebuilds the world: the mock is GONE (in-memory only), the app
  // re-runs loadLiveDraft() at load. Assert the reloaded world has NO mock residue.
  {
    const h = makeSandbox(7);
    const { ud } = h;
    seedRealDraft(ud);
    h.startRecording();
    ud.eval("startMockFeed(); skipMockPicks(15);");   // mock running, unsaved
    await drain();
    // capture disk state a reload would read
    const diskLive = ud.eval("localStorage.getItem('ud_live_draft_v1')");
    const diskMock = ud.eval("localStorage.getItem('ud_live_draft_mock_v1')");
    const diskEvents = ud.eval("localStorage.getItem('ud_draft_events_v1')");
    const diskSessions = ud.eval("localStorage.getItem('ud_draft_sessions_v1')");
    h.stopRecording();
    console.log("\n[reload sim] app 'reload' mid-mock — what a fresh load would read from disk:");
    console.log("   ud_live_draft_v1      = " + (diskLive || "null"));
    console.log("   ud_live_draft_mock_v1 = " + (diskMock || "null"));
    console.log("   ud_draft_events_v1    = " + (diskEvents ? "(present)" : "null"));
    console.log("   ud_draft_sessions_v1  = " + (diskSessions ? "(present)" : "null"));
    const realParsed = diskLive ? JSON.parse(diskLive) : null;
    const realOK = realParsed && realParsed.picks && realParsed.picks.length === 1 && realParsed.picks[0].player === "Real Star";
    const noResidue = !diskMock && !diskEvents && !diskSessions;
    const ok = realOK && noResidue;
    console.log("   verdict: " + (ok ? "\x1b[32mEPHEMERAL (reload sees only the intact real draft; no mock residue on disk)\x1b[0m" : "\x1b[31mFINDING\x1b[0m"));
    if (!ok) { FAILS++; console.log("   ! realOK=" + realOK + " noResidue=" + noResidue); }
    rows.push({ name: "app reload mid-mock (disk residue)", writes: ["(disk check)"], cloud: [], supa: 0, verdict: ok ? "EPHEMERAL" : "FINDING", findings: ok ? [] : ["mock residue survived a reload"] });
  }

  // ============ SCENARIO GROUP H: Enter/Exit Draft Mode mid-mock ============
  // setDraftMode writes DM_KEY (device-local view state, not synced — OK) before
  // it calls renderDraft(); we only need the write side, so stub render to a no-op.
  await scenario("Enter/Exit Draft Mode mid-mock (ud_draft_mode_v1 view-state OK)", async (h, ud) => {
    ud.eval("renderDraft = function(){};");
    ud.eval("startMockFeed(); skipMockPicks(5); setDraftMode(true); skipMockPicks(5); setDraftMode(false);");
  }, new Set(["ud_draft_mode_v1"]));

  // ============ SCENARIO GROUP I: mode flips to real/off mid-mock ============
  // REALISTIC (drained before the mode-flip click): only user-authored keys
  // (ud_feed_mode, ud_league_override) written; the real draft is restored intact.
  await scenario("mode flip to 'off' mid-mock [REALISTIC: drained]", async (h, ud) => {
    seedRealDraft(ud);
    h.resetLog();
    ud.eval("startMockFeed(); skipMockPicks(8);");
    await drain(); await drain();
    ud.eval("setFeedMode('off');");
  }, new Set(["ud_feed_mode", "ud_league_override", "ud_live_draft_v1"]));
  await scenario("mode flip to 'real' mid-mock [REALISTIC: drained]", async (h, ud) => {
    seedRealDraft(ud);
    h.resetLog();
    ud.eval("startMockFeed(); skipMockPicks(8);");
    await drain(); await drain();
    ud.eval("setFeedMode('real');");
  }, new Set(["ud_feed_mode", "ud_league_override", "ud_live_draft_v1"]));
  // RACE (mode-flip while a fast-forward's pick-adds are still pending — same
  // async gap as the stop/clear RACE, but here the flip ALSO routes the write to
  // the real synced key → the mock's picks clobber the real draft): R15-EPH-1.
  await scenario("mode flip to 'real' mid-mock [RACE: pick-add pending]", async (h, ud) => {
    seedRealDraft(ud);
    h.resetLog();
    ud.eval("startMockFeed(); skipMockPicks(8); setFeedMode('real');");   // no drain — pick-adds outlive the flip
  }, new Set(["ud_feed_mode", "ud_league_override"]));

  // ============ SCENARIO GROUP J: timer edge pause→speed→resume ============
  await scenario("timer edge: pause → speed change → resume → skip to end", async (h, ud) => {
    ud.eval("startMockFeed(); skipMockPicks(5); pauseMockFeed(); setMockFeedSpeed('1x'); resumeMockFeed(); skipMockToEnd();");
  });

  // ============ SCENARIO GROUP K: the DEEP DIFF — snapshot all state before, clear, diff after ============
  {
    const h = makeSandbox(7);
    const { ud } = h;
    seedRealDraft(ud);
    // snapshot BEFORE
    const before = {
      storage: JSON.parse(JSON.stringify(h.localStore)),
      live: ud.eval("JSON.stringify(_liveDraft)"),
      dlog: ud.eval("JSON.stringify({e:_dlog.events.length,l:_dlog.leagueId,s:_dlog.startedAt,i:_dlog.initState})"),
      feed: ud.feed ? ud.eval("JSON.stringify({c:_feed.connected,n:_feed.count,si:_feed.staleInfo||null,sr:_feed.staleRetained||null})") : "null",
    };
    h.startRecording();
    ud.eval("_mockFeed.speed='instant'; startMockFeed(); skipMockToEnd();");
    await drain(); await drain();
    ud.eval("clearMockDraft();");
    await drain();
    h.stopRecording();
    const after = {
      storage: JSON.parse(JSON.stringify(h.localStore)),
      live: ud.eval("JSON.stringify(_liveDraft)"),
      dlog: ud.eval("JSON.stringify({e:_dlog.events.length,l:_dlog.leagueId,s:_dlog.startedAt,i:_dlog.initState})"),
      feed: ud.feed ? ud.eval("JSON.stringify({c:_feed.connected,n:_feed.count,si:_feed.staleInfo||null,sr:_feed.staleRetained||null})") : "null",
    };
    const diffs = [];
    const allKeys = new Set([...Object.keys(before.storage), ...Object.keys(after.storage)]);
    for (const k of allKeys) if (before.storage[k] !== after.storage[k]) diffs.push("storage[" + k + "]: " + (before.storage[k] || "∅") + " → " + (after.storage[k] || "∅"));
    if (before.live !== after.live) diffs.push("_liveDraft changed: " + before.live + " → " + after.live);
    if (before.dlog !== after.dlog) diffs.push("_dlog changed: " + before.dlog + " → " + after.dlog);
    if (before.feed !== after.feed) diffs.push("_feed changed: " + before.feed + " → " + after.feed);
    const ok = diffs.length === 0;
    console.log("\n[deep diff] full mock + clearMockDraft — before vs after (should be IDENTICAL):");
    if (ok) console.log("   \x1b[32mEPHEMERAL — zero delta across storage / _liveDraft / _dlog / _feed\x1b[0m");
    else { FAILS++; console.log("   \x1b[31mFINDING — deltas:\x1b[0m"); diffs.forEach(d => console.log("     • " + d)); }
    rows.push({ name: "deep diff: full mock + clear restores pre-mock state", writes: ["(diff)"], cloud: [], supa: 0, verdict: ok ? "EPHEMERAL" : "FINDING", findings: diffs });
  }

  // ============ SUMMARY TABLE ============
  console.log("\n\n================= R15 EPHEMERALITY WRITE-LOG INVENTORY =================");
  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("SCENARIO", 56) + pad("KEYS WRITTEN", 40) + "VERDICT");
  console.log("-".repeat(105));
  for (const r of rows) {
    const keys = (r.writes || []).join(",") || "—";
    console.log(pad(r.name, 56) + pad(keys, 40) + r.verdict);
  }
  console.log("-".repeat(105));
  console.log(FAILS === 0 ? "\x1b[32mALL SCENARIOS EPHEMERAL — the ud-native mock wrote nothing draft-related, synced nothing, hit no DB.\x1b[0m"
    : "\x1b[31m" + FAILS + " scenario(s) leaked residue.\x1b[0m");

  process.exit(FAILS === 0 ? 0 : 1);
})().catch(e => { console.error("inventory crashed:", e && e.stack || e); process.exit(2); });
