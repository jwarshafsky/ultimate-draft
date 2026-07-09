// Minimal verification of the R15 eph-1 fix: a pick-add dispatched DURING a
// mock must never write to disk if the context flips (mock→real) before the
// async _applyDraftFeed resolves. Loads only espn.js + draft.js (avoids files
// another session has in flight). Exits 0 when the race is closed.
const fs = require("fs");
const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";
const writes = [];
const store = { ud_feed_mode: "test" };
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { writes.push(k); store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.window = { addEventListener() {}, postMessage() {}, location: { origin: "x", pathname: "/", search: "" } };
global.document = { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, body: { classList: { add() {}, remove() {}, toggle() {} } }, createElement: () => ({ style: {} }), activeElement: null };
global.location = global.window.location;
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { fn(); return 0; }; global.clearTimeout = () => {};
global.console = { log() {}, warn() {}, error() {} };
global.fetch = async () => ({ ok: false });
global.LEAGUE = { draftBudget: 260, rosterSize: 26, numTeams: 12, teams: [{ id: "jeff", owner: "Jeff", isMe: true }] };
global.normalizePlayerName = (s) => String(s || "").toLowerCase();
global.esc = (s) => String(s);
global.getValues = () => []; global.getPlayerValue = () => null;
global.getEffectiveKeeperSelections = () => ({}); global.getKeeperSelections = () => ({});
global.getCurrentKeeperSalary = () => 0; global.setStatus = () => {};
global.getMyTeam = () => null; global.getTeam = () => null;
global.currentView = "x";
global.collectKeepers = () => []; global.computeFlatInflation = () => null;
global.logDraftEvents = () => { writes.push("SUPABASE"); };
global.draftLogStatus = () => ({});
global.updateDraftDiagnostics = () => {};
// mock-feed context stubs (mock-live-feed.js not loaded — we control the flag)
let mockOn = true;
global._mockFeed = { active: true, gen: 1, myEspnId: 5 };
global.mockFeedActive = () => mockOn;

eval(fs.readFileSync(APP + "data/espn.js", "utf8"));
eval(fs.readFileSync(APP + "features/draft.js", "utf8"));
global._espnIdToName = { 900005: "Synthetic Guy" };

(async () => {
  // real draft context on disk
  store.ud_live_draft_v1 = JSON.stringify({ v: 2, at: 1, picks: [{ player: "Real Star", team: "jeff", price: 30 }], deleted: {}, streamKey: "1200:1" });
  writes.length = 0;

  // Dispatch a mock pick-add UNAWAITED, then tear the mock down + flip to real
  // in the SAME synchronous task (the race).
  const p = _applyDraftFeed({ leagueId: 990001, sport: "flb", startedAt: 5, updatedAt: Date.now(),
    picks: [{ playerId: 900005, teamId: 3, price: 12, seq: 2, ts: Date.now() }] });
  mockOn = false;                       // clearMockDraft equivalent
  _mockFeed.gen = 2;
  store.ud_feed_mode = "real";          // setFeedMode('real') equivalent (context flip)
  await p;                              // let the pending add resolve

  const draftWrites = writes.filter(k => k === "ud_live_draft_v1" || k === "ud_live_draft_bk_v1" || k === "SUPABASE");
  const disk = JSON.parse(store.ud_live_draft_v1);
  const contaminated = disk.picks.some(pk => String(pk.player).includes("Synthetic") || String(pk.team).startsWith("espn:"));
  if (draftWrites.length || contaminated) {
    process.stderr.write("RACE OPEN: draft writes after teardown = " + JSON.stringify(draftWrites) +
      "; disk contaminated = " + contaminated + "\n");
    process.exit(1);
  }
  process.stdout.write("RACE CLOSED: pending mock pick-add dropped; real draft untouched on disk.\n");
  process.exit(0);
})();
