// r15-eng-3: cadence sampler bands vs spec (mock-live-feed.js).
// Spec (from the file header + docs): bids/lot bimodal (med 1, mean ~5.9, p95 ≤20);
// increments med $1 mean ~$2.56 p90 ~$6; inter-bid med ~0.56s p95 ~4.5s.
const fs = require("fs");
const APP = "/Users/jwars/Desktop/Claude/ultimate-draft/js/";

// mock-live-feed.js exports { buildMockFeedScript, _mfBidTrace, _mfSampleIncrement }
// but buildMockFeedScript needs the engine + LEAGUE/getValues. Load the harness
// first (installs engine + globals), then eval mock-live-feed.js into the same
// global scope.
const H = require("/Users/jwars/Desktop/Claude/ultimate-draft/test/repro/r15-eng-harness.js");

// mock-live-feed.js references _onDraftEvents/_applyDraftFeed/Date/document at
// LOAD time only inside the click-listener guard (typeof document !== undefined).
// In node document is undefined so the listener block is skipped. Provide stubs
// for functions the sampler path touches (none at build time). eval it:
let src = fs.readFileSync(APP + "features/mock-live-feed.js", "utf8");
// strip the trailing module.exports (we grab functions from scope instead)
src = src.replace(/if \(typeof module[\s\S]*$/, "");
src += "\nglobalThis.buildMockFeedScript=buildMockFeedScript;globalThis._mfSampleIncrement=_mfSampleIncrement;globalThis._mfSampleInterBid=_mfSampleInterBid;globalThis._mfBidTrace=_mfBidTrace;";
eval(src);

const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// --- Increment distribution (direct sampler) ---
let incs = [];
for (let i = 0; i < 20000; i++) incs.push(_mfSampleIncrement());
console.log("INCREMENTS: med", pct(incs, 0.5), "mean", mean(incs).toFixed(2), "p90", pct(incs, 0.9), "  spec med$1 mean~$2.56 p90~$6");

// --- Inter-bid gap (direct sampler), in seconds ---
let gaps = [];
for (let i = 0; i < 20000; i++) gaps.push(_mfSampleInterBid() / 1000);
console.log("INTER-BID (s): med", pct(gaps, 0.5).toFixed(2), "p95", pct(gaps, 0.95).toFixed(2), "  spec med~0.56 p95~4.5");

// --- Bids per lot (build several full scripts, measure BID frames per lot) ---
let bidsPerLot = [];
for (let run = 0; run < 6; run++) {
  const script = buildMockFeedScript({});
  if (!script) { console.log("no script"); break; }
  // count BID frames between NOMINATION boundaries
  let cur = 0, started = false;
  for (const f of script.frames) {
    if (f.cmd === "NOMINATION") { if (started) bidsPerLot.push(cur); cur = 0; started = true; }
    else if (f.cmd === "BID") cur++;
  }
  if (started) bidsPerLot.push(cur);
}
console.log("BIDS/LOT: med", pct(bidsPerLot, 0.5), "mean", mean(bidsPerLot).toFixed(2), "p95", pct(bidsPerLot, 0.95), "max", Math.max(...bidsPerLot), "  spec med~1 mean~5.9 p95≤20");

// --- inter-bid at 1x from the actual frame dt's (not just the raw sampler) ---
let frameGaps = [];
const script = buildMockFeedScript({});
let lastCmd = null;
for (const f of script.frames) {
  if (f.cmd === "BID" && lastCmd === "BID") frameGaps.push(f.dt / 1000);
  lastCmd = f.cmd;
}
console.log("FRAME inter-bid (BID→BID dt, s): med", pct(frameGaps, 0.5).toFixed(2), "p95", pct(frameGaps, 0.95).toFixed(2));
