// Shared authenticated ESPN fetch for the Worker. Extracted from worker.js so
// league-data.js (Telegram bot data assembly) can use it without an import
// cycle. Cookies come from Worker secrets (ESPN_S2 / ESPN_SWID).

export const ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb";

export async function espnFetch(url, env, headers) {
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
