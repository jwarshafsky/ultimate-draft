// Cloudflare Worker proxy for Ultimate Draft.
//
// Endpoints:
//   GET  /espn/draft?leagueId=1200&season=2026   → mDraftDetail view
//   GET  /espn/teams?leagueId=...&season=...     → mTeam + mRoster views
//   GET  /espn/players?leagueId=...&season=...   → kona_player_info (top 2000)
//   POST /claude                                  → forwards to Anthropic Messages API
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";

    // CORS preflight (must not require the key — browsers send it unauthenticated)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed, origin) });
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
      } else if (url.pathname === "/espn/teams") {
        body = await proxyEspnTeams(url, env);
      } else if (url.pathname === "/espn/players") {
        body = await proxyEspnPlayers(url, env);
      } else if (url.pathname === "/espn/history") {
        body = await proxyEspnHistory(url, env);
      } else if (url.pathname === "/fangraphs/xwoba") {
        body = await proxyFangraphsXwoba(url);
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
    "access-control-allow-headers": "content-type,x-ud-key",
    "access-control-max-age": "86400",
  };
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json", ...(extraHeaders || {}) },
  });
}

// --- ESPN routes ---

const ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb";

async function espnFetch(url, env, headers) {
  const cookieHeader = "espn_s2=" + env.ESPN_S2 + "; SWID=" + env.ESPN_SWID;
  const r = await fetch(url, {
    headers: {
      "cookie": cookieHeader,
      "accept": "application/json",
      "origin": "https://fantasy.espn.com",
      "referer": "https://fantasy.espn.com/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      "x-fantasy-platform": "espn-fantasy-web",
      "x-fantasy-source": "kona",
      ...(headers || {}),
    },
  });
  if (!r.ok) throw new Error("ESPN " + r.status + ": " + (await r.text()).slice(0, 200));
  return r.json();
}

async function proxyEspnDraft(url, env) {
  const leagueId = url.searchParams.get("leagueId");
  const season = url.searchParams.get("season");
  const target = ESPN_BASE + "/seasons/" + season + "/segments/0/leagues/" + leagueId + "?view=mDraftDetail";
  const data = await espnFetch(target, env);
  // Normalize the picks array: each pick has playerId, teamId, bidAmount, etc.
  const picks = (data.draftDetail?.picks || []).map(p => ({
    playerId: p.playerId,
    playerName: p.playerName || ("Player " + p.playerId),
    teamId: p.teamId,
    bidAmount: p.bidAmount || 0,
    nominator: p.nominatingTeamId,
    overallPickNumber: p.overallPickNumber,
    keeper: !!p.keeper,
  }));
  return { picks, draftStatus: data.draftDetail?.drafted ? "complete" : "active" };
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
