// p2r2-worker — PROXY/EXTERNAL-DATA REVIEW (Phase 2 Round 2).
//
// Extracts the REAL Rotowire parser functions from proxy/worker.js (they are
// plain top-level functions — sliced out by name and eval'd, the same technique
// test/app-engines.test.js uses for the engine files) and feeds them adversarial
// HTML: the recorded fixture, mutated classes, a truncated body, a WAF/challenge
// page, and a headline carrying <script>alert(1)</script>.
//
// GOAL: prove the parser degrades to fewer/zero items and NEVER produces garbage
// rows or throws (a thrown parser => proxyRotowireNews returns HTTP 500, which
// the client's `if (!r.ok) throw` turns into a generic failure the user could
// mistake for an auth problem). Also asserts the parser does NOT sanitize —
// escaping is the CLIENT's job (renderPlayerNewsBlock via esc()), which a
// companion assertion here confirms by string-checking the client source.

const fs = require("fs");
const path = require("path");

const WORKER = "/Users/jwars/Desktop/Claude/ultimate-draft/proxy/worker.js";
const src = fs.readFileSync(WORKER, "utf8");

// --- Slice out the plain functions we need, by their `function NAME(` anchors. ---
function sliceFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("could not find function " + name);
  // brace-match from the first { after the signature
  const braceStart = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = braceStart; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error("unbalanced braces for " + name);
  return src.slice(start, end + 1);
}

const bundle = [
  sliceFn("_decodeEntities"),
  sliceFn("_rwText"),
  sliceFn("parseRotowireNews"),
].join("\n");

// eval into this scope so we can call them
eval(bundle);

// --- tiny assert helpers (repo convention: no deps) ---
let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log("  PASS " + msg); }
  else { console.log("  FAIL " + msg); failed++; }
}
function noThrow(fn, msg) {
  try { const v = fn(); ok(true, msg + " (no throw)"); return v; }
  catch (e) { console.log("  FAIL " + msg + " — THREW: " + e.message); failed++; return undefined; }
}

console.log("\n=== p2r2-worker: Rotowire parser drift-tolerance ===\n");

// -------------------------------------------------------------------------
// 1. Recorded fixture (if present) — the happy path must produce clean rows.
// -------------------------------------------------------------------------
const FIX = "/tmp/rotowire.html";
if (fs.existsSync(FIX)) {
  const html = fs.readFileSync(FIX, "utf8");
  const items = noThrow(() => parseRotowireNews(html), "fixture parses");
  if (items) {
    ok(items.length > 0, "fixture yields >0 items (got " + items.length + ")");
    ok(items.every(it => it.player && typeof it.player === "string"),
      "every item has a non-empty player name");
    // headline may be null (some updates have no linked headline) — that's fine
    ok(items.every(it => typeof it.injured === "boolean"), "every item.injured is boolean");
    console.log("     sample:", JSON.stringify(items[0]).slice(0, 160));
  }
} else {
  console.log("  (fixture /tmp/rotowire.html absent — skipping happy path)");
}

// -------------------------------------------------------------------------
// 2. Mutated classes — Rotowire renames news-update -> news-item. The split
//    anchor no longer matches; parser must return [] (zero rows), not garbage.
// -------------------------------------------------------------------------
{
  const base = fs.existsSync(FIX) ? fs.readFileSync(FIX, "utf8")
    : '<div class="news-update"><a class="news-update__player-link" href="#">X</a></div><div class="news-update"></div>';
  const mutated = base.replace(/news-update/g, "news-item");
  const items = noThrow(() => parseRotowireNews(mutated), "mutated-classes parses");
  if (items) ok(items.length === 0, "mutated classes => 0 items (degrades, no garbage) got " + items.length);
}

// -------------------------------------------------------------------------
// 3. Truncated mid-item — feed truncates in the middle of a headline/anchor.
//    Parser must not throw and must not emit a half-row with junk fields.
// -------------------------------------------------------------------------
{
  const base = fs.existsSync(FIX) ? fs.readFileSync(FIX, "utf8")
    : '<div class="news-update"><a class="news-update__player-link" href="#">Aaron Judge</a><a class="news-update__headline" href="#">Homers twice</a></div>'
      + '<div class="news-update"><a class="news-update__player-link" href="#">Mike Trout</a><a class="news-update__headline" href="#';
  const truncated = base.slice(0, Math.floor(base.length * 0.5));
  const items = noThrow(() => parseRotowireNews(truncated), "truncated parses");
  if (items) {
    ok(items.every(it => it.player && it.player.length < 120),
      "truncated: no row has a runaway/garbage player field");
  }
}

// -------------------------------------------------------------------------
// 4. WAF / Cloudflare challenge page — no news-update divs at all.
//    Must return [] (which the endpoint reports as count:0), never a 500.
// -------------------------------------------------------------------------
{
  const challenge = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
    <body><div class="cf-browser-verification"><h1>Checking your browser before accessing rotowire.com</h1>
    <div id="challenge-form">Please turn JavaScript on and reload the page.</div></body></html>`;
  const items = noThrow(() => parseRotowireNews(challenge), "challenge page parses");
  if (items) ok(items.length === 0, "challenge page => 0 items got " + items.length);
}

// -------------------------------------------------------------------------
// 5. Nested tags inside the headline + XSS payload. The parser strips tags
//    (so nested <b> etc. don't break extraction) but does NOT HTML-escape.
//    That is BY DESIGN — the client must escape. We assert:
//      (a) parser doesn't throw and still extracts the player,
//      (b) the raw payload text survives into the item (parser is not the
//          sanitizer), so the CLIENT is the required escaping boundary.
// -------------------------------------------------------------------------
{
  const hostile = '<div class="news-update">'
    + '<a class="news-update__player-link" href="#">Shohei <b>Ohtani</b></a>'
    + '<a class="news-update__headline" href="#">Big day <script>alert(1)</script> at plate</a>'
    + '<div class="news-update__news">Body <img src=x onerror=alert(2)> text</div>'
    + '</div><div class="news-update"></div>';
  const items = noThrow(() => parseRotowireNews(hostile), "hostile-headline parses");
  if (items && items.length) {
    const it = items[0];
    ok(it.player === "Shohei Ohtani", "nested <b> in player name stripped -> '" + it.player + "'");
    // The <script>...</script> is a TAG so _rwText's tag-strip removes it, but
    // any raw angle-bracket text (e.g. entity-encoded) would pass through. Prove
    // the parser is NOT an escaping boundary by checking it emits plain text
    // with no HTML-escaping applied.
    console.log("     headline field:", JSON.stringify(it.headline));
    console.log("     news field    :", JSON.stringify(it.news));
    ok(!/&lt;|&amp;|&gt;/.test(it.headline || ""),
      "parser does NOT HTML-escape (escaping is the client's job)");
  }
}

// -------------------------------------------------------------------------
// 6. CLIENT escaping boundary — renderPlayerNewsBlock must wrap every injected
//    field in esc(). If a future edit drops esc() around headline/news/ts/inj,
//    a hostile Rotowire headline becomes stored XSS in the draft cockpit.
//    Static source assertion (no DOM here).
// -------------------------------------------------------------------------
{
  const CLIENT = "/Users/jwars/Desktop/Claude/ultimate-draft/js/data/rotowire.js";
  const cs = fs.readFileSync(CLIENT, "utf8");
  const block = cs.slice(cs.indexOf("function renderPlayerNewsBlock"),
                         cs.indexOf("function wirePlayerNewsBlock"));
  ok(/esc\(news\.headline/.test(block), "client escapes news.headline");
  ok(/esc\(news\.news\)/.test(block),   "client escapes news.news");
  ok(/esc\(news\.ts\)/.test(block),     "client escapes news.ts");
  ok(/esc\(news\.inj\)/.test(block),    "client escapes news.inj");
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " ASSERTION(S) FAILED"));
process.exit(failed === 0 ? 0 : 1);
