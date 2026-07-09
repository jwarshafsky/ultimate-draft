require("/Users/jwars/Desktop/Claude/ultimate-draft/test/repro/r15-eng-4-harness.js");
// Start mock A at 1x, then immediately start mock B (which stops A implicitly?).
// startMockFeed does NOT stop a prior run — it bumps gen and re-arms. Test that
// A's in-flight timer no-ops (gen moved) and only B's startedAt appears.
setMockFeedSpeed("1x");
startMockFeed();
const startedA = _mockFeed.startedAt;
// immediately start again (back-to-back) before A's first frame fires
startMockFeed();
const startedB = _mockFeed.startedAt;
console.log("startedA:", startedA, "startedB:", startedB, "distinct:", startedA !== startedB);

// let some timers fire, then inspect the emit log for interleaving
setTimeout(() => {
  const startAts = [...new Set(emitLog.map(e => e.startedAt))];
  const fromA = emitLog.filter(e => e.startedAt === startedA).length;
  const fromB = emitLog.filter(e => e.startedAt === startedB).length;
  console.log("emits from A (stale gen):", fromA, " from B (current):", fromB, " distinct startedAts seen:", startAts.length);
  console.log(fromA === 0 ? "PASS — no stale-gen A frames leaked" : "FAIL — A's timers interleaved after B started");
  clearMockDraft();
  process.exit(0);
}, 1500);
