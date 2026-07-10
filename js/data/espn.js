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

const UD_HOME_LEAGUE_ID = 1200;   // The League — the real league this tool is for

const ESPN = {
  // Falls back to the deployed Worker (constant lives in cloud-sync.js, which
  // loads first) so a fresh device works right after sign-in.
  proxyUrl: localStorage.getItem("ud_proxy_url") ||
    (typeof UD_DEFAULT_PROXY_URL !== "undefined" ? UD_DEFAULT_PROXY_URL : ""),
  proxyKey: localStorage.getItem("ud_proxy_key") || "",
  // Test-league override (Settings) — lets a throwaway ESPN league stand in for
  // a live-draft dry run. Empty/default = the real league.
  leagueId: Number(localStorage.getItem("ud_league_override")) || UD_HOME_LEAGUE_ID,
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

// Shared secret the worker requires (x-ud-key) — without it the proxy would be
// an open relay for the Anthropic key and ESPN cookies.
function setProxyKey(key) {
  ESPN.proxyKey = (key || "").trim();
  if (ESPN.proxyKey) localStorage.setItem("ud_proxy_key", ESPN.proxyKey);
  else localStorage.removeItem("ud_proxy_key");
}
function proxyHeaders(extra) {
  const h = { ...(extra || {}) };
  if (ESPN.proxyKey) h["x-ud-key"] = ESPN.proxyKey;
  return h;
}

// Test-league override. Pass empty/0/1200 to clear back to the real league.
function setLeagueOverride(id) {
  const n = Number(id);
  if (Number.isFinite(n) && n > 0 && n !== UD_HOME_LEAGUE_ID) {
    ESPN.leagueId = n;
    localStorage.setItem("ud_league_override", String(n));
  } else {
    ESPN.leagueId = UD_HOME_LEAGUE_ID;
    localStorage.removeItem("ud_league_override");
  }
}
function leagueOverrideActive() { return ESPN.leagueId !== UD_HOME_LEAGUE_ID; }

async function fetchEspnDraft() {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/draft?leagueId=" + ESPN.leagueId + "&season=" + ESPN.season;
  // no-store: live draft state must never come from the HTTP cache, or a poll
  // could miss picks and mis-compute remaining budget / inflation.
  const r = await fetch(url, { cache: "no-store", headers: proxyHeaders() });
  if (!r.ok) throw new Error("ESPN proxy responded " + r.status);
  return r.json();
}

async function fetchEspnPlayers() {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured.");
  const url = ESPN.proxyUrl.replace(/\/$/, "") + "/espn/players?leagueId=" + ESPN.leagueId + "&season=" + ESPN.season;
  const r = await fetch(url, { cache: "no-store", headers: proxyHeaders() });
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
  GS: 33, IP_OUTS: 34, P_H: 37, P_BB: 39, WHIP: 41, ER: 45, ERA: 47, K: 48, W: 53, SV: 57, HLD: 60, QS: 63,
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
// Hitter position label from ESPN defaultPositionId (+ eligibleSlots for OF/UTIL).
const _ESPN_POS_BY_ID = { 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH" };
function _espnPosLabel(dpid, slots) {
  if (dpid === 1) return (slots || []).includes(14) ? "RP" : "SP";
  return _ESPN_POS_BY_ID[dpid] || "UT";
}

// All hitter positions a player qualifies at, from eligibleSlots. Hitter
// lineup-slot IDs (0-11) are stable across ESPN flb variants. Composite/utility
// slots (6 MI, 7 CI, 12 UTIL) and bench/IL are intentionally omitted.
const _ESPN_SLOT_POS = { 0: "C", 1: "1B", 2: "2B", 3: "3B", 4: "SS", 5: "OF", 8: "OF", 9: "OF", 10: "OF", 11: "DH" };
function _espnEligiblePos(slots) {
  const out = [];
  for (const s of (slots || [])) {
    const p = _ESPN_SLOT_POS[s];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function _normalizeEspnPlayer(entry, season, sourceId) {
  const player = entry?.playerPoolEntry?.player || entry?.player;
  if (!player) return null;
  const slots = player.eligibleSlots || [];
  // Two-way player (Ohtani): eligible for BOTH a hitter slot (0-12) and a
  // pitcher slot (13 SP / 14 RP). Counted as a hitter AND a pitcher downstream.
  const hasHitSlot = slots.some(s => s >= 0 && s <= 12);
  const hasPitSlot = slots.includes(13) || slots.includes(14) || slots.includes(15);
  const twoWay = hasHitSlot && hasPitSlot;
  // Pitcher if eligible only for pitching slots (13 SP / 14 RP) and not a hitter slot.
  const isPitcher = !twoWay && ((player.defaultPositionId === 1) ||
    (slots.includes(13) || slots.includes(14)) && !slots.some(s => s >= 0 && s <= 12 && s !== 1));
  const se = _pickStatEntry(player, season, sourceId);
  const m = se?.stats || {};
  const name = player.fullName || ("Player " + player.id);
  const pctOwned = player.ownership?.percentOwned != null ? player.ownership.percentOwned : null;
  const pos = _espnPosLabel(player.defaultPositionId, slots);
  const eligiblePos = _espnEligiblePos(slots);

  if (isPitcher) {
    const ipOuts = _statById(m, ESPN_STAT_ID.IP_OUTS);
    return {
      name, espnId: player.id, type: "P", pctOwned, pos, eligibleSlots: slots, twoWay,
      acquisitionType: entry.acquisitionType || null,
      injuryStatus: player.injuryStatus || null, lineupSlotId: entry.lineupSlotId,
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
    name, espnId: player.id, type: "H", pctOwned, pos, eligiblePos, eligibleSlots: slots, twoWay,
    acquisitionType: entry.acquisitionType || null,
    injuryStatus: player.injuryStatus || null, lineupSlotId: entry.lineupSlotId,
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
  const r = await fetch(url, { cache: "no-store", headers: proxyHeaders() });
  if (!r.ok) throw new Error("ESPN proxy responded " + r.status);
  const data = await r.json();
  return parseEspnRosters(data, sourceId);
}

// Build a team's actual season-to-date totals from ESPN's own accumulated
// `valuesByStat` (the numbers that drive ESPN's real standings) — NOT by
// re-summing rostered players (which would wrongly count bench/IL players and
// pre-trade stats). Returns two synthetic stat lines (hitting + pitching) in the
// shape standings.js consumes, so YTD combines cleanly with ROS projections.
function _buildYtdTeamLines(valuesByStat) {
  if (!valuesByStat) return null;
  const v = id => {
    const x = valuesByStat[id] != null ? valuesByStat[id] : valuesByStat[String(id)];
    return (typeof x === "number" && isFinite(x)) ? x : 0;
  };
  const S = ESPN_STAT_ID;
  const ab = v(S.AB), bb = v(S.BB), hbp = v(S.HBP), sf = v(S.SF);
  const ipOuts = v(S.IP_OUTS);
  const hit = {
    name: "__ytd_hit__", type: "H", _ytd: true,
    R: v(S.R), HR: v(S.HR), RBI: v(S.RBI), SB: v(S.SB),
    AB: ab, H: v(S.H), BB: bb, HBP: hbp, SF: sf, PA: ab + bb + hbp + sf,
  };
  const pit = {
    name: "__ytd_pit__", type: "P", _ytd: true,
    K: v(S.K), QS: v(S.QS), SV: v(S.SV), HLD: v(S.HLD),
    IP: ipOuts / 3, ER: v(S.ER), HA: v(S.P_H), BBA: v(S.P_BB),
  };
  return [hit, pit];
}

// How each rostered player was acquired (DRAFT / ADD / TRADE), keyed by
// normalized name. Keeper pricing needs this to tell FAAB adds ($6 keepers,
// dead draft contract) from held or traded contracts (cost basis survives).
// Refreshed on every roster parse; cached in localStorage so the answer
// survives reloads before this session has pulled rosters. Refetchable cache —
// deliberately NOT in the device-sync whitelist.
const ESPN_ACQ_KEY = "ud_espn_acq_v1";
let _espnAcqByName = null;
function _espnAcqNorm(s) {
  return (typeof normalizePlayerName === "function")
    ? normalizePlayerName(s) : String(s || "").toLowerCase();
}
function _updateEspnAcqMap(rosters) {
  const map = {};
  for (const players of Object.values(rosters || {})) {
    for (const p of players) {
      if (p && p.acquisitionType) map[_espnAcqNorm(p.name)] = p.acquisitionType;
    }
  }
  if (!Object.keys(map).length) return;   // never clobber the cache with an empty parse
  _espnAcqByName = map;
  try { localStorage.setItem(ESPN_ACQ_KEY, JSON.stringify(map)); } catch (e) {}
}
function espnAcquisitionType(name) {
  if (_espnAcqByName === null) {
    try { _espnAcqByName = JSON.parse(localStorage.getItem(ESPN_ACQ_KEY) || "null") || {}; }
    catch (e) { _espnAcqByName = {}; }
  }
  return _espnAcqByName[_espnAcqNorm(name)] || null;
}

// Parse a raw mTeam+mRoster response into normalized data keyed by OUR internal
// team ids. Exported so the test harness / cached samples reuse it. Returns:
//   rosters     — current roster players (names + per-player stats) per team
//   ytdTeam     — { teamId: [hitLine, pitLine] } from ESPN's valuesByStat
//   espnPoints  — { teamId: ESPN's official total roto points } (sanity ref)
function parseEspnRosters(data, sourceId) {
  sourceId = sourceId === 1 ? 1 : 0;
  const season = ESPN.season;
  const rosters = {};
  const teamMeta = {};
  const ytdTeam = {};
  const espnPoints = {};
  const gsUsed = {};     // team's games-started used this season (for the 200 GS cap)
  const unmappedIds = []; // ESPN team ids we couldn't map to an owner (diagnostic)
  for (const t of (data.teams || [])) {
    const ourId = espnTeamIdToOwnerId(t.id);
    if (!ourId) { unmappedIds.push(t.id); continue; }
    const entries = t.roster?.entries || [];
    rosters[ourId] = entries
      .map(e => _normalizeEspnPlayer(e, season, sourceId))
      .filter(Boolean);
    const ytdLines = _buildYtdTeamLines(t.valuesByStat);
    if (ytdLines) ytdTeam[ourId] = ytdLines;
    const vbs = t.valuesByStat || {};
    gsUsed[ourId] = (vbs[ESPN_STAT_ID.GS] != null ? vbs[ESPN_STAT_ID.GS] : vbs[String(ESPN_STAT_ID.GS)]) || 0;
    if (typeof t.points === "number") espnPoints[ourId] = t.points;
    teamMeta[ourId] = {
      espnId: t.id,
      name: ((t.location || "") + " " + (t.nickname || "")).trim() || ("Team " + t.id),
      abbrev: t.abbrev,
      playerCount: rosters[ourId].length,
    };
  }
  _updateEspnAcqMap(rosters);
  return { rosters, teamMeta, ytdTeam, espnPoints, gsUsed, season, sourceId,
    rawTeamCount: (data.teams || []).length, unmappedIds };
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
  const r = await fetch(url, { cache: "no-store", headers: proxyHeaders() });
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
  const _penNk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  let added = 0;
  for (const raw of rawPicks) {
    if (existing.has(raw.playerId)) continue;
    // Manual↔feed dedup (spec Q3): a pick recorded MANUALLY (no espnPlayerId)
    // that the feed later delivers must not double-count — UPGRADE the manual
    // pick in place (attach the ESPN identity) instead of adding a duplicate.
    const manual = raw.playerName && _liveDraft.picks.find(p =>
      p.espnPlayerId == null && _penNk(p.player) === _penNk(raw.playerName));
    if (manual) {
      manual.espnPlayerId = raw.playerId;
      manual.espnTeamId = raw.teamId;
      // Re-key the team to the feed's winner too (same rule as the insert path):
      // a manual pick recorded to my seat that the feed later attributes to
      // another team must move to that team, or computeLiveTeamStates counts its
      // price against BOTH teams (its `team` id AND espnTeamId) — corrupting
      // budgets/max-bids and tripping the I-MONEY Σ invariant.
      manual.team = (typeof draftTestMode === "function" && draftTestMode()) ? ("espn:" + raw.teamId) : espnTeamIdToOwnerId(raw.teamId);
      manual.espnSeq = raw.seq != null ? raw.seq : null;
      existing.add(raw.playerId);
      added++;   // state changed → save + re-render below
      continue;
    }
    _liveDraft.picks.push({
      player: raw.playerName,
      pos: getPlayerValue(raw.playerName)?.posKey || null,
      // Mock picks belong to generic "espn:N" teams, never to real owners
      // (the old mapping put strangers' picks on real leaguemates' ledgers).
      team: (typeof draftTestMode === "function" && draftTestMode()) ? ("espn:" + raw.teamId) : espnTeamIdToOwnerId(raw.teamId),
      espnTeamId: raw.teamId,          // raw ESPN id — for honest labels in test mode
      // Auction minimum is $1 — a SOLD frame with a missing/zero amount is a
      // parse gap, never a real price ($0 exists only on keeper contracts).
      price: (raw.bidAmount > 0 ? raw.bidAmount : 1),
      ts: Date.now(),
      espnPlayerId: raw.playerId,
      espnSeq: raw.seq != null ? raw.seq : null,   // ESPN lot seq — distinguishes a re-sale from a repeated frame
    });
    added++;
  }
  if (added) {
    saveLiveDraft();
    // A mock fast-forward suppresses per-pick renders and rebuilds once at the end;
    // otherwise render without stealing a focused lobby text field (R10).
    if (currentView === "draft" && !(typeof mockFeedPumping === "function" && mockFeedPumping())) {
      if (typeof _renderDraftUnlessTyping === "function") _renderDraftUnlessTyping(); else renderDraft();
    }
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
