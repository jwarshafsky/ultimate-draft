// Rotowire news — recent player news + injury updates, fetched through the
// proxy (/rotowire/news) which parses rotowire.com/baseball/news.php into JSON.
// Name-indexed so the on-the-clock card can show a player's latest headline and
// injury note. The AI return-date estimate (for injured players) is computed on
// demand via /claude and cached per player.

const ROTOWIRE_KEY = "ud_rotowire_v1";       // { fetchedAt, byName:{normName:item} }
const ROTOWIRE_TTL = 15 * 60 * 1000;         // refetch at most every 15 min
let _rotowire = null;
let _rotowireFetching = null;
const _returnEstCache = {};                  // normName -> { text } | "pending"

function _rwNk(s) {
  return (typeof normalizePlayerName === "function") ? normalizePlayerName(s) : String(s || "").trim().toLowerCase();
}

function _rotowireLoad() {
  if (_rotowire) return _rotowire;
  try { _rotowire = JSON.parse(localStorage.getItem(ROTOWIRE_KEY) || "null"); } catch (e) { _rotowire = null; }
  return _rotowire;
}

// Kick off a fetch if the cache is empty or stale. Returns a promise that
// resolves when the index is ready (or immediately if fresh). Best-effort:
// failures leave any existing cache in place.
function ensureRotowireNews(force) {
  const cached = _rotowireLoad();
  const fresh = cached && (Date.now() - cached.fetchedAt) < ROTOWIRE_TTL;
  if (fresh && !force) return Promise.resolve(cached);
  if (_rotowireFetching) return _rotowireFetching;
  if (!ESPN.proxyUrl) return Promise.resolve(cached);
  _rotowireFetching = fetch(ESPN.proxyUrl.replace(/\/$/, "") + "/rotowire/news", {
    cache: "no-store", headers: proxyHeaders(),
  })
    .then(r => { if (!r.ok) throw new Error("rotowire " + r.status); return r.json(); })
    .then(data => {
      const byName = {};
      for (const it of (data.items || [])) if (it.player) byName[_rwNk(it.player)] = it;
      _rotowire = { fetchedAt: data.fetchedAt || Date.now(), byName };
      try { localStorage.setItem(ROTOWIRE_KEY, JSON.stringify(_rotowire)); } catch (e) {}
      return _rotowire;
    })
    .catch(e => { console.warn("[rotowire] fetch failed:", e.message); return _rotowireLoad(); })
    .finally(() => { _rotowireFetching = null; });
  return _rotowireFetching;
}

// Latest news item for a player, or null. Name-matched (normalized), with a
// last-name+first-initial fallback for accent/suffix mismatches.
function getPlayerNews(name) {
  const idx = _rotowireLoad();
  if (!idx || !idx.byName) return null;
  const key = _rwNk(name);
  if (idx.byName[key]) return idx.byName[key];
  if (typeof coreNameKey === "function") {
    const ck = coreNameKey(name);
    for (const [k, v] of Object.entries(idx.byName)) {
      if (coreNameKey(v.player) === ck) return v;
    }
  }
  return null;
}

function rotowireFetchedAt() {
  const idx = _rotowireLoad();
  return idx ? idx.fetchedAt : null;
}

// AI estimate of when an injured player is expected back, from the Rotowire
// news text. Cached per player; returns null until resolved. onDone(text) fires
// when the estimate lands so the card can update in place.
function estimatePlayerReturn(name, onDone) {
  const news = getPlayerNews(name);
  if (!news || !news.injured) return null;
  const key = _rwNk(name);
  const cached = _returnEstCache[key];
  if (cached && cached !== "pending") return cached.failed ? "estimate unavailable" : cached.text;
  if (cached === "pending" || !ESPN.proxyUrl) return null;
  _returnEstCache[key] = "pending";
  const body = {
    model: (typeof AI !== "undefined" && AI.model) || "claude-sonnet-5",
    system: "You are a fantasy baseball injury analyst. Given a player's latest injury news, reply with ONLY a short expected-return estimate (e.g. 'Likely back ~July 8', 'Out 4-6 weeks', 'Season-ending (TJ surgery)', 'Day-to-day'). No preamble, max 12 words. If the news implies he's already active, say 'Appears active'.",
    messages: [{ role: "user", content: (news.inj ? "Injury: " + news.inj + ". " : "") + (news.headline ? news.headline + ". " : "") + (news.news || "") }],
    max_tokens: 40,
  };
  fetch(ESPN.proxyUrl.replace(/\/$/, "") + "/claude", {
    method: "POST", headers: proxyHeaders({ "content-type": "application/json" }), body: JSON.stringify(body),
  })
    .then(r => r.ok ? r.json() : Promise.reject(new Error("claude " + r.status)))
    .then(data => {
      const text = (data.content || []).map(c => c.text || "").join(" ").trim();
      _returnEstCache[key] = { text };
      if (text && typeof onDone === "function") onDone(text);
    })
    .catch(e => {
      console.warn("[rotowire] return estimate failed:", e.message);
      _returnEstCache[key] = { text: null, failed: true };   // next lot render shows "unavailable"; a page reload retries
      if (typeof onDone === "function") onDone(null);
    });
  return null;
}

// A compact news block for a player card: latest Rotowire headline + factual
// body, and for injuries an AI return estimate that fills in when ready. The
// estimate placeholder has a stable id so wirePlayerNewsBlock can patch it.
function _returnEstId(name) { return "ret-est-" + _rwNk(name).replace(/[^a-z0-9]/g, ""); }

function renderPlayerNewsBlock(name) {
  const news = getPlayerNews(name);
  if (!news) return "";
  const when = news.ts ? ' <span class="dim">· ' + esc(news.ts) + '</span>' : "";
  let html = '<div class="rw-news small" style="margin-top:6px; border-top:1px solid var(--border); padding-top:5px;">';
  html += '<div><span class="muted">📰 Rotowire:</span> <b>' + esc(news.headline || "") + '</b>' + when + '</div>';
  if (news.news) html += '<div class="muted" style="margin-top:2px;">' + esc(news.news) + '</div>';
  if (news.injured) {
    const cached = _returnEstCache[_rwNk(name)];
    const done = cached && cached !== "pending" ? cached.text : null;
    html += '<div style="margin-top:3px;">' + (news.inj ? '<span style="color:var(--bad);">🚑 ' + esc(news.inj) + '</span> ' : '') +
      '<span id="' + _returnEstId(name) + '" class="muted">' + (done ? '<b style="color:var(--warn);">' + esc(done) + '</b>' : 'estimating return…') + '</span></div>';
  }
  return html + '</div>';
}

// After rendering the block, kick the AI estimate (if injured) and patch the
// placeholder in place when it resolves.
function wirePlayerNewsBlock(name) {
  const news = getPlayerNews(name);
  if (!news || !news.injured) return;
  estimatePlayerReturn(name, (text) => {
    const el = document.getElementById(_returnEstId(name));
    if (!el) return;
    el.innerHTML = text ? '<b style="color:var(--warn);">' + esc(text) + '</b>' : '<span class="dim">return estimate unavailable</span>';
  });
}
