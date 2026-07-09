const fs = require("fs");
const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";
const H = require("/Users/jwars/Desktop/Claude/ultimate-draft/test/repro/r15-eng-harness.js");

// Track every _onDraftEvents/_applyDraftFeed call with the ctx.startedAt so we
// can detect interleaving between two mock generations.
const emitLog = [];
global._onDraftEvents = (msg) => { emitLog.push({ kind: "ev", startedAt: msg.log.startedAt, seq: msg.events[0].seq }); };
global._applyDraftFeed = (feed) => { emitLog.push({ kind: "feed", startedAt: feed.startedAt, n: feed.picks.length }); return Promise.resolve(); };
global.currentView = "x";
global.renderDraft = () => {};
global.esc = (s) => String(s);
global.alert = () => {};
global.emitLog = emitLog;

let src = fs.readFileSync(APP + "features/mock-live-feed.js", "utf8").replace(/if \(typeof module[\s\S]*$/, "");
src += "\nglobalThis.startMockFeed=startMockFeed;globalThis.stopMockFeed=stopMockFeed;globalThis.clearMockDraft=clearMockDraft;globalThis._mockFeed=_mockFeed;globalThis.mockFeedActive=mockFeedActive;globalThis.setMockFeedSpeed=setMockFeedSpeed;";
eval(src);
module.exports = H;
