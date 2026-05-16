// ESPN draft polling client. Talks to a proxy endpoint (Cloud Run / Cloudflare
// Worker) that holds the espn_s2 + SWID cookies server-side and forwards
// requests to ESPN's private league API.
//
// Proxy contract:
//   GET  {PROXY_URL}/espn/draft?leagueId=1200&season=2026
//        → returns { picks: [{ playerId, playerName, teamId, bidAmount, ... }] }
//   GET  {PROXY_URL}/espn/teams?leagueId=1200&season=2026
//        → returns ESPN team objects (id, location, nickname, roster)
//   GET  {PROXY_URL}/espn/players?leagueId=1200&season=2026&limit=2000
//        → kona_player_info player pool (needs X-Fantasy-Filter)
//
// The proxy URL is configurable so it can be deployed wherever. Defaults to
// the existing Cloud Run proxy if user has set up the endpoints there.

const ESPN = {
  proxyUrl: localStorage.getItem("ud_proxy_url") || "",
  leagueId: 1200,
  season: 2026,
  polling: false,
  pollTimer: null,
  pollInterval: 5000,
  listeners: [],
};

function setProxyUrl(url) {
  ESPN.proxyUrl = (url || "").trim();
  if (ESPN.proxyUrl) localStorage.setItem("ud_proxy_url", ESPN.proxyUrl);
  else localStorage.removeItem("ud_proxy_url");
}
function getProxyUrl() { return ESPN.proxyUrl; }

async function fetchEspnDraft() {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/draft?leagueId=" + ESPN.leagueId + "&season=" + ESPN.season;
  const r = await fetch(url);
  if (!r.ok) throw new Error("ESPN proxy responded " + r.status);
  return r.json();
}

async function fetchEspnPlayers() {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/players?leagueId=" + ESPN.leagueId + "&season=" + ESPN.season;
  const r = await fetch(url);
  if (!r.ok) throw new Error("ESPN proxy responded " + r.status);
  return r.json();
}

// Fetch one season's draft history (uses leagueHistory endpoint server-side).
async function fetchEspnHistory(season) {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/history?leagueId=" + ESPN.leagueId + "&season=" + season;
  const r = await fetch(url);
  if (!r.ok) throw new Error("ESPN history " + season + " responded " + r.status);
  return r.json();
}

// Sync all historical seasons in one shot. Default seasons: 2017-2026 minus
// 2020 (Jeff said to exclude that COVID-shortened year). Adds to _history and
// returns a summary.
async function syncAllEspnHistory(opts) {
  opts = opts || {};
  const years = opts.years || [2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];
  const onProgress = opts.onProgress || (() => {});
  const result = { seasons: [], failed: [], totalPicks: 0, teamMapsBySeason: {} };
  for (const year of years) {
    onProgress({ year, status: "fetching" });
    try {
      const data = await fetchEspnHistory(year);
      if (!data.picks || !data.picks.length) {
        result.failed.push({ year, reason: "no picks" });
        onProgress({ year, status: "empty" });
        continue;
      }
      // Strip existing picks from this year (re-syncing replaces)
      _history.picks = _history.picks.filter(p => p.year !== year);
      for (const p of data.picks) {
        _history.picks.push({
          year,
          owner: p.teamName || ("Team " + p.teamId),
          espnTeamId: p.teamId,
          espnOwnerGuid: p.primaryOwner || null,  // stable across years
          player: p.playerName,
          espnPlayerId: p.playerId,
          pos: p.pos || "",
          price: p.bidAmount || 0,
          keeper: !!p.keeper,
        });
      }
      result.teamMapsBySeason[year] = data.teamMap;
      result.seasons.push({ year, pickCount: data.picks.length });
      result.totalPicks += data.picks.length;
      onProgress({ year, status: "done", picks: data.picks.length });
    } catch (e) {
      result.failed.push({ year, reason: e.message || String(e) });
      onProgress({ year, status: "failed", error: e.message });
    }
  }
  _history.meta.years = Array.from(new Set(_history.picks.map(p => p.year))).sort();
  _history.meta.teamMapsBySeason = result.teamMapsBySeason;
  saveHistoryToStorage();
  if (typeof rerender === "function") rerender();
  return result;
}

// Start polling ESPN every N seconds for new picks. Each new pick is dispatched
// to live draft state and triggers re-render. Idempotent — picks de-duped by
// playerId/lotIndex.
function startEspnPolling() {
  if (ESPN.polling) return;
  if (!ESPN.proxyUrl) { setStatus("draft", "no proxy", "warn"); return; }
  ESPN.polling = true;
  setStatus("draft", "polling…", "");
  const tick = async () => {
    try {
      const data = await fetchEspnDraft();
      processEspnPicks(data.picks || []);
      setStatus("draft", "live (" + (data.picks || []).length + " picks)", "ok");
    } catch (e) {
      console.warn("ESPN poll failed:", e);
      setStatus("draft", "poll error", "bad");
    }
    if (ESPN.polling) ESPN.pollTimer = setTimeout(tick, ESPN.pollInterval);
  };
  tick();
}

function stopEspnPolling() {
  ESPN.polling = false;
  if (ESPN.pollTimer) { clearTimeout(ESPN.pollTimer); ESPN.pollTimer = null; }
  setStatus("draft", "idle", "");
}

// Process raw ESPN pick data, merge into _liveDraft.picks (handled in
// features/draft.js). De-dupe by playerId.
function processEspnPicks(rawPicks) {
  const existing = new Set(_liveDraft.picks.map(p => p.espnPlayerId).filter(Boolean));
  let added = 0;
  for (const raw of rawPicks) {
    if (existing.has(raw.playerId)) continue;
    _liveDraft.picks.push({
      player: raw.playerName,
      pos: getPlayerValue(raw.playerName)?.posKey || null,
      team: espnTeamIdToOwnerId(raw.teamId),
      price: raw.bidAmount || 0,
      ts: Date.now(),
      espnPlayerId: raw.playerId,
    });
    added++;
  }
  if (added) {
    saveLiveDraft();
    if (currentView === "draft") renderDraft();
    // Notify any AI assistant listeners
    for (const fn of ESPN.listeners) {
      try { fn(rawPicks); } catch (e) { console.error(e); }
    }
  }
}

// Maps ESPN team ID (1-13) to our internal team id. ESPN team IDs in The
// League match the constitutional table — id 11 is skipped (deleted team).
const ESPN_TEAM_ID_MAP = {
  1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff",
  6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin",
  12: "dave", 13: "jtl",
};
function espnTeamIdToOwnerId(espnId) {
  return ESPN_TEAM_ID_MAP[espnId] || null;
}

function onEspnPick(fn) {
  ESPN.listeners.push(fn);
}
