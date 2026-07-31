// Extension pipeline tests — loads the THREE REAL Keeper Edge files
// (draft-socket-capture.js MAIN world, draft-bridge.js ESPN-tab isolated world,
// ud-bridge.js app-tab isolated world), drives fake ESPN socket frames and
// storage flushes, and asserts what lands in chrome.storage / postMessage.
//
// Nothing here modifies extension source; it is read + eval'd via loadScript.
//
// TIMING MODEL: draft-bridge queues work behind an async chrome.storage.get
// (setImmediate) and flushes picks synchronously-within-that-continuation. So
// after driving frames we `await drain()` (a few setImmediate ticks) before
// inspecting the store. setInterval/pagehide are captured so we can invoke
// flushNow / pagehide deterministically instead of waiting on wall-clock.

const {
  test, section, summary, assert, assertEq, assertDeep,
  makeChromeStub, makeWindowStub, loadScript,
} = require("./helpers.js");

const EXT = process.env.KEEPER_EDGE_DIR || require("path").join(require("os").homedir(), "dev", "keeper-edge-extension") + "/";

// Let all pending setImmediate/Promise callbacks run.
function drain(ticks = 6) {
  return new Promise((res) => {
    let n = 0;
    const step = () => (++n >= ticks ? res() : setImmediate(step));
    setImmediate(step);
  });
}

// ---------------------------------------------------------------------------
// A fresh, fully-wired ESPN-tab environment: socket-capture + draft-bridge
// loaded into one global context, with a fake WebSocket already tapped and an
// `emit(text)` to push a raw frame. Captured setInterval/timeouts are held so
// tests can trigger flushNow / beat manually.
// ---------------------------------------------------------------------------
function makeEspnTab(opts) {
  opts = opts || {};
  const location = { pathname: opts.pathname || "/baseball/draft", search: opts.search || "?leagueId=1200", origin: "https://x" };
  const win = makeWindowStub({ location });
  const chromeStub = makeChromeStub(opts.storage || {});
  const intervals = [];   // captured setInterval fns (flushNow, beat)
  const timeouts = [];

  // socket-capture reads window.WebSocket; give it a fake that records the tap.
  const wsListeners = {};
  class FakeWS {
    constructor(url) { this.url = url; }
    addEventListener(type, fn) { (wsListeners[type] = wsListeners[type] || []).push(fn); }
  }

  const sandbox = {
    window: win,
    location,
    URLSearchParams,
    chrome: chromeStub.chrome,
    atob: (b) => Buffer.from(b, "base64").toString("binary"),
    TextDecoder,
    DataView, Uint8Array,
    Date,
    console: { log() {}, warn() {}, error() {} },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
  };
  win.WebSocket = FakeWS;
  sandbox.window.WebSocket = FakeWS;

  loadScript(EXT + "draft-socket-capture.js", sandbox);
  loadScript(EXT + "draft-bridge.js", sandbox);

  // open the draft socket through the hooked constructor
  const ws = new win.WebSocket("wss://fantasydraft.espn.com/game-99/JOIN?1=99&2=1200");
  const emit = (text) => (wsListeners.message || []).forEach((fn) => fn({ data: text }));

  return {
    win, chromeStub, store: chromeStub._store, emit,
    flushNow: () => intervals.forEach((fn) => fn()),   // the 700ms coalescer(s)
    pagehide: () => win._fire("pagehide", {}),
    fireStorageChange: (changes) => chromeStub._fireChanged(changes),
  };
}

// Build a synthetic INIT base64 payload using the SAME binary layout draft-bridge
// parses: for each pick, a 24-byte record where relative to a 4-byte BE leagueId
// marker: teamId=+4, slotA=+8, playerId=+12, lineupSlot=+16, price=+20.
function buildInitB64(leagueId, picks) {
  const rec = 24;
  const buf = Buffer.alloc(rec * picks.length);
  picks.forEach((p, i) => {
    const o = i * rec;
    buf.writeUInt32BE(leagueId >>> 0, o + 0);
    buf.writeInt32BE(p.teamId, o + 4);
    buf.writeInt32BE(p.slotA != null ? p.slotA : i, o + 8);
    buf.writeInt32BE(p.playerId, o + 12);
    buf.writeInt32BE(p.lineupSlot != null ? p.lineupSlot : 1, o + 16);
    buf.writeInt32BE(p.price, o + 20);
  });
  return buf.toString("base64");
}

// =====================================================================
section("Extension pipeline — draft-socket-capture + draft-bridge");
// =====================================================================

(async function run() {

  // ---- SOLD parse fields ----
  await (async () => {
    const t = makeEspnTab();
    t.emit("SOLD 6 39832 10 9 0");
    await drain();
    const feed = t.store.udDraftFeed;
    const elog = t.store.udDraftEvents;
    test("SOLD parse: pick lands with playerId/teamId/price/seq", () => {
      assert(feed && feed.picks.length === 1, "one pick");
      const p = feed.picks[0];
      assertEq(p.playerId, 39832, "playerId");
      assertEq(p.teamId, 6, "teamId");
      assertEq(p.price, 9, "price");
      assertEq(p.seq, 10, "lot seq (=SOLD field 3)");
    });
    test("SOLD parse: event log records SOLD with team/player/amount", () => {
      const sold = elog.events.find((e) => e.cmd === "SOLD");
      assert(sold, "SOLD event logged");
      assertEq(sold.teamId, 6); assertEq(sold.playerId, 39832); assertEq(sold.amount, 9);
    });
  })();

  // ---- dedup repeated SOLD (same playerId + seq) ----
  await (async () => {
    const t = makeEspnTab();
    t.emit("SOLD 6 39832 10 9 0");
    t.emit("SOLD 6 39832 10 9 0");   // identical frame — duplicate
    await drain();
    test("dedup: repeated SOLD (same playerId+seq) yields ONE pick", () => {
      assertEq(t.store.udDraftFeed.picks.length, 1);
    });
  })();

  // ---- re-sale replace (same player, new seq) ----
  await (async () => {
    const t = makeEspnTab();
    t.emit("SOLD 6 39832 10 9 0");     // first sale
    t.emit("SOLD 4 39832 25 4 0");     // re-auctioned after undo: new seq → REPLACE
    await drain();
    test("re-sale replace: same player new seq keeps ONE pick, updated team/price/seq", () => {
      const feed = t.store.udDraftFeed;
      assertEq(feed.picks.length, 1, "still one pick");
      assertEq(feed.picks[0].teamId, 4, "team replaced");
      assertEq(feed.picks[0].price, 4, "price replaced");
      assertEq(feed.picks[0].seq, 25, "seq replaced");
      assertEq(String(feed.seen[39832]), "25", "seen map holds newest seq");
    });
  })();

  // ---- event log seq monotonicity + BID extraction ----
  await (async () => {
    const t = makeEspnTab();
    t.emit("NOMINATION 6 39832");
    t.emit("BID 6 39832 5 255 30000");
    t.emit("BID 2 39832 7 253 30000");
    t.emit("SOLD 2 39832 10 7 0");
    await drain();
    const ev = t.store.udDraftEvents.events;
    test("event log: seqs strictly increasing", () => {
      let prev = 0;
      for (const e of ev) { assert(e.seq > prev, "seq " + e.seq + " must exceed " + prev); prev = e.seq; }
    });
    test("event log: BID fields (teamId/playerId/amount) extracted", () => {
      const bid = ev.find((e) => e.cmd === "BID");
      assertEq(bid.teamId, 6); assertEq(bid.playerId, 39832); assertEq(bid.amount, 5);
    });
  })();

  // ---- unknown command captured with raw text ----
  await (async () => {
    const t = makeEspnTab();
    t.emit("UNDO_SOMETHING 6 39832 extra tokens");   // protocol-discovery frame
    await drain();
    t.flushNow();   // non-SOLD/INIT events wait on the 700ms coalescer
    await drain();
    test("unknown command: logged with cmd + raw text (protocol discovery)", () => {
      const u = t.store.udDraftEvents.events.find((e) => e.cmd === "UNDO_SOMETHING");
      assert(u, "unknown frame logged");
      assert(u.text && u.text.indexOf("UNDO_SOMETHING") === 0, "raw text kept");
    });
  })();

  // ---- CLOCK → throttled LIVE only (never stored as an event) ----
  await (async () => {
    const t = makeEspnTab();
    t.emit("CLOCK 1 2 3");
    t.emit("CLOCK 4 5 6");
    await drain();
    test("CLOCK: emits LIVE beat but is NOT stored in the event log", () => {
      const posted = t.win._posted.filter((m) => m.cmd === "LIVE");
      assert(posted.length >= 1, "at least one LIVE beat posted");
      const elog = t.store.udDraftEvents;
      const clockEvents = elog ? elog.events.filter((e) => e.cmd === "CLOCK" || e.cmd === "LIVE") : [];
      assertEq(clockEvents.length, 0, "no CLOCK/LIVE rows in the log");
    });
  })();

  // ---- INIT backfill merge (synthetic base64 via the real binary layout) ----
  await (async () => {
    const t = makeEspnTab();
    const b64 = buildInitB64(1200, [
      { teamId: 6, playerId: 39832, price: 9, slotA: 0 },
      { teamId: 4, playerId: 42404, price: 33, slotA: 1 },
    ]);
    t.emit("INIT " + b64);
    await drain();
    test("INIT backfill: both picks parsed + merged into the feed", () => {
      const feed = t.store.udDraftFeed;
      assert(feed && feed.picks.length === 2, "two backfilled picks, got " + (feed ? feed.picks.length : "none"));
      const ids = feed.picks.map((p) => p.playerId).sort();
      assertDeep(ids, [39832, 42404]);
      assert(feed.picks.every((p) => p.backfill === true), "flagged backfill");
    });
    test("INIT backfill: udDraftInitState stores ESPN's own pick list", () => {
      const st = t.store.udDraftInitState;
      assert(st && st.picks.length === 2, "init state recorded");
    });
  })();

  // ---- SAME-LEAGUE RE-DRAFT rotation ----
  // Stored feed has many picks and is >1h stale; INIT arrives with far fewer →
  // rotate: fresh startedAt, cleared seen/picks, then backfill the new picks.
  await (async () => {
    const oldStarted = 111;
    const staleFeed = {
      leagueId: "1200", sport: "flb", startedAt: oldStarted,
      updatedAt: Date.now() - 2 * 60 * 60 * 1000,   // 2h old
      picks: Array.from({ length: 20 }, (_, i) => ({ playerId: 50000 + i, teamId: 1, price: 1, seq: i })),
      seen: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [50000 + i, i])),
    };
    const staleElog = { leagueId: "1200", sport: "flb", startedAt: oldStarted, nextSeq: 500, events: [] };
    const t = makeEspnTab({ storage: { udDraftFeed: staleFeed, udDraftEvents: staleElog } });
    await drain();   // let the restore-from-storage get() resolve
    const b64 = buildInitB64(1200, [{ teamId: 6, playerId: 39832, price: 9, slotA: 0 }]);
    t.emit("INIT " + b64);
    await drain();
    test("re-draft rotation: fresh draft on same league rotates feed (new startedAt, seen cleared)", () => {
      const feed = t.store.udDraftFeed;
      assert(feed.startedAt !== oldStarted, "startedAt rotated");
      // after rotation the ONLY pick is the new INIT one; the 20 stale picks gone
      assertEq(feed.picks.length, 1, "stale picks dropped");
      assertEq(feed.picks[0].playerId, 39832);
      assert(!feed.seen[50000], "old seen map cleared");
    });
  })();

  // ---- INIT does NOT rotate when feed is fresh (guard against false rotation) ----
  await (async () => {
    const freshFeed = {
      leagueId: "1200", sport: "flb", startedAt: 111,
      updatedAt: Date.now(),   // brand new
      picks: Array.from({ length: 20 }, (_, i) => ({ playerId: 50000 + i, teamId: 1, price: 1, seq: i })),
      seen: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [50000 + i, i])),
    };
    const t = makeEspnTab({ storage: { udDraftFeed: freshFeed, udDraftEvents: { leagueId: "1200", sport: "flb", startedAt: 111, nextSeq: 1, events: [] } } });
    await drain();
    const b64 = buildInitB64(1200, [{ teamId: 6, playerId: 39832, price: 9, slotA: 0 }]);
    t.emit("INIT " + b64);
    await drain();
    test("re-draft guard: a FRESH feed with few INIT picks does NOT rotate", () => {
      assertEq(t.store.udDraftFeed.startedAt, 111, "startedAt unchanged");
      assert(t.store.udDraftFeed.picks.length >= 20, "existing picks retained");
    });
  })();

  // ---- nextSeq += 100 bump on restore-from-storage ----
  await (async () => {
    const t = makeEspnTab({ storage: { udDraftEvents: { leagueId: "1200", sport: "flb", startedAt: 111, nextSeq: 42, events: [] } } });
    await drain();
    t.emit("NOMINATION 6 39832");   // first new event after restore
    await drain();
    t.flushNow();   // NOMINATION is non-flushing — coalesce it out
    await drain();
    test("seq bump: restored nextSeq jumps +100 so reused seqs can't collide", () => {
      // Restored nextSeq 42 → +100 = 142. The FIRST logged event after restore
      // is the SOCKET_OPEN tap (seq 142), so every event seq is >= 142 — proving
      // the counter jumped past the ~42 range the app/Supabase already saw.
      const events = t.store.udDraftEvents.events;
      assert(events.length >= 1, "events logged");
      const minSeq = Math.min(...events.map((e) => e.seq));
      assertEq(minSeq, 142, "first post-restore seq is 142 (42 + 100 bump)");
      const nom = events.find((e) => e.cmd === "NOMINATION");
      assert(nom && nom.seq >= 142, "nomination seq is past the reused range");
    });
  })();

  // ---- pagehide flush ----
  await (async () => {
    const t = makeEspnTab();
    // A BID is a non-flushing event (only SOLD/INIT force flush) — it sits dirty.
    t.emit("BID 6 39832 5 255 30000");
    await drain();
    // Without any flush the BID may not be in storage yet; pagehide must flush it.
    t.pagehide();
    await drain();
    test("pagehide: flushes pending (non-SOLD) events to storage on tab close", () => {
      const elog = t.store.udDraftEvents;
      assert(elog && elog.events.some((e) => e.cmd === "BID"), "BID persisted after pagehide");
    });
  })();

  // ---- clearFeed round trip: ud-bridge removes keys + writes udFeedCleared;
  //      draft-bridge's onChanged drops in-memory copies so a later flush does
  //      NOT resurrect the old data ----
  await (async () => {
    // Shared storage between the two isolated worlds (same chrome.storage.local).
    const shared = makeChromeStub({});
    // ESPN-tab world (draft-bridge) wired to `shared`.
    const espnLoc = { pathname: "/baseball/draft", search: "?leagueId=1200", origin: "https://x" };
    const espnWin = makeWindowStub({ location: espnLoc });
    const espnIntervals = [];
    const wsListeners = {};
    class FakeWS { constructor(u) { this.url = u; } addEventListener(ty, fn) { (wsListeners[ty] = wsListeners[ty] || []).push(fn); } }
    espnWin.WebSocket = FakeWS;
    const espnSandbox = {
      window: espnWin, location: espnLoc, URLSearchParams, chrome: shared.chrome,
      atob: (b) => Buffer.from(b, "base64").toString("binary"), TextDecoder, DataView, Uint8Array, Date,
      console: { log() {}, warn() {}, error() {} },
      setInterval: (fn) => { espnIntervals.push(fn); return espnIntervals.length; }, clearInterval: () => {},
      setTimeout: () => 0, clearTimeout: () => {},
    };
    loadScript(EXT + "draft-socket-capture.js", espnSandbox);
    loadScript(EXT + "draft-bridge.js", espnSandbox);
    new espnWin.WebSocket("wss://fantasydraft.espn.com/game-99/JOIN?1=99&2=1200");
    const espnEmit = (text) => (wsListeners.message || []).forEach((fn) => fn({ data: text }));

    // Two live worlds share ONE node global (an eval artifact; each is its own
    // world in-browser). draft-bridge/ud-bridge read bare `location`/`window`/
    // `chrome`, so before driving a world we re-point those three globals at it.
    const useEspn = () => { global.window = espnWin; global.location = espnLoc; global.chrome = shared.chrome; };
    const useApp = () => { global.window = appWin; global.location = appLoc; global.chrome = shared.chrome; };

    // Capture a pick so there's something to clear (ESPN world active).
    useEspn();
    espnEmit("SOLD 6 39832 10 9 0");
    await drain();
    assert(shared._store.udDraftFeed && shared._store.udDraftFeed.picks.length === 1, "pre-clear: pick captured");

    // App-tab world (ud-bridge) wired to the SAME `shared` storage.
    const appLoc = { origin: "https://jwarshafsky.github.io", pathname: "/", search: "" };
    const appWin = makeWindowStub({ location: appLoc });
    const appSandbox = {
      window: appWin, location: appLoc, chrome: shared.chrome, Date,
      console: { log() {}, warn() {}, error() {} },
      setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    };
    loadScript(EXT + "ud-bridge.js", appSandbox);
    await drain();   // ud-bridge's initial pushAll

    // App asks to clear. ud-bridge listens for {source:"ud-app", type:"clearFeed"}.
    useApp();
    appWin.postMessage({ source: "ud-app", type: "clearFeed" }, appLoc.origin);
    await drain();

    test("clearFeed: ud-bridge removes feed/events keys + writes udFeedCleared", () => {
      assert(shared._store.udDraftFeed === undefined, "udDraftFeed removed");
      assert(shared._store.udDraftEvents === undefined, "udDraftEvents removed");
      assert(shared._store.udFeedCleared, "udFeedCleared marker written");
    });

    // Now a late flush from draft-bridge must NOT resurrect the old feed: its
    // onChanged listener saw udFeedCleared and nulled its in-memory copies.
    await drain();   // let draft-bridge's onChanged(udFeedCleared) fire first
    useEspn();
    espnIntervals.forEach((fn) => fn());   // trigger flushNow
    await drain();
    test("clearFeed non-resurrection: a later flush does NOT rewrite the cleared feed", () => {
      assert(shared._store.udDraftFeed === undefined, "feed stays gone after flush");
    });
  })();

  // =====================================================================
  section("Extension pipeline — ud-bridge delta forwarding");
  // =====================================================================

  // ud-bridge forwards draftEvents as a FULL push on a new stream, then DELTAS
  // (events with seq > last-forwarded) on subsequent flushes of the same stream.
  await (async () => {
    const shared = makeChromeStub({
      udDraftEvents: { leagueId: "1200", sport: "flb", startedAt: 111, updatedAt: 1, events: [{ seq: 1, cmd: "BID" }, { seq: 2, cmd: "SOLD" }] },
    });
    const loc = { origin: "https://jwarshafsky.github.io", pathname: "/", search: "" };
    const win = makeWindowStub({ location: loc });
    const sandbox = {
      window: win, location: loc, chrome: shared.chrome, Date,
      console: { log() {}, warn() {}, error() {} },
      setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    };
    loadScript(EXT + "ud-bridge.js", sandbox);
    await drain();   // initial pushAll(true) full push of the pre-seeded stream

    // flush #1: SAME stream, add seq 3 → delta should be ONLY seq 3
    shared._fireChanged({ udDraftEvents: { newValue: { leagueId: "1200", sport: "flb", startedAt: 111, updatedAt: 2, events: [{ seq: 1, cmd: "BID" }, { seq: 2, cmd: "SOLD" }, { seq: 3, cmd: "BID" }] } } });
    await drain();
    // flush #2: NEW stream (startedAt changed) → FULL push
    shared._fireChanged({ udDraftEvents: { newValue: { leagueId: "1200", sport: "flb", startedAt: 222, updatedAt: 3, events: [{ seq: 1, cmd: "NOMINATION" }] } } });
    await drain();

    const evPosts = win._posted.filter((p) => p.type === "draftEvents")
      .map((p) => ({ full: p.full, seqs: p.events.map((e) => e.seq), started: p.log.startedAt }));

    test("ud-bridge: initial push is FULL for the seeded stream", () => {
      assert(evPosts.length >= 1, "at least one draftEvents post");
      assertEq(evPosts[0].full, true, "first is full");
      assertDeep(evPosts[0].seqs, [1, 2]);
    });
    test("ud-bridge: same-stream flush forwards ONLY the new seq (delta)", () => {
      const delta = evPosts.find((p) => p.started === 111 && p.full === false);
      assert(delta, "a non-full same-stream post exists");
      assertDeep(delta.seqs, [3], "delta carries only seq 3");
    });
    test("ud-bridge: new stream (startedAt change) forces a FULL push", () => {
      const full = evPosts.find((p) => p.started === 222);
      assert(full, "new-stream post exists");
      assertEq(full.full, true, "marked full");
      assertDeep(full.seqs, [1]);
    });
  })();

  summary("Extension pipeline");
})();
