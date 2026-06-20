// FanGraphs windowed-xwOBA data layer. Pulls hitter xwOBA leaderboards for a set
// of trailing date windows (7/14/30/60 days) plus the full season, via the
// proxy's /fangraphs/xwoba route. Results are name-indexed and cached in
// localStorage so the Hot FAs view can join them against the ESPN free-agent
// pool without re-fetching on every render.

const FGX_KEY = "ud_fg_xwoba_v1";

// Trailing-day windows + season. `days: null` → full season (no date range).
const FGX_WINDOWS = [
  { id: "7d",  label: "7d",  days: 7 },
  { id: "14d", label: "14d", days: 14 },
  { id: "30d", label: "30d", days: 30 },
  { id: "60d", label: "60d", days: 60 },
  { id: "season", label: "Season", days: null },
];

// { windowId: { fetchedAt, season, start, end, byKey: { normKey: {name,team,xwOBA,wOBA,PA} } } }
let _fgx = {};

function loadFgxFromStorage() {
  try { _fgx = JSON.parse(localStorage.getItem(FGX_KEY) || "{}"); }
  catch (e) { _fgx = {}; }
}
function saveFgxToStorage() {
  try { localStorage.setItem(FGX_KEY, JSON.stringify(_fgx)); } catch (e) {}
}

// Name key that folds diacritics before normKey, so FanGraphs "Suarez" and ESPN
// "Suárez" collide. (The shared normKey strips accented chars entirely, which
// would key the two sides differently and silently drop accented players.)
function fgKey(name) {
  // ̀-ͯ = combining diacritical marks left after NFD decomposition.
  return normKey(String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, ""));
}

function _ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// Window → { start, end } in YYYY-MM-DD, or {} for the season window.
function _fgxRange(win) {
  if (win.days == null) return { start: "", end: "" };
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (win.days - 1)); // inclusive of today
  return { start: _ymd(start), end: _ymd(end) };
}

// Fetch one window from the proxy and cache it. Returns the cached entry.
async function fetchFgxWindow(winId) {
  const win = FGX_WINDOWS.find(w => w.id === winId);
  if (!win) throw new Error("Unknown window " + winId);
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured (Settings tab).");

  const { start, end } = _fgxRange(win);
  let url = ESPN.proxyUrl.replace(/\/$/, "") + "/fangraphs/xwoba?season=" + ESPN.season;
  if (start && end) url += "&startdate=" + start + "&enddate=" + end;

  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("FanGraphs proxy responded " + r.status);
  const data = await r.json();

  const byKey = {};
  for (const row of (data.rows || [])) {
    const key = fgKey(row.name); // diacritic-folded so it matches the ESPN FA pool
    if (!key) continue;
    byKey[key] = { name: row.name, team: row.team, xwOBA: row.xwOBA, wOBA: row.wOBA, PA: row.PA };
  }
  _fgx[winId] = { fetchedAt: Date.now(), season: ESPN.season, start, end, byKey };
  saveFgxToStorage();
  return _fgx[winId];
}

// Fetch all windows sequentially (FanGraphs is happier without a burst).
// onProgress(winId, status) lets the view show per-window state.
async function fetchAllFgxWindows(onProgress) {
  for (const win of FGX_WINDOWS) {
    try {
      if (onProgress) onProgress(win.id, "fetching");
      await fetchFgxWindow(win.id);
      if (onProgress) onProgress(win.id, "done");
    } catch (e) {
      if (onProgress) onProgress(win.id, "error:" + (e.message || e));
    }
  }
}

function getFgxWindow(winId) { return _fgx[winId] || null; }
function fgxLeaders(winId) {
  const w = _fgx[winId];
  if (!w) return [];
  return Object.values(w.byKey);
}
function fgxFor(winId, playerName) {
  const w = _fgx[winId];
  if (!w) return null;
  return w.byKey[fgKey(playerName)] || null;
}

loadFgxFromStorage();
