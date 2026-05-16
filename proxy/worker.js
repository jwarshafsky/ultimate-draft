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
//
// Deploy:
//   npx wrangler deploy
// Configure secrets:
//   npx wrangler secret put ESPN_S2
//   npx wrangler secret put ESPN_SWID
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler secret put ALLOWED_ORIGIN

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowed, origin) });
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
  const allowOrigin = (allowed === "*") ? "*" :
    (origin && (origin === allowed || origin.endsWith(".github.io"))) ? origin : allowed;
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
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
