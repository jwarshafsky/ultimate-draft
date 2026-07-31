// Auto-detect "my team" from the ESPN socket JOIN URL (param 3 = the team id
// this browser drafts as). Removes the manual-seat ambiguity Jeff flagged
// (league team id vs draft-order position).
const { test, section, summary, assert, assertEq, makeChromeStub, makeWindowStub, loadScript } = require("./helpers.js");
const EXT = process.env.KEEPER_EDGE_DIR || require("path").join(require("os").homedir(), "dev", "keeper-edge-extension") + "/";

const win = makeWindowStub();
const chromeStub = makeChromeStub({});
class FakeWS {
  constructor(url) { this.url = url; }
  addEventListener() {}
}
win.WebSocket = FakeWS;
const posted = [];
const origPost = win.postMessage.bind(win);
win.postMessage = (m, o) => { posted.push(m); origPost(m, o); };

const sandbox = {
  window: win,
  location: { pathname: "/baseball/draft", search: "?leagueId=555777" },
  URLSearchParams, chrome: chromeStub.chrome,
  atob: (b) => Buffer.from(b, "base64").toString("binary"),
  TextDecoder, DataView, Uint8Array, Date,
  console: { log() {}, warn() {}, error() {} },
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
};
loadScript(EXT + "draft-socket-capture.js", sandbox);
loadScript(EXT + "draft-bridge.js", sandbox);

section("Seat auto-detection (JOIN URL param 3)");

test("SOCKET_OPEN carries myTeamId parsed from the JOIN URL", () => {
  new win.WebSocket("wss://fantasydraft.espn.com/game-99/JOIN?1=99&2=555777&3=7&4=x&5=tok");
  const open = posted.find(m => m && m.__udDraft && m.cmd === "SOCKET_OPEN");
  assert(open, "SOCKET_OPEN posted");
  assertEq(open.myTeamId, 7, "seat parsed from &3=");
});

(async () => {
  await new Promise(r => setImmediate(r));   // let whenLoaded + beat settle
  test("heartbeat rides the detected seat", () => {
    const stored = chromeStub._store.udDraftTab;
    assert(stored, "beat written (keys: " + JSON.stringify(Object.keys(chromeStub._store)) + ")");
    assertEq(stored.myTeamId, 7, "beat carries the seat");
  });
  summary();
  setTimeout(() => process.exit(process.exitCode || 0), 30);
})();
