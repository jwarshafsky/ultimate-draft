// League data assembly for the Telegram bot — Worker-side.
//
// Builds the same "projected final standings" model the app's Standings tab
// shows, but entirely server-side:
//
//   ESPN live (mTeam+mRoster, via cookies)      → YTD team totals + rosters
//   Jeff's imported ROS projections (KV mirror) → per-player rest-of-season
//   js/core/standings.js (imported — the REAL engine, not a copy)
//                                               → roto math + Monte Carlo odds
//
// PROVENANCE / KEEP-IN-SYNC NOTES — three blocks below are verbatim copies of
// pure functions that live in browser-coupled files and can't be imported:
//   - ESPN roster normalization   ← js/data/espn.js (_normalizeEspnPlayer etc.)
//   - lineup optimizer            ← js/features/standings.js (buildLineup etc.)
//   - name normalize + ROS lookup ← js/data/ros-projections.js
// If those change in the app, mirror the change here.

import "../js/core/standings.js";
import { espnFetch, ESPN_BASE } from "./espn-fetch.js";

const E = globalThis.UDStandings; // computeStandings, simulateTitleOdds, ...

export const LEAGUE_ID = 1200;

// ESPN team id → ultimate-draft owner id (matches js/data/espn.js).
const ESPN_TEAM_ID_MAP = {
  1: "matt", 2: "saxton", 3: "sam", 4: "glix", 5: "jeff",
  6: "aj", 7: "corey", 8: "jd", 9: "wein", 10: "klin",
  12: "dave", 13: "jtl",
};
// Display names + The League app team ids (data.js contracts).
export const TEAMS = {
  matt:    { label: "Matt",      leagueAppId: "matt" },
  saxton:  { label: "Saxton",    leagueAppId: "saxton" },
  sam:     { label: "Sam",       leagueAppId: "sam" },
  glix:    { label: "Glicksman", leagueAppId: "glicksman" },
  jeff:    { label: "Jeff",      leagueAppId: "jeff" },
  aj:      { label: "AJ",        leagueAppId: "aj" },
  corey:   { label: "Corey",     leagueAppId: "corey" },
  jd:      { label: "Josh/Doug", leagueAppId: "josh-doug" },
  wein:    { label: "Larry",     leagueAppId: "larry" },
  klin:    { label: "Zack",      leagueAppId: "zack" },
  dave:    { label: "Dave",      leagueAppId: "dave" },
  jtl:     { label: "Jesse",     leagueAppId: "jesse" },
};
export function teamLabel(tid) { return TEAMS[tid] ? TEAMS[tid].label : tid; }

// Resolve a user-supplied team reference ("jeff", "Josh", "glicksman", "MV3")
// to an owner id. Returns null if no unambiguous match.
export function resolveTeam(q) {
  if (!q) return null;
  const s = String(q).toLowerCase().trim();
  if (TEAMS[s]) return s;
  const hits = Object.entries(TEAMS).filter(([id, t]) =>
    t.label.toLowerCase().includes(s) || t.leagueAppId.toLowerCase() === s ||
    t.label.toLowerCase().split("/").some(part => part.startsWith(s)));
  return hits.length === 1 ? hits[0][0] : null;
}

// ---------------------------------------------------------------------------
// Name normalization — copied from js/data/ros-projections.js
// ---------------------------------------------------------------------------
export function normalizePlayerName(s) {
  if (!s) return "";
  let n = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  n = n.toLowerCase().replace(/[.'`’]/g, "").replace(/[^a-z0-9 ]/g, " ");
  n = n.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "");
  return n.replace(/\s+/g, " ").trim();
}
export function coreNameKey(name) {
  const toks = normalizePlayerName(name).split(" ").filter(Boolean);
  if (toks.length <= 2) return toks.join(" ");
  const mids = toks.slice(1, -1).filter(t => t.length > 1);
  return [toks[0], ...mids, toks[toks.length - 1]].join(" ");
}

// ---------------------------------------------------------------------------
// ESPN roster normalization — copied from js/data/espn.js
// ---------------------------------------------------------------------------
const ESPN_STAT_ID = {
  AB: 0, H: 1, HR: 5, BB: 10, HBP: 12, SF: 13, PA: 16, OBP: 17, R: 20, RBI: 21, SB: 23,
  GS: 33, IP_OUTS: 34, P_H: 37, P_BB: 39, WHIP: 41, ER: 45, ERA: 47, K: 48, W: 53, SV: 57, HLD: 60, QS: 63,
};
function _statById(map, id) {
  if (!map) return null;
  const v = map[id] != null ? map[id] : map[String(id)];
  return (typeof v === "number" && isFinite(v)) ? v : null;
}
function _entrySample(s) {
  const m = (s && s.stats) || {};
  const ab = _statById(m, ESPN_STAT_ID.AB) || 0;
  const bb = _statById(m, ESPN_STAT_ID.BB) || 0;
  const outs = _statById(m, ESPN_STAT_ID.IP_OUTS) || 0;
  return ab + bb + outs;
}
function _pickStatEntry(player, season, sourceId) {
  const arr = (player && player.stats) || [];
  const matches = arr.filter(s => s.statSourceId === sourceId && Number(s.seasonId) === Number(season));
  if (!matches.length) return null;
  const seasonSplit = matches.find(s => s.statSplitTypeId === 0);
  if (seasonSplit) return seasonSplit;
  return matches.reduce((best, s) => (_entrySample(s) > _entrySample(best) ? s : best), matches[0]);
}
const _ESPN_POS_BY_ID = { 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH" };
function _espnPosLabel(dpid, slots) {
  if (dpid === 1) return (slots || []).includes(14) ? "RP" : "SP";
  return _ESPN_POS_BY_ID[dpid] || "UT";
}
function _normalizeEspnPlayer(entry, season, sourceId) {
  const player = (entry && entry.playerPoolEntry && entry.playerPoolEntry.player) || (entry && entry.player);
  if (!player) return null;
  const slots = player.eligibleSlots || [];
  const hasHitSlot = slots.some(s => s >= 0 && s <= 12);
  const hasPitSlot = slots.includes(13) || slots.includes(14) || slots.includes(15);
  const twoWay = hasHitSlot && hasPitSlot;
  const isPitcher = !twoWay && ((player.defaultPositionId === 1) ||
    (slots.includes(13) || slots.includes(14)) && !slots.some(s => s >= 0 && s <= 12 && s !== 1));
  const se = _pickStatEntry(player, season, sourceId);
  const m = (se && se.stats) || {};
  const name = player.fullName || ("Player " + player.id);
  const pos = _espnPosLabel(player.defaultPositionId, slots);
  if (isPitcher) {
    const ipOuts = _statById(m, ESPN_STAT_ID.IP_OUTS);
    return {
      name, espnId: player.id, type: "P", pos, eligibleSlots: slots, twoWay,
      injuryStatus: player.injuryStatus || null, lineupSlotId: entry.lineupSlotId,
      K: _statById(m, ESPN_STAT_ID.K) || 0,
      QS: _statById(m, ESPN_STAT_ID.QS) || 0,
      SV: _statById(m, ESPN_STAT_ID.SV) || 0,
      HLD: _statById(m, ESPN_STAT_ID.HLD) || 0,
      GS: _statById(m, ESPN_STAT_ID.GS) || 0,
      IP: ipOuts != null ? ipOuts / 3 : 0,
      ER: _statById(m, ESPN_STAT_ID.ER),
      HA: _statById(m, ESPN_STAT_ID.P_H),
      BBA: _statById(m, ESPN_STAT_ID.P_BB),
      ERA: _statById(m, ESPN_STAT_ID.ERA),
      WHIP: _statById(m, ESPN_STAT_ID.WHIP),
    };
  }
  return {
    name, espnId: player.id, type: "H", pos, eligibleSlots: slots, twoWay,
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

// ---------------------------------------------------------------------------
// Lineup optimizer — copied from js/features/standings.js (buildLineup et al.)
// ---------------------------------------------------------------------------
const LINEUP_HIT_SLOTS = [
  { id: 0, cap: 1 }, { id: 1, cap: 1 }, { id: 2, cap: 1 }, { id: 3, cap: 1 },
  { id: 4, cap: 1 }, { id: 5, cap: 5 }, { id: 6, cap: 1 }, { id: 7, cap: 1 }, { id: 12, cap: 1 },
];
const LINEUP_HIT_TRY = [0, 1, 2, 3, 4, 5, 6, 7, 12];
const ESPN_IL_SLOT = 17;
const GS_CAP = 200;
const TWO_WAY_PA_PER_START = 4.5;
const BENCH_PA_FRAC = 0.5;

function _hitValue(r) {
  return (r.R || 0) * 0.7 + (r.RBI || 0) * 0.7 + (r.HR || 0) * 1.3 + (r.SB || 0) * 1.4 +
    Math.max(0, (r.OBP || 0) - 0.300) * (r.PA || 0) * 3;
}
function _pitValue(r) {
  const ip = r.IP || 0;
  return (r.K || 0) * 0.3 + (r.QS || 0) * 2.5 + ((r.SV || 0) + (r.HLD || 0)) * 1.8 +
    Math.max(0, 4.20 - (r.ERA || 9)) * ip * 0.3 + Math.max(0, 1.28 - (r.WHIP || 9)) * ip * 0.5;
}
function _scalePitcher(r, f) {
  return { ...r, IP: (r.IP || 0) * f, ER: (r.ER || 0) * f, HA: (r.HA || 0) * f,
    BBA: (r.BBA || 0) * f, K: (r.K || 0) * f, QS: (r.QS || 0) * f, GS: (r.GS || 0) * f };
}
function _scaleHitter(r, f) {
  return { ...r, R: (r.R || 0) * f, HR: (r.HR || 0) * f, RBI: (r.RBI || 0) * f, SB: (r.SB || 0) * f,
    H: (r.H || 0) * f, BB: (r.BB || 0) * f, HBP: (r.HBP || 0) * f, SF: (r.SF || 0) * f,
    AB: (r.AB || 0) * f, PA: (r.PA || 0) * f };
}
function _reduceHitterPA(r, lostPA) {
  const pa = r.PA || 0;
  if (pa <= 0 || lostPA <= 0) return r;
  return _scaleHitter(r, Math.max(0, (pa - lostPA) / pa));
}

function optimizeStarters(poolPlayers, gsRemaining) {
  const ilOf = p => p.lineupSlotId === ESPN_IL_SLOT;
  const all = poolPlayers || [];
  const valid = all.filter(p => p.ros);
  const lines = [];

  const hPool = valid.filter(p => p.type === "H");
  const paDesc = hPool.map(p => p.ros.PA || 0).sort((a, b) => b - a);
  const nFull = Math.min(13, paDesc.length);
  const fullSlotPA = nFull ? paDesc.slice(0, nFull).reduce((s, x) => s + x, 0) / nFull : 0;
  const _perPA = p => _hitValue(p.ros) / Math.max(1, p.ros.PA || 0);
  const avgPerPA = hPool.length ? hPool.reduce((s, p) => s + _perPA(p), 0) / hPool.length : 0;
  const replPerPA = 0.6 * avgPerPA;
  const slotScore = p => _hitValue(p.ros) + replPerPA * Math.max(0, fullSlotPA - (p.ros.PA || 0));

  const hitters = hPool.sort((a, b) => slotScore(b) - slotScore(a));
  const open = {};
  for (const s of LINEUP_HIT_SLOTS) open[s.id] = s.cap;
  const benched = [];
  const started = [];
  for (const p of hitters) {
    const elig = new Set(p.eligibleSlots || []);
    let placed = null;
    for (const sid of LINEUP_HIT_TRY) {
      if (open[sid] > 0 && elig.has(sid)) { open[sid]--; placed = sid; break; }
    }
    if (placed != null) { lines.push(p.ros); started.push(p); }
    else benched.push(p);
  }
  if (started.length) {
    let budget = BENCH_PA_FRAC * fullSlotPA;
    for (const h of started) budget += Math.max(0, fullSlotPA - (h.ros.PA || 0));
    for (const bh of benched) {
      if (budget < 1) break;
      const bhPA = bh.ros.PA || 0;
      if (bhPA <= 0) continue;
      const fillPA = Math.min(budget, fullSlotPA);
      lines.push(_scaleHitter(bh.ros, fillPA / bhPA));
      budget -= fillPA;
    }
  }

  const sps = [];
  for (const p of valid.filter(x => x.type === "P")) {
    const gs = p.ros.GS || 0;
    if (gs >= 1) sps.push({ ros: p.ros, gs, vps: _pitValue(p.ros) / Math.max(1, gs) });
    else lines.push(p.ros);
  }
  sps.sort((a, b) => b.vps - a.vps);
  let budget = (gsRemaining == null) ? Infinity : Math.max(0, gsRemaining);
  for (const s of sps) {
    if (budget <= 0) continue;
    if (s.gs <= budget) { lines.push(s.ros); budget -= s.gs; }
    else { lines.push(_scalePitcher(s.ros, budget / s.gs)); budget = 0; }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// ROS projections from the device-sync KV mirror (ud_ros_* keys)
// ---------------------------------------------------------------------------
const ROS_SOURCES = ["steamer_ros", "batx_ros", "atc_ros"];
const ROS_LABELS = { steamer_ros: "Steamer ROS", batx_ros: "THE BAT X ROS", atc_ros: "ATC ROS" };

async function loadRosFromKV(env) {
  // Device-sync keys are "u:<supabaseUserId>:<localStorageKey>". Single-user
  // deployment (SYNC_ALLOWED_EMAILS has one entry), so scan for the ud_ros_
  // suffixes rather than hardcoding the user id.
  const found = {};
  let cursor;
  do {
    const page = await env.UD_SYNC.list({ prefix: "u:", cursor });
    for (const k of page.keys) {
      for (const src of ROS_SOURCES) {
        if (k.name.endsWith(":ud_ros_" + src + "_v1")) found[src] = k.name;
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  for (const src of ROS_SOURCES) {          // app's firstLoadedRosSource() order
    if (!found[src]) continue;
    try {
      const raw = JSON.parse(await env.UD_SYNC.get(found[src]) || "null");
      if (raw && ((raw.hitters || []).length || (raw.pitchers || []).length)) {
        return { sourceId: src, label: ROS_LABELS[src], data: raw };
      }
    } catch (e) { /* fall through to next source */ }
  }
  return null;
}

// Index + lookup — mirrors _buildIndex/getRosLine in js/data/ros-projections.js.
function buildRosIndex(data) {
  const idx = { H: new Map(), P: new Map(), Hc: new Map(), Pc: new Map() };
  for (const h of (data.hitters || [])) {
    const k = normalizePlayerName(h.name), ex = idx.H.get(k);
    if (!ex || (h.PA || 0) > (ex.PA || 0)) idx.H.set(k, h);
    const ck = coreNameKey(h.name), exc = idx.Hc.get(ck);
    if (!exc || (h.PA || 0) > (exc.PA || 0)) idx.Hc.set(ck, h);
  }
  for (const p of (data.pitchers || [])) {
    const k = normalizePlayerName(p.name), ex = idx.P.get(k);
    if (!ex || (p.IP || 0) > (ex.IP || 0)) idx.P.set(k, p);
    const ck = coreNameKey(p.name), exc = idx.Pc.get(ck);
    if (!exc || (p.IP || 0) > (exc.IP || 0)) idx.Pc.set(ck, p);
  }
  return idx;
}
function _rosHasStats(rec, type) {
  const ks = type === "P" ? ["K", "QS", "SV", "HLD", "IP", "ERA"] : ["R", "HR", "RBI", "SB", "OBP", "PA"];
  return ks.some(k => { const v = rec[k]; return v != null && isFinite(v) && Number(v) !== 0; });
}
function getRosLine(idx, name, type) {
  if (!idx) return null;
  if (type === "P") {
    const p = idx.P.get(normalizePlayerName(name)) || idx.Pc.get(coreNameKey(name));
    if (!p || !_rosHasStats(p, "P")) return null;
    return { name: p.name, type: "P", K: p.K, QS: p.QS, SV: p.SV, HLD: p.HLD, GS: p.GS || 0,
      IP: p.IP, ER: p.ER || null, HA: p.HA || null, BBA: p.BBA || null, ERA: p.ERA, WHIP: p.WHIP };
  }
  const h = idx.H.get(normalizePlayerName(name)) || idx.Hc.get(coreNameKey(name));
  if (!h || !_rosHasStats(h, "H")) return null;
  return { name: h.name, type: "H", R: h.R, HR: h.HR, RBI: h.RBI, SB: h.SB,
    OBP: h.OBP, PA: h.PA, AB: h.AB || null, H: h.H || null, BB: h.BB || null,
    HBP: h.HBP || null, SF: h.SF || null };
}

// Calendar estimate of the fraction of the MLB regular season still unplayed —
// copied from js/features/standings.js seasonFractionRemaining().
export function seasonFractionRemaining(season) {
  const now = new Date();
  const start = new Date(season, 2, 27);
  const end = new Date(season, 8, 28);
  if (now <= start) return 1;
  if (now >= end) return 0.03;
  return Math.max(0, Math.min(1, (end - now) / (end - start)));
}

// ---------------------------------------------------------------------------
// League assembly
// ---------------------------------------------------------------------------

// One assembled snapshot per Worker invocation (tool calls within a single
// Telegram question share it; isolates re-fetch cost, not staleness).
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 4 * 60 * 1000;

export async function assembleLeague(env) {
  if (_cache && (Date.now() - _cacheAt) < CACHE_MS) return _cache;

  const season = new Date().getFullYear();
  const url = ESPN_BASE + "/seasons/" + season + "/segments/0/leagues/" + LEAGUE_ID + "?view=mTeam&view=mRoster";
  const [data, ros] = await Promise.all([espnFetch(url, env), loadRosFromKV(env)]);

  const rosIdx = ros ? buildRosIndex(ros.data) : null;
  const frac = seasonFractionRemaining(season);

  const rosters = {}, ytdTeam = {}, gsUsed = {}, espnPoints = {}, teamMeta = {};
  for (const t of (data.teams || [])) {
    const tid = ESPN_TEAM_ID_MAP[t.id];
    if (!tid) continue;
    const entries = (t.roster && t.roster.entries) || [];
    rosters[tid] = entries.map(e => _normalizeEspnPlayer(e, season, 0)).filter(Boolean);
    // ESPN full-season projections per player (fallback ROS when no FanGraphs
    // source is imported): sourceId 1, prorated by the season fraction left.
    const projByName = {};
    for (const e of entries) {
      const pr = _normalizeEspnPlayer(e, season, 1);
      if (pr) projByName[normalizePlayerName(pr.name)] = pr;
    }
    const ytd = _buildYtdTeamLines(t.valuesByStat);
    if (ytd) ytdTeam[tid] = ytd;
    const vbs = t.valuesByStat || {};
    gsUsed[tid] = (vbs[ESPN_STAT_ID.GS] != null ? vbs[ESPN_STAT_ID.GS] : vbs[String(ESPN_STAT_ID.GS)]) || 0;
    if (typeof t.points === "number") espnPoints[tid] = t.points;
    teamMeta[tid] = { espnId: t.id, abbrev: t.abbrev, projByName };
  }

  // Per-team pools: every rostered player paired with its ROS line — mirrors
  // _buildPool() in js/features/standings.js (incl. two-way split + PA dock).
  let matched = 0, total = 0;
  const rosLineFor = (tid, p, type) => {
    if (rosIdx) return getRosLine(rosIdx, p.name, type);
    // Fallback: ESPN preseason full-season projection, prorated to ROS.
    const pr = (teamMeta[tid].projByName || {})[normalizePlayerName(p.name)];
    if (!pr || pr.type !== type) return null;
    const scaled = type === "P" ? _scalePitcher(pr, frac) : _scaleHitter(pr, frac);
    return scaled;
  };
  const pools = {};
  for (const [tid, players] of Object.entries(rosters)) {
    const arr = [];
    const mk = (p, type, ros) => ({ name: p.name, type, eligibleSlots: p.eligibleSlots || [],
      lineupSlotId: p.lineupSlotId, injuryStatus: p.injuryStatus, ros });
    for (const p of players) {
      if (p.twoWay) {
        const pitRos = rosLineFor(tid, p, "P");
        let hitRos = rosLineFor(tid, p, "H");
        if (hitRos && pitRos) hitRos = _reduceHitterPA(hitRos, TWO_WAY_PA_PER_START * (pitRos.GS || 0));
        arr.push(mk(p, "H", hitRos));
        arr.push(mk(p, "P", pitRos));
      } else {
        arr.push(mk(p, p.type, rosLineFor(tid, p, p.type)));
      }
    }
    const nonIl = arr.filter(p => p.lineupSlotId !== ESPN_IL_SLOT);
    total += nonIl.length;
    matched += nonIl.filter(p => p.ros).length;
    pools[tid] = arr;
  }

  _cache = {
    season, frac, rosters, ytdTeam, gsUsed, espnPoints, teamMeta, pools,
    rosSource: ros ? ros.label : "ESPN preseason projections (prorated) — no FanGraphs ROS import found",
    coverage: { matched, total },
  };
  _cacheAt = Date.now();
  return _cache;
}

// Full-season projected stat lines (YTD banked + optimized ROS lineup) — the
// app's "full" mode. `poolOverrides` swaps specific teams' pools (what-ifs).
export function buildFinalLines(league, poolOverrides) {
  const out = {};
  for (const tid of Object.keys(league.pools)) {
    const pool = (poolOverrides && poolOverrides[tid]) || league.pools[tid];
    const gsRem = Math.max(0, GS_CAP - (league.gsUsed[tid] || 0));
    const starters = optimizeStarters(pool, gsRem).map(r => ({ ...r, _ros: true }));
    out[tid] = (league.ytdTeam[tid] || []).concat(starters);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reports (tool outputs)
// ---------------------------------------------------------------------------
const CATS = ["R", "HR", "RBI", "SB", "OBP", "QS", "K", "SV_HLD", "ERA", "WHIP"];
function fmtCat(cat, v) {
  if (v == null || !isFinite(v)) return "-";
  if (cat === "OBP") return v.toFixed(3).replace(/^0/, "");
  if (cat === "ERA" || cat === "WHIP") return v.toFixed(2);
  return String(Math.round(v));
}
function r1(x) { return Math.round(x * 10) / 10; }
function pct(p) { return (p * 100 < 1 && p > 0) ? "<1%" : Math.round(p * 100) + "%"; }

function standingsTable(computed, odds) {
  return computed.teams.map(t => ({
    place: t.place,
    team: teamLabel(t.teamId),
    rotoPoints: r1(t.rotoPoints),
    pFirst: odds ? pct(odds.byTeam[t.teamId].pFirst) : undefined,
    pTop3: odds ? pct(odds.byTeam[t.teamId].pTop3) : undefined,
    avgFinish: odds ? r1(odds.byTeam[t.teamId].avgFinish) : undefined,
    cats: Object.fromEntries(CATS.map(c => [c, fmtCat(c, t.byCat[c].value) + " (" + r1(t.byCat[c].points) + "pt)"])),
  }));
}

export function projectedStandingsReport(league, sims) {
  const lines = buildFinalLines(league);
  const computed = E.computeStandings(lines);
  const odds = E.simulateTitleOdds(lines, { sims: sims || 3000, fracRemaining: league.frac });
  const current = E.computeStandings(league.ytdTeam);
  return {
    projectionSource: league.rosSource,
    rosCoverage: league.coverage.matched + "/" + league.coverage.total + " rostered players matched to a ROS line",
    seasonFractionRemaining: r1(league.frac * 100) / 100,
    projectedFinal: standingsTable(computed, odds),
    currentYTD: current.teams.map(t => ({
      place: t.place, team: teamLabel(t.teamId), rotoPoints: r1(t.rotoPoints),
      espnOfficialPoints: league.espnPoints[t.teamId],
    })),
  };
}

// Find a rostered player by (fuzzy) name across all teams. Returns
// { tid, player } or { suggestions } on ambiguity/miss.
export function findRosteredPlayer(league, name) {
  const key = normalizePlayerName(name);
  const core = coreNameKey(name);
  const hits = [];
  for (const [tid, players] of Object.entries(league.rosters)) {
    for (const p of players) {
      const pk = normalizePlayerName(p.name);
      if (pk === key || coreNameKey(p.name) === core) hits.push({ tid, player: p, exact: true });
      else if (pk.includes(key) || key.includes(pk)) hits.push({ tid, player: p, exact: false });
    }
  }
  const exact = hits.filter(h => h.exact);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact[0];         // same player name twice = same person
  if (hits.length === 1) return hits[0];
  return { suggestions: hits.slice(0, 5).map(h => h.player.name + " (" + teamLabel(h.tid) + ")") };
}

// Simulate a trade: players move between two teams, standings + title odds
// recomputed for the whole league. Mirrors _computeTradeImpact() in
// js/features/standings.js.
export function simulateTradeReport(league, spec) {
  const a = resolveTeam(spec.team_a), b = resolveTeam(spec.team_b);
  if (!a) return { error: "Unknown team: " + spec.team_a };
  if (!b) return { error: "Unknown team: " + spec.team_b };
  if (a === b) return { error: "team_a and team_b are the same team" };

  const move = { [a]: { out: [], in: [] }, [b]: { out: [], in: [] } };
  const resolve = (names, fromTid, toTid) => {
    for (const n of (names || [])) {
      const hit = findRosteredPlayer(league, n);
      if (!hit.player) return "Player not found: \"" + n + "\"" +
        (hit.suggestions && hit.suggestions.length ? " — did you mean: " + hit.suggestions.join(", ") + "?" : "");
      if (hit.tid !== fromTid) return "\"" + hit.player.name + "\" is on " + teamLabel(hit.tid) +
        "'s roster, not " + teamLabel(fromTid) + "'s.";
      move[fromTid].out.push(hit.player.name);
      move[toTid].in.push(hit.player.name);
    }
    return null;
  };
  const err = resolve(spec.team_a_sends, a, b) || resolve(spec.team_b_sends, b, a);
  if (err) return { error: err };
  if (!move[a].out.length && !move[b].out.length) return { error: "No players specified on either side." };

  // Swap pool entries (they carry the ROS line + eligibility already).
  const nameSet = arr => new Set(arr.map(normalizePlayerName));
  const poolAfter = (tid, other) => {
    const outSet = nameSet(move[tid].out), inSet = nameSet(move[tid].in);
    const kept = league.pools[tid].filter(p => !outSet.has(normalizePlayerName(p.name)));
    const gained = league.pools[other].filter(p => inSet.has(normalizePlayerName(p.name)));
    return kept.concat(gained);
  };
  const overrides = { [a]: poolAfter(a, b), [b]: poolAfter(b, a) };

  const sims = Math.min(Math.max(spec.sims || 2500, 500), 5000);
  const beforeLines = buildFinalLines(league);
  const afterLines = buildFinalLines(league, overrides);
  const before = E.computeStandings(beforeLines);
  const after = E.computeStandings(afterLines);
  const oddsB = E.simulateTitleOdds(beforeLines, { sims, fracRemaining: league.frac });
  const oddsA = E.simulateTitleOdds(afterLines, { sims, fracRemaining: league.frac });

  const teamReport = (tid) => {
    const bt = before.teams.find(t => t.teamId === tid);
    const at = after.teams.find(t => t.teamId === tid);
    const catChanges = [];
    for (const cat of CATS) {
      const d = at.byCat[cat].points - bt.byCat[cat].points;
      if (Math.abs(d) > 0.05) catChanges.push({ cat, pointsDelta: r1(d),
        valueBefore: fmtCat(cat, bt.byCat[cat].value), valueAfter: fmtCat(cat, at.byCat[cat].value) });
    }
    catChanges.sort((x, y) => Math.abs(y.pointsDelta) - Math.abs(x.pointsDelta));
    return {
      team: teamLabel(tid),
      sends: move[tid].out, receives: move[tid].in,
      rotoPoints: { before: r1(bt.rotoPoints), after: r1(at.rotoPoints), delta: r1(at.rotoPoints - bt.rotoPoints) },
      place: { before: bt.place, after: at.place },
      titleOdds: { before: pct(oddsB.byTeam[tid].pFirst), after: pct(oddsA.byTeam[tid].pFirst) },
      top3Odds: { before: pct(oddsB.byTeam[tid].pTop3), after: pct(oddsA.byTeam[tid].pTop3) },
      categorySwings: catChanges,
    };
  };

  return {
    projectionSource: league.rosSource,
    sims,
    note: "Full-season projection = banked YTD stats + optimized rest-of-season lineup. " +
      "Odds from Monte Carlo re-ranking with per-category volatility scaled to the season fraction remaining (" +
      Math.round(league.frac * 100) + "% left).",
    teamA: teamReport(a),
    teamB: teamReport(b),
    leagueAfter: after.teams.map(t => ({ place: t.place, team: teamLabel(t.teamId), rotoPoints: r1(t.rotoPoints) })),
  };
}

// Roster report for one team (YTD key stats + ROS availability).
export function rosterReport(league, teamQuery) {
  const tid = resolveTeam(teamQuery);
  if (!tid) return { error: "Unknown team: " + teamQuery + ". Teams: " + Object.values(TEAMS).map(t => t.label).join(", ") };
  const pool = league.pools[tid];
  const players = league.rosters[tid].map(p => {
    const poolEntry = pool.find(x => normalizePlayerName(x.name) === normalizePlayerName(p.name) && x.type === p.type) ||
      pool.find(x => normalizePlayerName(x.name) === normalizePlayerName(p.name));
    const base = {
      name: p.name, pos: p.pos,
      status: p.lineupSlotId === ESPN_IL_SLOT ? "IL" : (p.injuryStatus && p.injuryStatus !== "ACTIVE" ? p.injuryStatus : "active"),
      hasRosProjection: !!(poolEntry && poolEntry.ros),
    };
    if (p.type === "P") return { ...base, ytd: { IP: r1(p.IP), K: p.K, QS: p.QS, SV: p.SV, HLD: p.HLD, ERA: p.ERA, WHIP: p.WHIP } };
    return { ...base, ytd: { PA: p.PA, R: p.R, HR: p.HR, RBI: p.RBI, SB: p.SB, OBP: p.OBP } };
  });
  return { team: teamLabel(tid), players };
}

// One player: YTD + ROS line + who rosters him.
export function playerReport(league, name) {
  const hit = findRosteredPlayer(league, name);
  if (!hit.player) {
    return { error: "\"" + name + "\" not found on any roster." +
      (hit.suggestions && hit.suggestions.length ? " Close matches: " + hit.suggestions.join(", ") : "") +
      " (Free agents aren't searchable yet — this bot covers rostered players.)" };
  }
  const p = hit.player;
  const poolEntry = league.pools[hit.tid].find(x => normalizePlayerName(x.name) === normalizePlayerName(p.name));
  const ytd = p.type === "P"
    ? { IP: r1(p.IP), K: p.K, QS: p.QS, SV: p.SV, HLD: p.HLD, ERA: p.ERA, WHIP: p.WHIP }
    : { PA: p.PA, R: p.R, HR: p.HR, RBI: p.RBI, SB: p.SB, OBP: p.OBP };
  return {
    name: p.name, pos: p.pos, team: teamLabel(hit.tid),
    injuryStatus: p.injuryStatus, onIL: p.lineupSlotId === ESPN_IL_SLOT,
    ytd,
    restOfSeasonProjection: (poolEntry && poolEntry.ros) || "(no ROS line matched)",
    projectionSource: league.rosSource,
  };
}

// ---------------------------------------------------------------------------
// Contracts — The League app's data.js (keeper prices), fetched from GH Pages.
// data.js is a JS object literal (not JSON): parse the machine-formatted
// player lines with a regex. Cached in KV for 6h.
// ---------------------------------------------------------------------------
const LEAGUE_APP_DATA_URL = "https://jwarshafsky.github.io/the-league/js/data.js";

export async function contractsReport(env, teamQuery) {
  const CACHE_KEY = "tg:contracts_cache_v1";
  let parsed = null;
  try { parsed = JSON.parse(await env.UD_SYNC.get(CACHE_KEY) || "null"); } catch (e) {}
  if (!parsed || (Date.now() - parsed.at) > 6 * 60 * 60 * 1000) {
    const r = await fetch(LEAGUE_APP_DATA_URL, { headers: { accept: "*/*" } });
    if (!r.ok) throw new Error("League app data.js fetch failed: " + r.status);
    parsed = { at: Date.now(), teams: parseLeagueAppData(await r.text()) };
    await env.UD_SYNC.put(CACHE_KEY, JSON.stringify(parsed), { expirationTtl: 24 * 60 * 60 });
  }
  const note = "Salaries are CURRENT-season keeper prices from The League app (hand-maintained). " +
    "Mid-season FA pickups may be missing; minors/callups carry no ML salary. " +
    "Keeper rules: +$2/yr, 3 extra yrs max (fewer if >$40/$50 — see rules).";
  if (!teamQuery) return { note, teams: parsed.teams };
  const tid = resolveTeam(teamQuery);
  if (!tid) return { error: "Unknown team: " + teamQuery };
  const t = parsed.teams.find(x => x.id === TEAMS[tid].leagueAppId);
  return { note, team: teamLabel(tid), ...t };
}

function parseLeagueAppData(src) {
  const teams = [];
  let cur = null, section = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    const idM = line.match(/^id:\s*"([^"]+)"/);
    if (idM) { cur = { id: idM[1], majors: [], callups: [], minors: [] }; teams.push(cur); section = null; continue; }
    if (!cur) continue;
    const secM = line.match(/^(majors|callups|minors):\s*\[/);
    if (secM) section = /\]\s*,?\s*$/.test(line) ? null : secM[1];   // inline "[]" opens nothing
    const pM = line.match(/\{\s*name:\s*"([^"]+)"(?:.*?price:\s*(\d+))?.*?yearAcquired:\s*(\d{4})/);
    if (pM && section) {
      const entry = { name: pM[1], yearAcquired: Number(pM[3]) };
      if (pM[2] != null) entry.price = Number(pM[2]);
      cur[section].push(entry);
    }
    if (section && /^\],?$/.test(line)) section = null;
  }
  return teams;
}
