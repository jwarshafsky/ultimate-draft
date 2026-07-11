// Cloudflare Worker proxy for Ultimate Draft.
//
// Endpoints:
//   GET  /espn/draft?leagueId=1200&season=2026   → mDraftDetail view
//   GET  /espn/teams?leagueId=...&season=...     → mTeam + mRoster views
//   GET  /espn/players?leagueId=...&season=...   → kona_player_info (top 2000)
//   POST /claude                                  → forwards to Anthropic Messages API
//   POST /telegram                                → Telegram bot webhook (telegram.js)
//
// Required Worker environment secrets:
//   ESPN_S2          — your ESPN session cookie
//   ESPN_SWID        — your ESPN SWID cookie (with curly braces)
//   ANTHROPIC_API_KEY — Anthropic API key for Claude
//   ALLOWED_ORIGIN   — your GitHub Pages origin, e.g. "https://jwarshafsky.github.io"
//   UD_PROXY_KEY     — shared secret; every request must send it as x-ud-key.
//                      Without it the worker is an open relay for the Anthropic
//                      key and ESPN cookies. The app stores it in Settings.
//
// Deploy:
//   npx wrangler deploy
// Configure secrets:
//   npx wrangler secret put ESPN_S2
//   npx wrangler secret put ESPN_SWID
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler secret put ALLOWED_ORIGIN
//   npx wrangler secret put UD_PROXY_KEY

import { espnFetch, ESPN_BASE } from "./espn-fetch.js";
import { handleTelegram } from "./telegram.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";

    // CORS preflight (must not require the key — browsers send it unauthenticated)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed, origin) });
    }

    // Device-sync routes authenticate with the user's Supabase login token
    // (NOT x-ud-key): a freshly-logged-in device must be able to pull its
    // settings — including the proxy key itself — before any are entered.
    if (url.pathname.startsWith("/sync/")) {
      try {
        const user = await verifySupabaseUser(request);
        if (!user) {
          return json({ error: "unauthorized — sign in first" }, 401, corsHeaders(allowed, origin));
        }
        const body = await handleSync(url, request, env, user);
        return json(body, 200, corsHeaders(allowed, origin));
      } catch (e) {
        return json({ error: e.message || String(e) }, 500, corsHeaders(allowed, origin));
      }
    }

    // Telegram webhook — authenticated by its own secret-token header (Telegram
    // can't send x-ud-key), so it sits before the shared-secret gate like /sync.
    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegram(request, env, ctx);
    }

    // Shared-secret gate. Enforced only once UD_PROXY_KEY is configured, so a
    // deploy that races the secret setup fails open briefly instead of dark.
    if (env.UD_PROXY_KEY && request.headers.get("x-ud-key") !== env.UD_PROXY_KEY) {
      return json({ error: "unauthorized — set the proxy key on the Settings tab" }, 401,
        corsHeaders(allowed, origin));
    }

    // Route
    try {
      let body;
      if (url.pathname === "/espn/draft") {
        body = await proxyEspnDraft(url, env);
      } else if (url.pathname === "/espn/draft-capture") {
        body = await captureDraftSocket(url, env);
      } else if (url.pathname === "/espn/teams") {
        body = await proxyEspnTeams(url, env);
      } else if (url.pathname === "/espn/players") {
        body = await proxyEspnPlayers(url, env);
      } else if (url.pathname === "/espn/history") {
        body = await proxyEspnHistory(url, env);
      } else if (url.pathname === "/fangraphs/xwoba") {
        body = await proxyFangraphsXwoba(url);
      } else if (url.pathname === "/rotowire/news") {
        body = await proxyRotowireNews(url);
      } else if (url.pathname === "/claude" && request.method === "POST") {
        body = await proxyClaude(request, env);
      } else {
        return json({ error: "Not found" }, 404, corsHeaders(allowed, origin));
      }
      return json(body, 200, corsHeaders(allowed, origin));
    } catch (e) {
      return json({ error: e.message || String(e) }, 500, corsHeaders(allowed, origin));
    }
  },
};

function corsHeaders(allowed, origin) {
  // Exact-origin match only (plus localhost for dev). The old
  // endsWith(".github.io") check let ANY GitHub Pages site call the proxy.
  const isLocal = /^https?:\/\/localhost(:\d+)?$/.test(origin);
  const allowOrigin = (allowed === "*") ? "*" :
    (origin && (origin === allowed || isLocal)) ? origin : allowed;
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-ud-key,authorization",
    "access-control-max-age": "86400",
  };
}

// --- Device sync (per-user localStorage mirror in KV) ---

const SUPABASE_AUTH_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co/auth/v1/user";
const SUPABASE_ANON_KEY = "sb_publishable_aRh0MmQKrMCr8YnTwv9xIg_1F08WXf2";
const SYNC_ALLOWED_EMAILS = ["jwarshafsky@gmail.com"];

// Token → user micro-cache so bursts of sync calls don't each hit Supabase.
const _tokenCache = new Map();

async function verifySupabaseUser(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const cached = _tokenCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.user;
  const r = await fetch(SUPABASE_AUTH_URL, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  const u = await r.json();
  const email = (u.email || "").toLowerCase();
  if (!u.id || !SYNC_ALLOWED_EMAILS.includes(email)) return null;
  const user = { id: u.id, email };
  _tokenCache.set(token, { user, exp: Date.now() + 5 * 60 * 1000 });
  return user;
}

// KV layout: one entry per synced localStorage key, named "u:<userId>:<key>",
// value = the raw localStorage string, metadata = { at: <client ms timestamp> }.
function _syncKvName(user, key) {
  return "u:" + user.id + ":" + key;
}

async function handleSync(url, request, env, user) {
  const path = url.pathname;
  if (path === "/sync/list" && request.method === "GET") {
    const prefix = "u:" + user.id + ":";
    const keys = {};
    let cursor;
    do {
      const page = await env.UD_SYNC.list({ prefix, cursor });
      for (const k of page.keys) {
        keys[k.name.slice(prefix.length)] = (k.metadata && k.metadata.at) || 0;
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return { keys };
  }
  if (path === "/sync/get" && request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key) throw new Error("missing key");
    const entry = await env.UD_SYNC.getWithMetadata(_syncKvName(user, key));
    if (entry.value == null) return { key, value: null, at: 0 };
    return { key, value: entry.value, at: (entry.metadata && entry.metadata.at) || 0 };
  }
  if (path === "/sync/set" && request.method === "POST") {
    const b = await request.json();
    if (!b || typeof b.key !== "string" || typeof b.value !== "string") {
      throw new Error("body must be { key, value, at }");
    }
    const at = Number(b.at) || Date.now();
    await env.UD_SYNC.put(_syncKvName(user, b.key), b.value, { metadata: { at } });
    return { ok: true, key: b.key, at };
  }
  if (path === "/sync/delete" && request.method === "POST") {
    const b = await request.json();
    if (!b || typeof b.key !== "string") throw new Error("body must be { key }");
    await env.UD_SYNC.delete(_syncKvName(user, b.key));
    return { ok: true, key: b.key };
  }
  throw new Error("unknown sync route: " + path);
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", ...(extraHeaders || {}) },
  });
}

// --- ESPN routes ---
// espnFetch + ESPN_BASE moved to espn-fetch.js (shared with the Telegram bot).

// Sport-configurable base for the draft route (so a football league can be used
// to dry-run live-draft polling). flb = baseball (default), ffl = football.
function espnBaseForSport(sport) {
  const s = /^[a-z]{3}$/.test(sport || "") ? sport : "flb";
  return "https://lm-api-reads.fantasy.espn.com/apis/v3/games/" + s;
}

async function proxyEspnDraft(url, env) {
  const leagueId = url.searchParams.get("leagueId");
  const season = url.searchParams.get("season");
  const sport = url.searchParams.get("sport");   // flb (default) | ffl for a football test
  // mDraftDetail gives playerId but NOT the name; add mRoster so we can resolve
  // names (a drafted player lands on the winning team's roster immediately).
  const target = espnBaseForSport(sport) + "/seasons/" + season + "/segments/0/leagues/" + leagueId + "?view=mDraftDetail&view=mRoster";
  const data = await espnFetch(target, env);
  // Build playerId -> name from current rosters.
  const nameById = {};
  for (const t of (data.teams || [])) {
    for (const e of (t.roster?.entries || [])) {
      const p = e.playerPoolEntry?.player;
      if (p && p.id != null) nameById[p.id] = p.fullName || ((p.firstName || "") + " " + (p.lastName || "")).trim();
    }
  }
  // Normalize the picks array: each pick has playerId, teamId, bidAmount, etc.
  const picks = (data.draftDetail?.picks || []).map(p => ({
    playerId: p.playerId,
    playerName: p.playerName || nameById[p.playerId] || ("Player " + p.playerId),
    teamId: p.teamId,
    bidAmount: p.bidAmount || 0,
    nominator: p.nominatingTeamId,
    overallPickNumber: p.overallPickNumber,
    keeper: !!p.keeper,
  }));
  return {
    picks,
    draftStatus: data.draftDetail?.drafted ? "complete" : "active",
    inProgress: !!data.draftDetail?.inProgress,   // ESPN's own "draft is happening now" flag
    drafted: !!data.draftDetail?.drafted,
  };
}

async function proxyEspnTeams(url, env) {
  const leagueId = url.searchParams.get("leagueId");
  const season = url.searchParams.get("season");
  const target = ESPN_BASE + "/seasons/" + season + "/segments/0/leagues/" + leagueId + "?view=mTeam&view=mRoster";
  return espnFetch(target, env);
}

async function proxyEspnHistory(url, env) {
  const leagueId = url.searchParams.get("leagueId");
  const season = url.searchParams.get("season");
  const currentYear = new Date().getFullYear();

  // lm-api-reads/leagueHistory works for ALL old seasons when the right
  // headers + fresh cookies are sent. (Empirically confirmed via the browser
  // curl that ESPN uses this same endpoint to populate the draftrecap page.)
  const candidates = parseInt(season, 10) < currentYear
    ? ["https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/leagueHistory/" + leagueId + "?seasonId=" + season]
    : [ESPN_BASE + "/seasons/" + season + "/segments/0/leagues/" + leagueId + "?"];

  let data = null;
  let lastError = null;
  for (const base of candidates) {
    const target = base + "&view=mDraftDetail&view=mTeam&view=mRoster";
    try {
      data = await espnFetch(target, env);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!data) throw lastError || new Error("All ESPN endpoints failed for season " + season);

  const sd = Array.isArray(data) ? data[0] : data;
  if (!sd) return { season, picks: [], teamMap: {}, error: "no_data" };

  const teamMap = {};
  for (const t of sd.teams || []) {
    teamMap[t.id] = {
      teamId: t.id,
      location: t.location || "",
      nickname: t.nickname || "",
      name: ((t.location || "") + " " + (t.nickname || "")).trim() || ("Team " + t.id),
      abbrev: t.abbrev,
      owners: t.owners || [],
      primaryOwner: t.primaryOwner || null,
    };
  }

  // Build player map from team rosters (most reliable for historical seasons).
  const playerMap = {};
  for (const t of sd.teams || []) {
    for (const e of (t.roster?.entries || [])) {
      const p = e.playerPoolEntry?.player;
      if (p && !playerMap[p.id]) {
        playerMap[p.id] = {
          name: p.fullName,
          defaultPositionId: p.defaultPositionId,
          eligibleSlots: p.eligibleSlots || [],
        };
      }
    }
  }
  // Fallback to sd.players if present
  for (const p of sd.players || []) {
    if (p.player && !playerMap[p.id]) {
      playerMap[p.id] = {
        name: p.player.fullName,
        defaultPositionId: p.player.defaultPositionId,
        eligibleSlots: p.player.eligibleSlots || [],
      };
    }
  }

  // Resolve a position label. ESPN's defaultPositionId 1 = "Pitcher" generically,
  // so we use eligibleSlots to distinguish SP (slot 13) vs RP (slot 14).
  function resolvePos(info) {
    if (!info) return "";
    const dpid = info.defaultPositionId;
    const slots = info.eligibleSlots || [];
    if (dpid === 1) {
      if (slots.includes(13)) return "SP";
      if (slots.includes(14)) return "RP";
      return "SP";
    }
    const POS_BY_ID = { 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "OF", 8: "OF", 9: "OF", 10: "DH", 11: "RP", 12: "P" };
    return POS_BY_ID[dpid] || "";
  }

  const picks = (sd.draftDetail?.picks || []).map(p => {
    const playerInfo = playerMap[p.playerId] || null;
    const tm = teamMap[p.teamId] || {};
    return {
      overallPickNumber: p.overallPickNumber,
      teamId: p.teamId,
      teamName: tm.name || ("Team " + p.teamId),
      primaryOwner: tm.primaryOwner || null,
      nominatingTeamId: p.nominatingTeamId,
      playerId: p.playerId,
      playerName: (playerInfo && playerInfo.name) || ("Player " + p.playerId),
      pos: resolvePos(playerInfo),
      bidAmount: p.bidAmount || 0,
      keeper: !!p.keeper,
    };
  });
  return { season: parseInt(season, 10), picks, teamMap, playerCount: Object.keys(playerMap).length };
}

async function proxyEspnPlayers(url, env) {
  const leagueId = url.searchParams.get("leagueId");
  const season = url.searchParams.get("season");
  const target = ESPN_BASE + "/seasons/" + season + "/segments/0/leagues/" + leagueId + "?view=kona_player_info";
  const filter = {
    players: {
      limit: 2000,
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
    },
  };
  return espnFetch(target, env, { "x-fantasy-filter": JSON.stringify(filter) });
}

// --- FanGraphs route ---

// Proxy the FanGraphs leaders JSON API for hitter xwOBA over a date window.
// FanGraphs' page/CSV download is bot-protected, but this JSON API endpoint
// responds to plain requests. month=1000 + startdate/enddate = custom range;
// month=0 (no dates) = full season.
// Rotowire baseball news feed (rotowire.com/baseball/news.php). Returns the
// ~25 most recent player news items parsed server-side to JSON so the client
// doesn't ship 350KB of HTML. Free fields only (player, headline, position,
// injury body-part, timestamp, factual news body) — the "Analysis" block is
// paywalled and deliberately not scraped.
async function proxyRotowireNews(url) {
  const target = "https://www.rotowire.com/baseball/news.php";
  const r = await fetch(target, {
    headers: {
      "accept": "text/html",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    },
    cf: { cacheTtl: 180, cacheEverything: true },   // edge-cache 3 min; the feed moves slowly
  });
  if (!r.ok) throw new Error("Rotowire " + r.status);
  const html = await r.text();
  const items = parseRotowireNews(html);
  return { items, fetchedAt: Date.now(), count: items.length };
}

function _rwText(block, pat) {
  const m = block.match(pat);
  if (!m) return null;
  const noTags = m[1].replace(/<[^>]+>/g, "");
  return _decodeEntities(noTags).replace(/\s+/g, " ").trim() || null;
}
function _decodeEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function parseRotowireNews(html) {
  const parts = html.split(/<div class="news-update((?:\s+is-injured)?)">/);
  const items = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const mod = parts[i];
    const b = parts[i + 1].slice(0, 3000);
    const player = _rwText(b, /news-update__player-link[^>]*>([\s\S]*?)<\/a>/);
    if (!player) continue;
    items.push({
      player,
      injured: /is-injured/.test(mod),
      headline: _rwText(b, /news-update__headline[^>]*>([\s\S]*?)<\/a>/),
      pos: _rwText(b, /news-update__pos">([\s\S]*?)<\/b>/),
      inj: _rwText(b, /news-update__inj">([\s\S]*?)<\/div>/),
      ts: _rwText(b, /news-update__timestamp">([\s\S]*?)<\/div>/),
      news: (_rwText(b, /news-update__news">([\s\S]*?)<\/div>/) || "").slice(0, 400),
    });
  }
  return items;
}

async function proxyFangraphsXwoba(url) {
  const season = url.searchParams.get("season") || String(new Date().getFullYear());
  const start = url.searchParams.get("startdate") || "";
  const end = url.searchParams.get("enddate") || "";
  // Default wide: free agents rarely sit near the top of the xwOBA board, so a
  // shallow pull would clip them out before the FA join even runs.
  const pageitems = url.searchParams.get("pageitems") || "600";
  const month = (start && end) ? "1000" : "0";

  const params = new URLSearchParams({
    pos: "all", stats: "bat", lg: "all", qual: "0", type: "8",
    season, season1: season, month, ind: "0",
    pageitems, sortdir: "desc", sortstat: "xwOBA",
  });
  if (start && end) { params.set("startdate", start); params.set("enddate", end); }

  const target = "https://www.fangraphs.com/api/leaders/major-league/data?" + params.toString();
  const r = await fetch(target, {
    headers: {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    },
  });
  if (!r.ok) throw new Error("FanGraphs " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();

  // Slim the payload: strip FanGraphs' HTML-wrapped Name/Team to plain text and
  // keep only the fields the view needs. Saves ~90% of the bytes over the wire.
  const rows = (data.data || []).map(d => ({
    name: stripTags(d.Name),
    team: stripTags(d.Team),
    xwOBA: numOrNull(d.xwOBA),
    wOBA: numOrNull(d.wOBA),
    PA: numOrNull(d.PA),
  })).filter(x => x.name && x.xwOBA != null);

  return { season: Number(season), start, end, count: rows.length, rows };
}

function stripTags(s) {
  if (s == null) return "";
  return String(s).replace(/<[^>]*>/g, "").trim();
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- Claude route ---

async function proxyClaude(request, env) {
  const body = await request.json();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error("Claude " + r.status + ": " + txt.slice(0, 400));
  }
  return r.json();
}

// --- Live draft socket CAPTURE (Phase 1 of docs/live-draft-sync-plan.md) ---
// Connects to ESPN's real-time draft websocket, captures raw binary frames for a
// short window, and best-effort-decodes them so we can (a) confirm a Cloudflare
// Worker can even reach the socket, and (b) learn the exact PICK_MADE frame
// layout from real data. This is a research/capture tool, NOT the production
// relay. Reverse-engineered from ESPN draft.js:
//   host = fantasydraft.espn.com/game-<gameId>/
//   wss://<host>/JOIN?1=<gameId>&2=<leagueId>&3=<teamId>&4=<swid>&5=<draftToken>&6=false&7=false&8=KONA&nocache=<rand>
//   frames: binary; last byte is a delimiter (sliced off); reader is big-endian:
//     readInt=4-byte signed, readShort=2-byte, readUTF=short-length-prefixed string
//   message types: {MESSAGE:1, PICK_MADE:2, MEMBER_JOINED:3, MEMBER_LEFT:4, PICK_UNDONE:5}
async function captureDraftSocket(url, env) {
  const leagueId = url.searchParams.get("leagueId");
  const season = url.searchParams.get("season") || "2026";
  const sport = url.searchParams.get("sport") || "ffl";
  const teamId = url.searchParams.get("teamId") || "1";
  const seconds = Math.min(20, Math.max(3, Number(url.searchParams.get("seconds")) || 9));

  // OVERRIDE PATH (Phase-1 research): if you paste the full wss JOIN url (or a
  // gameId + token) captured from a live draft's DevTools → Network → WS, we skip
  // draftInit and connect directly. This isolates "can the Worker reach + decode
  // the socket" from "auto-discover the token" (which is still TODO).
  const joinOverride = url.searchParams.get("joinUrl");   // full wss://…/JOIN?… string
  const tokenOverride = url.searchParams.get("token");
  const gameIdOverride = url.searchParams.get("gameId");

  let wsHttpUrl, gameId, debug;
  if (joinOverride) {
    wsHttpUrl = joinOverride.replace(/^wss:\/\//, "https://");
    const m = joinOverride.match(/game-(\d+)/);
    gameId = m ? m[1] : "(from url)";
    debug = { source: "joinUrl override" };
  } else if (gameIdOverride && tokenOverride) {
    gameId = gameIdOverride;
    const swid = env.ESPN_SWID;
    const rand = 424242;
    wsHttpUrl = "https://fantasydraft.espn.com/game-" + gameId + "/JOIN?1=" + gameId +
      "&2=" + leagueId + "&3=" + teamId + "&4=" + encodeURIComponent(swid) +
      "&5=" + encodeURIComponent(tokenOverride) + "&6=false&7=false&8=KONA&nocache=" + rand;
    debug = { source: "gameId+token override" };
  } else {
    // AUTO PATH: draftInit REST → gameId + draftToken. NOTE: as of Jul 2026 the
    // token is NOT in this response (hasToken:false) — origin still TODO. Use an
    // override above until that's solved.
    if (!leagueId) throw new Error("leagueId required (or pass joinUrl / gameId+token)");
    const initUrl = espnBaseForSport(sport) + "/seasons/" + season +
      "/segments/0/leagues/" + leagueId + "?view=draftInit&view=mSettings";
    const init = await espnFetch(initUrl, env);
    const found = _findKeys(init, ["gameId", "draftToken", "draftDetail", "id"]);
    gameId = found.gameId != null ? found.gameId : init.gameId;
    const draftToken = found.draftToken;
    debug = { source: "draftInit auto", initKeys: Object.keys(init || {}), foundGameId: gameId, hasToken: draftToken != null };
    if (gameId == null || draftToken == null) {
      return { ok: false, stage: "draftInit",
        error: "draftToken not in draftInit response — paste the JOIN url from your live draft's DevTools (Network → WS) into the override field instead",
        debug, initSample: JSON.stringify(init).slice(0, 1000) };
    }
    const swid = env.ESPN_SWID;
    const rand = 424242;
    wsHttpUrl = "https://fantasydraft.espn.com/game-" + gameId + "/JOIN?1=" + gameId +
      "&2=" + leagueId + "&3=" + teamId + "&4=" + encodeURIComponent(swid) +
      "&5=" + encodeURIComponent(draftToken) + "&6=false&7=false&8=KONA&nocache=" + rand;
  }

  let resp;
  try {
    resp = await fetch(wsHttpUrl, {
      headers: {
        "Upgrade": "websocket",
        "cookie": "espn_s2=" + env.ESPN_S2 + "; SWID=" + env.ESPN_SWID,
        "Origin": "https://fantasy.espn.com",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      },
    });
  } catch (e) {
    return { ok: false, stage: "connect", error: String(e.message || e), debug, wsUrl: _redact(wsHttpUrl) };
  }
  const ws = resp.webSocket;
  if (!ws) {
    return { ok: false, stage: "handshake", httpStatus: resp.status,
      error: "no webSocket on response (handshake failed)", debug, wsUrl: _redact(wsHttpUrl),
      bodySample: (await resp.text().catch(() => "")).slice(0, 400) };
  }
  ws.accept();

  const frames = [];
  ws.addEventListener("message", (ev) => {
    try {
      let bytes;
      if (typeof ev.data === "string") bytes = new TextEncoder().encode(ev.data);
      else bytes = new Uint8Array(ev.data);
      frames.push(bytes);
    } catch (_) {}
  });
  let closeInfo = null;
  ws.addEventListener("close", (ev) => { closeInfo = { code: ev.code, reason: ev.reason }; });

  await new Promise((r) => setTimeout(r, seconds * 1000));
  try { ws.close(); } catch (_) {}

  // 3) Decode each captured frame (ESPN's draft socket is a TEXT protocol).
  const decoded = frames.map((b, i) => decodeDraftFrame(b, i));
  // TOKEN frames embed the SWID/session token — redact like wsUrl (this is a
  // gated research route, but captured payloads get pasted around).
  for (const d of decoded) {
    if (d && typeof d.text === "string" && /^TOKEN\b/i.test(d.text)) d.text = "TOKEN <redacted>";
  }
  const picks = decoded.filter(d => d.pick).map(d => d.pick);
  return {
    ok: true,
    connected: true,
    gameId, teamId, seconds, frameCount: frames.length,
    picksDecoded: picks.length,
    picks,
    frames: decoded,
    close: closeInfo,
    debug, wsUrl: _redact(wsHttpUrl),
  };
}

// Recursively find the first occurrence of each key in a nested object.
function _findKeys(obj, keys, out) {
  out = out || {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) if (out[k] === undefined && obj[k] !== undefined && typeof obj[k] !== "object") out[k] = obj[k];
  for (const v of Object.values(obj)) if (v && typeof v === "object") _findKeys(v, keys, out);
  return out;
}
function _redact(u) { return u.replace(/(&5=)[^&]+/, "$1<token>").replace(/(&4=)[^&]+/, "$1<swid>"); }

// ESPN's draft socket is a TEXT protocol (confirmed by live capture): each frame
// is an ASCII string, space-delimited, first word = command. Observed commands:
//   INIT <big blob>            full state on connect
//   TOKEN 1:<n>:<team>:<swid>:<n>   auth/session handshake
//   NOMINATION <teamId> <playerId>
//   BID <teamId> <playerId> <n> <n> <n>
//   PASSED <teamId> <playerId> <bool>
//   SOLD <lot> <playerId> <teamId> <price> <flag>   ← a COMPLETED auction pick
//   CLOCK <...>                timer ticks (the flood — ignored)
// The client slices a trailing delimiter byte before parsing.
function decodeDraftFrame(bytes, idx) {
  let text = "";
  try { text = new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch (_) {}
  text = text.replace(/[ -]+$/g, "").trim();   // strip trailing delimiter/control bytes
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || "").toUpperCase();
  const fields = parts.slice(1);

  // SOLD = completed auction pick. Confirmed against live BID_ACK frames:
  //   SOLD <teamId> <playerId> <seq> <price> <flag>
  // teamId is the FIRST field (matches the winning bidder), playerId 2nd, price 4th.
  let pick = null;
  if (cmd === "SOLD" && fields.length >= 4) {
    const n = fields.map(x => Number(x));
    pick = { teamId: n[0], playerId: n[1], seq: n[2], price: n[3], flag: n[4], raw: fields };
  }
  return { idx, cmd, text: text.slice(0, 200), fields, bytes: bytes.length, isPick: cmd === "SOLD", pick };
}
