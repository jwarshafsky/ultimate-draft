// Demonstrates: renderInvariantsLine() (js/core/invariants.js:399) injects
// v.detail into innerHTML WITHOUT esc(). v.detail embeds ESPN player names
// (invariants.js:158,169,239). A quirky/malicious feed name breaks markup.
// Call chain: updateDraftDiagnostics -> el.innerHTML = _feedDiagBodyHtml()
//   _feedDiagBodyHtml (draft.js:1407):  html += '...' + renderInvariantsLine();
const fs = require("fs"), path = require("path");
const inv = fs.readFileSync(path.join(__dirname, "../../js/core/invariants.js"), "utf8");
const rilSrc = inv.match(/function renderInvariantsLine\(\)[\s\S]*?\n}/)[0];
const evilName = 'Da\'Quan <img src=x onerror=alert(1)>';
const stub = () => ({ violations: [
  { id: "I-POOL", severity: "error",
    detail: 'player "' + evilName + '" is both drafted and in the excluded (keeper) set' }
], counts: { checks: 1 } });
const ril = new Function('checkDraftInvariants', rilSrc + '; return renderInvariantsLine;')(stub);
const out = ril();
console.log("--- rendered innerHTML fragment ---\n" + out + "\n");
const raw = out.includes("<img src=x onerror=alert(1)>");
console.log("raw <img onerror> present in innerHTML:", raw);
console.log(raw ? "CONFIRMED: unescaped external player name -> markup break / XSS surface"
                : "SAFE (escaped)");
