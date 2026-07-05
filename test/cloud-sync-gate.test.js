// Cloud-sync mock/test gate — guards the CRITICAL Round-8 finding: a practice
// mock reuses the same draft-context localStorage keys the real draft does, so
// without this gate its synthetic state would mirror to Cloudflare KV and
// overwrite (or flip into mock context) a REAL in-progress draft on another
// signed-in device. _syncDraftLocal(key) must return true — keeping the key
// device-local — whenever this device is in a mock/test context, and false when
// it's a genuine real draft (which SHOULD sync across devices).
//
// Loads the REAL js/data/cloud-sync.js. document.readyState="loading" defers its
// _initCloudSync (network/auth wiring) forever, so only the pure gate logic runs.

const path = require("path");
const { test, assert, assertEq, summary, loadScript, makeLocalStorageStub } = require("./helpers");

let _mockActive = false, _testMode = false;
const ls = makeLocalStorageStub({});

// cloud-sync.js patches Storage.prototype and checks `this === window.localStorage`.
global.Storage = function Storage() {};
global.Storage.prototype.setItem = function () {};
global.Storage.prototype.removeItem = function () {};
global.Storage.prototype.getItem = function () {};
global.window = { localStorage: ls, addEventListener() {} };
global.localStorage = ls;
global.document = { readyState: "loading", addEventListener() {} };   // defers _initCloudSync
global.mockFeedActive = () => _mockActive;
global.draftTestMode = () => _testMode;

loadScript(path.join(__dirname, "..", "js/data/cloud-sync.js"));
// _syncDraftLocal / _syncEligible / _syncIsMockContext are now global functions.

const DRAFT_KEYS = ["ud_live_draft_v1", "ud_feed_mode", "ud_league_override", "ud_test_my_team"];

test("real draft context: draft keys sync normally (portable across devices)", () => {
  _mockActive = false; _testMode = false; ls._map.clear();
  for (const k of DRAFT_KEYS) assertEq(_syncDraftLocal(k), false, k + " should sync in real mode");
  assert(_syncEligible("ud_live_draft_v1"), "still an eligible sync key");
});

test("active mock: every draft-context key is device-local", () => {
  _mockActive = true; _testMode = false; ls._map.clear();
  for (const k of DRAFT_KEYS) assertEq(_syncDraftLocal(k), true, k + " must be device-local while a mock runs");
  assertEq(_syncDraftLocal("ud_proxy_key"), false, "non-draft keys still sync during a mock");
});

test("test-league context (override active): draft keys device-local", () => {
  _mockActive = false; _testMode = true; ls._map.clear();
  for (const k of DRAFT_KEYS) assertEq(_syncDraftLocal(k), true, k + " device-local in test mode");
});

test("leftover espn:N mock picks keep the pick list device-local even after mode drifts to off", () => {
  _mockActive = false; _testMode = false;
  ls.setItem("ud_live_draft_v1", JSON.stringify({ v: 2, picks: [{ player: "X", team: "espn:5", price: 10 }] }));
  assertEq(_syncDraftLocal("ud_live_draft_v1"), true, "sniffs espn:N picks");
});

test("a real pick list DOES sync (device-sync feature preserved)", () => {
  _mockActive = false; _testMode = false;
  ls.setItem("ud_live_draft_v1", JSON.stringify({ v: 2, picks: [{ player: "Trout", team: "jeff", price: 40 }] }));
  assertEq(_syncDraftLocal("ud_live_draft_v1"), false, "real picks are portable across devices");
});

summary("cloud-sync mock/test gate");
