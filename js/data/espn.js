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

// Season defaults to the current calendar year (MLB fantasy seasons are a
// single calendar year), so the tool doesn't silently keep pulling last year's
// league once the year rolls over. Pinnable via localStorage for the offseason
// edge case (e.g. prepping next year's draft early).
function _defaultSeason() {
  return Number(localStorage.getItem("ud_season")) || new Date().getFullYear();
}

const ESPN = {
  proxyUrl: localStorage.getItem("ud_proxy_url") || "",
  leagueId: 1200,
  season: _defaultSeason(),
  polling: false,
  pollTimer: null,
  pollInterval: 5000,
  listeners: [],
};

function setSeason(year) {
  const n = Number(year);
  if (!Number.isFinite(n) || n < 2000) return;
  ESPN.season = n;
  localStorage.setItem("ud_season", String(n));
}

// Seasons 2017..current, excluding the COVID-shortened 2020 (Jeff's call).
// Generated so the range extends automatically each year.
function defaultHistorySeasons() {
  const out = [];
  for (let y = 2017; y <= new Date().getFullYear(); y++) if (y !== 2020) out.push(y);
  return out;
}

function setProxyUrl(url) {
  ESPN.proxyUrl = (url || "").trim();
  if (ESPN.proxyUrl) localStorage.setItem("ud_proxy_url", ESPN.proxyUrl);
  else localStorage.removeItem("ud_proxy_url");
}
function getProxyUrl() { return ESPN.proxyUrl; }

async function fetchEspnDraft() {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/draft?leagueId=" + ESPN.leagueId + "&season=" + ESPN.season;
  // no-store: live draft state must never come from the HTTP cache, or a poll
  // could miss picks and mis-compute remaining budget / inflation.
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("ESPN proxy responded " + r.status);
  return r.json();
}

async function fetchEspnPlayers() {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/players?leagueId=" + ESPN.leagueId + "&season=" + ESPN.season;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("ESPN proxy responded " + r.status);
  return r.json();
}

// --- In-season rosters + stats (Standings analyzer) ---------------------
//
// ESPN baseball stat IDs (reverse-engineered; from the cwendt94/espn-api map).
// These are the keys inside each stat entry's `stats` object.
const ESPN_STAT_ID = {
  // hitting
  AB: 0, H: 1, HR: 5, BB: 10, HBP: 12, SF: 13, PA: 16, OBP: 17, R: 20, RBI: 21, SB: 23,
  // pitching
  IP_OUTS: 34, P_H: 37, P_BB: 39, WHIP: 41, ER: 45, ERA: 47, K: 48, W: 53, SV: 57, HLD: 60, QS: 63,
};

// Pull a number out of an ESPN stat map by id (returns null if absent).
function _statById(map, id) {
  if (!map) return null;
  const v = map[id] != null ? map[id] : map[String(id)];
  return (typeof v === "number" && isFinite(v)) ? v : null;
}

// Rough sample size of a stat entry (PA-ish for hitters, outs for pitchers) so
// we can prefer the SEASON cumulative line over short last-7/15/30 splits when
// the explicit season split isn't tagged.
function _entrySample(s) {
  const m = s?.stats || {};
  const ab = _statById(m, ESPN_STAT_ID.AB) || 0;
  const bb = _statById(m, ESPN_STAT_ID.BB) || 0;
  const outs = _statById(m, ESPN_STAT_ID.IP_OUTS) || 0;
  return ab + bb + outs;
}

// Pick the right stat entry for a player given source (0=actual, 1=projected)
// and the target season. Prefer the season-total split (statSplitTypeId 0);
// otherwise fall back to the largest-sample matching entry (the cumulative
// season line, not a recent-days split).
function _pickStatEntry(player, season, sourceId) {
  const arr = player?.stats || [];
  const matches = arr.filter(s => s.statSourceId === sourceId && Number(s.seasonId) === Number(season));
  if (!matches.length) return null;
  const seasonSplit = matches.find(s => s.statSplitTypeId === 0);
  if (seasonSplit) return seasonSplit;
  return matches.reduce((best, s) => (_entrySample(s) > _entrySample(best) ? s : best), matches[0]);
}

// Normalize one ESPN roster entry into the shape standings.js consumes.
// `sourceId`: 0 = season-to-date actuals, 1 = full-season projection.
function _normalizeEspnPlayer(entry, season, sourceId) {
  const player = entry?.playerPoolEntry?.player || entry?.player;
  if (!player) return null;
  const slots = player.eligibleSlots || [];
  // Pitcher if eligible only for pitching slots (13 SP / 14 RP) and not a hitter slot.
  const isPitcher = (player.defaultPositionId === 1) ||
    (slots.includes(13) || slots.includes(14)) && !slots.some(s => s >= 0 && s <= 12 && s !== 1);
  const se = _pickStatEntry(player, season, sourceId);
  const m = se?.stats || {};
  const name = player.fullName || ("Player " + player.id);

  if (isPitcher) {
    const ipOuts = _statById(m, ESPN_STAT_ID.IP_OUTS);
    return {
      name, espnId: player.id, type: "P",
      lineupSlotId: entry.lineupSlotId,
      K: _statById(m, ESPN_STAT_ID.K) || 0,
      QS: _statById(m, ESPN_STAT_ID.QS) || 0,
      SV: _statById(m, ESPN_STAT_ID.SV) || 0,
      HLD: _statById(m, ESPN_STAT_ID.HLD) || 0,
      W: _statById(m, ESPN_STAT_ID.W) || 0,
      IP: ipOuts != null ? ipOuts / 3 : 0,
      ER: _statById(m, ESPN_STAT_ID.ER),
      HA: _statById(m, ESPN_STAT_ID.P_H),
      BBA: _statById(m, ESPN_STAT_ID.P_BB),
      ERA: _statById(m, ESPN_STAT_ID.ERA),
      WHIP: _statById(m, ESPN_STAT_ID.WHIP),
    };
  }
  return {
    name, espnId: player.id, type: "H",
    lineupSlotId: entry.lineupSlotId,
    R: _statById(m, ESPN_STAT_ID.R) || 0,
    HR: _statById(m, ESPN_STAT_ID.HR) || 0,
    RBI: _statById(m, ESPN_STAT_ID.RBI) || 0,
    SB: _statById(m, ESPN_STAT_ID.SB) || 0,
    H: _statById(m, ESPN_STAT_ID.H),
    BB: _statById(m, ESPN_STAT_ID.BB),
    HBP: _statById(m, ESPN_STAT_ID.HBP),
    SF: _statById(m, ESPN_STAT_ID.SF),
    AB: _statById(m, ESPN_STAT_ID.AB),
    PA: _statById(m, ESPN_STAT_ID.PA) || 0,
    OBP: _statById(m, ESPN_STAT_ID.OBP),
  };
}

// Fetch live rosters for all teams. Returns:
//   { rosters: { ourTeamId: [normalizedPlayer] }, teamMeta: { ourTeamId: {name,...} }, season }
// `sourceId`: 0 = current YTD stats, 1 = ESPN full-season projection.
async function fetchEspnRosters(sourceId) {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  sourceId = sourceId === 1 ? 1 : 0;
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/teams?leagueId=" + ESPN.leagueId + "&season=" + ESPN.season;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("ESPN proxy responded " + r.status);
  const data = await r.json();
  return parseEspnRosters(data, sourceId);
}

// Parse a raw mTeam+mRoster response into normalized rosters keyed by OUR
// internal team ids. Exported so the test harness / cached samples reuse it.
function parseEspnRosters(data, sourceId) {
  sourceId = sourceId === 1 ? 1 : 0;
  const season = ESPN.season;
  const rosters = {};
  const teamMeta = {};
  for (const t of (data.teams || [])) {
    const ourId = espnTeamIdToOwnerId(t.id);
    if (!ourId) continue;
    const entries = t.roster?.entries || [];
    rosters[ourId] = entries
      .map(e => _normalizeEspnPlayer(e, season, sourceId))
      .filter(Boolean);
    teamMeta[ourId] = {
      espnId: t.id,
      name: ((t.location || "") + " " + (t.nickname || "")).trim() || ("Team " + t.id),
      abbrev: t.abbrev,
      playerCount: rosters[ourId].length,
    };
  }
  return { rosters, teamMeta, season, sourceId };
}

// Fetch the available-player pool (kona_player_info) for what-if "add" moves,
// normalized to the same shape as rosters. Returns players not on any team.
async function fetchEspnFreeAgents(sourceId) {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  sourceId = sourceId === 1 ? 1 : 0;
  const data = await fetchEspnPlayers();
  const list = data.players || data.playerPool || [];
  const out = [];
  for (const entry of list) {
    // Free agents / waivers have onTeamId 0 (or missing). Skip rostered players.
    const onTeam = entry.onTeamId != null ? entry.onTeamId : entry.player?.onTeamId;
    if (onTeam && onTeam > 0) continue;
    const p = _normalizeEspnPlayer(entry, ESPN.season, sourceId);
    if (p) out.push(p);
  }
  return out;
}

// Fetch one season's draft history (uses leagueHistory endpoint server-side).
async function fetchEspnHistory(season) {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/history?leagueId=" + ESPN.leagueId + "&season=" + season;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("ESPN history " + season + " responded " + r.status);
  return r.json();
}

// Sync all historical seasons in one shot. Default seasons: 2017-2026 minus
// 2020 (Jeff said to exclude that COVID-shortened year). Adds to _history and
// returns a summary.
async function syncAllEspnHistory(opts) {
  opts = opts || {};
  const years = opts.years || defaultHistorySeasons();
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
