// Demonstrates: feed-clear-stale id is emitted TWICE when a stale capture is
// shown AND diagnostics render (mode != off). Duplicate id in one DOM.
// Functionally OK because draft.js delegates by t.id, but it's invalid HTML
// and the diagnostics one is redundant with the stale-line one.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "../../js/features/draft.js"), "utf8");
// Count literal emitters of id="feed-clear-stale"
const emitters = (src.match(/id="feed-clear-stale"/g) || []).length;
console.log("literal emitters of id=\"feed-clear-stale\":", emitters);
// Prove both can render together: stale line is gated by (_feed.staleInfo && !_feed.connected);
// diagnostics block (_feedDiagnosticsHtml) renders whenever getFeedMode() !== "off".
// renderDraftFeedPanel() includes BOTH _feedActivityHtml/status (stale line) AND _feedDiagnosticsHtml().
const both = /_undoSuspectsHtml\(\);\s*html \+= _feedDiagnosticsHtml\(\);/.test(src.replace(/\n/g," "));
console.log("panel appends diagnostics after status line (so both present when stale+on):", both);
console.log(emitters >= 2 ? "CONFIRMED duplicate id (harmless via delegation, invalid HTML)" : "not duplicated");
