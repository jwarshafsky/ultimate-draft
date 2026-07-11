// Telegram bot — ask questions about The League from your phone.
//
//   Telegram webhook → POST /telegram on this Worker → Claude (tool loop) →
//   answer sent back via sendMessage.
//
// Claude gets tools backed by league-data.js: live projected standings,
// Monte-Carlo trade simulation, rosters, player lines, keeper contracts, and
// the league rules digest. "What would trading X for Y do to my title odds?"
// runs the same engine as the app's Standings tab.
//
// Required Worker secrets (npx wrangler secret put <NAME>):
//   TELEGRAM_BOT_TOKEN        — from @BotFather
//   TELEGRAM_WEBHOOK_SECRET   — any random string; also passed to setWebhook
//   TELEGRAM_ALLOWED_CHAT_IDS — comma-separated chat ids allowed to use the bot
//   (plus the existing ESPN_S2 / ESPN_SWID / ANTHROPIC_API_KEY)
//
// docs/telegram-bot-setup.md has the full setup walkthrough.

import {
  assembleLeague, projectedStandingsReport, simulateTradeReport,
  rosterReport, playerReport, contractsReport, TEAMS, teamLabel,
} from "./league-data.js";

const CLAUDE_MODEL = "claude-opus-4-8";
const MAX_TOOL_ITERATIONS = 8;
const HISTORY_TURNS = 8;            // user+assistant messages kept per chat
const HISTORY_TTL_S = 7 * 24 * 3600;

// Rules digest — copied from the-league/supabase/functions/rules-bot/index.ts.
// Keep in sync if the constitution digest changes there.
const RULES_DIGEST = `
§1 Format: 12 teams, 5×5 roto. Auction draft 26 rounds, $260 budget. Roster: C, 1B, 2B, SS, 3B, MI, CI, 5 OF, Util, 9 P, 4 Bench, 7 IL (post-draft only). Daily moves. Limits: 200 GS pitchers, 2106 GS hitters, 1000 IP min for ERA/WHIP. Bat cats: R, HR, RBI, SB, OBP. Pitch cats: QS, K, SV+HLD, ERA, WHIP.
§1b Trading draft $: only for next draft. Max $290 entering draft ($260+$30 acquired). Trading >$10 away requires $200 security deposit.
§2a Keeper caps: max 8 ML, max 10 MiL.
§2b ML keepers (drafted): keep up to 3 add'l yrs at draft value, +$2/yr. Min cost $1, non-int rounded up. Traded players keep cost basis.
§2b ML keepers (FA): $6 first keepable yr, +$2/yr, 3 yrs max. Players dropped in final contract yr → can be added in FA but NOT kept.
§2c Post-keeper-deadline drops only allowed for newly-reported injury/legal news (not regret).
§2d Auction price EXCEEDING $40 → max 2 add'l yrs; exceeding $50 → max 1. Exactly $40 stays 3 yrs, exactly $50 stays 2.
§2e MiL keepers (max 10): no salary while in minors. Pre-2027 drafted = 4-yr contracts. 2027+ drafted = "call up + 3 yr".
§2e MiL→ML pricing on first ML kept yr, based on ESPN top-200 ranking March 1: outside top 200=$1, 100-199=$3, 50-99=$5, 20-49=$10, top 19=$15. Then +$2/yr after.
§3a Minor draft: 7 rounds, reverse standings. Anti-tanking: <45 roto pts → bottom of next year's order. Picks traded after May 15 NOT protected.
§3 Limits: never >10 minors at keeper deadline or end of MiL draft.
§3b MiL transactions: call-up free anytime. Send-down to minors costs $10 REAL MONEY. Post-Jan-2026: call up minors after keeper deadline before ML draft for $0.
§3c Eligibility: <200 career AB or <50 career IP for MiL drafting.
§3d Pre-MLB auction draftees can't be dropped until April 15 unless DL'd or acquired >$1.
§3f Post-Jan-2026: MiL players who hit 75 IP / 300 AB must be called up or dropped by end of next MiL draft.
§4a Trade deadline set on ESPN. After deadline: only $/picks/MiL trades; traded MiL can't be called up until next offseason. FA pickups after deadline can't be kept.
§4b Veto: commish only, only for collusion / mistake / mutual agreement.
§4c No conditional trades. 24-hr protest window.
§5 Rule 5 Draft: by Jan 31 shrink full roster (ML+MiL) to 25. Snake, reverse standings. Drafting team pays origin team $1.
§6 FAAB: tri-weekly (Tue/Thu/Sun 11am). $1000/season. $0 bids OK. All FA keepers cost $6 regardless of bid. FAAB$ tradeable as of 2026.
§7 Fees: $300/season. 1st place = $2300+collected fees. 2nd=$1000. 3rd=$300+luxury overflow. 4th=luxury 60% (max $300). 5th=luxury 40%.
§10 Luxury tax: every $ over $350 at trade deadline. Pool 60/40 to 4th/5th, 4th capped at $300, excess to 3rd.
`.trim();

const TOOLS = [
  {
    name: "get_projected_standings",
    description: "Full-season projected roto standings for all 12 teams (banked YTD stats + optimized rest-of-season lineups), with Monte-Carlo title/top-3 odds and expected finish, plus the current YTD standings. Use for any question about standings, odds, who's winning, or a team's outlook.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "simulate_trade",
    description: "Simulate a proposed trade between two teams and report each side's change in projected roto points, final standing, title odds, top-3 (money) odds, and the biggest category swings. Use for ANY 'what would this trade do' / 'should I trade X for Y' question. Both sides' players must currently be on the named teams' rosters.",
    input_schema: {
      type: "object",
      properties: {
        team_a: { type: "string", description: "First team (owner name, e.g. 'Jeff')" },
        team_a_sends: { type: "array", items: { type: "string" }, description: "Player names team A gives up" },
        team_b: { type: "string", description: "Second team (owner name)" },
        team_b_sends: { type: "array", items: { type: "string" }, description: "Player names team B gives up" },
      },
      required: ["team_a", "team_a_sends", "team_b", "team_b_sends"],
      additionalProperties: false,
    },
  },
  {
    name: "get_roster",
    description: "One team's current ESPN roster with position, injury/IL status, key YTD stats, and whether each player has a rest-of-season projection line.",
    input_schema: {
      type: "object",
      properties: { team: { type: "string", description: "Owner name, e.g. 'Jeff', 'Josh/Doug'" } },
      required: ["team"], additionalProperties: false,
    },
  },
  {
    name: "get_player",
    description: "Look up one rostered player: which team owns him, YTD stats, and his rest-of-season projection line.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Player name" } },
      required: ["name"], additionalProperties: false,
    },
  },
  {
    name: "get_contracts",
    description: "Keeper contract data (salary, year acquired, majors/callups/minors) from The League app. Use when a question involves keeper value, salaries, or the long-term side of a trade. Omit team for all 12 teams.",
    input_schema: {
      type: "object",
      properties: { team: { type: "string", description: "Owner name; omit for all teams" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_league_rules",
    description: "The league constitution digest (keeper rules, trade rules, FAAB, fees, luxury tax). Cite sections as §N.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function runTool(name, input, env) {
  switch (name) {
    case "get_projected_standings":
      return projectedStandingsReport(await assembleLeague(env));
    case "simulate_trade":
      return simulateTradeReport(await assembleLeague(env), input);
    case "get_roster":
      return rosterReport(await assembleLeague(env), input.team);
    case "get_player":
      return playerReport(await assembleLeague(env), input.name);
    case "get_contracts":
      return contractsReport(env, input.team);
    case "get_league_rules":
      return { rules: RULES_DIGEST };
    default:
      return { error: "unknown tool: " + name };
  }
}

function systemPrompt(firstName) {
  const owners = Object.entries(TEAMS).map(([id, t]) => t.label).join(", ");
  return [
    "You are The League Bot — a fantasy baseball assistant on Telegram for \"The League\", a 12-team 5×5 roto KEEPER league on ESPN.",
    "You are talking to " + (firstName || "a league member") + " (almost always Jeff, owner of team Jeff).",
    "",
    "League: categories R/HR/RBI/SB/OBP + QS/K/SV+HLD/ERA/WHIP. $260 auction, keepers with +$2/yr contracts. Owners: " + owners + ".",
    "",
    "Tool guidance:",
    "- Any trade question → simulate_trade. ALSO weigh the keeper side (get_contracts: salary vs likely value, contract years) — in a keeper league a trade verdict has BOTH a this-season axis (the simulation) and a multi-year axis (surplus). Say which side wins each axis.",
    "- Standings / odds / outlook → get_projected_standings.",
    "- Rules → get_league_rules; cite §N.",
    "- If a player isn't found, relay the suggestions and ask a short clarifying question.",
    "- Answer from tool data, not memory. Your training data is stale for 2026 stats — never quote a stat you didn't get from a tool.",
    "",
    "Interpreting the simulation: rotoPoints delta is the projected full-season roto-point swing; titleOdds is P(1st) from Monte Carlo; top3 = money finish (top 3 pay out). Small deltas (<1 roto pt, <2% odds) are noise — say so plainly rather than overselling. Mention the projection source once when it matters (e.g. ESPN-prorated fallback is cruder than a FanGraphs ROS source).",
    "",
    "Telegram formatting rules:",
    "- Plain text ONLY: no markdown headers, no **bold**, no tables, no backticks.",
    "- Lead with the answer in 1-2 sentences, then short '•' bullets for supporting numbers.",
    "- Keep it tight — this is a phone screen. Round sensibly (odds to whole %, roto points to 0.1).",
    "- End trade analyses with a one-line verdict (e.g. '• Verdict: helps you this year, costs you long-term — do it if you're going for it now.').",
  ].join("\n");
}

// --- Claude (raw Messages API — matches this worker's existing /claude route) ---

async function claude(env, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("Claude " + r.status + ": " + (await r.text()).slice(0, 400));
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function answerQuestion(env, question, history, firstName) {
  const messages = [];
  for (const m of (history || [])) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: question });

  let toolTrace = [];
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await claude(env, {
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system: systemPrompt(firstName),
      tools: TOOLS,
      messages,
    });

    if (resp.stop_reason === "refusal") {
      return { text: "I can't help with that one.", toolTrace };
    }
    if (resp.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    if (resp.stop_reason !== "tool_use") {
      const text = (resp.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return { text: text || "…I came back empty. Try rephrasing?", toolTrace };
    }

    // Execute every tool call in this turn, return all results in one message.
    messages.push({ role: "assistant", content: resp.content });
    const results = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      let result;
      try {
        result = await runTool(block.name, block.input || {}, env);
      } catch (e) {
        result = { error: String(e && e.message || e) };
      }
      toolTrace.push(block.name);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "That took more digging than I'm allowed per question — try splitting it into smaller questions.", toolTrace };
}

// --- Telegram API helpers ---

async function tg(env, method, payload) {
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.warn("telegram " + method + " failed:", JSON.stringify(j).slice(0, 300));
  return j;
}

async function sendText(env, chatId, text) {
  // Telegram caps messages at 4096 chars — chunk on line boundaries.
  const chunks = [];
  let rest = String(text || "").trim() || "(empty)";
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf("\n", 4000);
    if (cut < 1000) cut = 4000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const c of chunks) await tg(env, "sendMessage", { chat_id: chatId, text: c });
}

// --- History (KV) ---

async function loadHistory(env, chatId) {
  try { return JSON.parse(await env.UD_SYNC.get("tg:hist:" + chatId) || "[]"); }
  catch (e) { return []; }
}
async function saveHistory(env, chatId, history) {
  await env.UD_SYNC.put("tg:hist:" + chatId, JSON.stringify(history.slice(-HISTORY_TURNS)),
    { expirationTtl: HISTORY_TTL_S });
}

// --- Webhook entry point ---

const HELP_TEXT = [
  "I answer questions about The League — standings, trades, rosters, keeper contracts, rules.",
  "",
  "Try:",
  "• where do I project to finish?",
  "• what happens to my title odds if I trade Bobby Witt to Matt for Skenes?",
  "• who's on Corey's roster?",
  "• what does Chourio cost to keep next year?",
  "• /reset — clear our conversation history",
].join("\n");

export async function handleTelegram(request, env, ctx) {
  // Auth: Telegram echoes back the secret we registered with setWebhook.
  if (!env.TELEGRAM_WEBHOOK_SECRET ||
      request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update;
  try { update = await request.json(); } catch (e) { return new Response("ok"); }
  const msg = update.message;
  // Ignore edits, channel posts, non-text messages — ack so Telegram doesn't retry.
  if (!msg || !msg.text || !msg.chat) return new Response("ok");

  // De-dupe redeliveries (Telegram retries until it gets a 200).
  if (update.update_id != null) {
    const k = "tg:upd:" + update.update_id;
    if (await env.UD_SYNC.get(k)) return new Response("ok");
    await env.UD_SYNC.put(k, "1", { expirationTtl: 86400 });
  }

  const chatId = msg.chat.id;
  const allowed = String(env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(String(chatId))) {
    ctx.waitUntil(sendText(env, chatId,
      "This bot is private. Your chat id is " + chatId + " — the league's admin can add it to TELEGRAM_ALLOWED_CHAT_IDS."));
    return new Response("ok");
  }

  const text = msg.text.trim();
  const firstName = (msg.from && msg.from.first_name) || "";

  ctx.waitUntil((async () => {
    try {
      if (text === "/start" || text === "/help") {
        await sendText(env, chatId, "⚾ Hey " + (firstName || "there") + "!\n\n" + HELP_TEXT);
        return;
      }
      if (text === "/reset") {
        await env.UD_SYNC.put("tg:hist:" + chatId, "[]", { expirationTtl: HISTORY_TTL_S });
        await sendText(env, chatId, "History cleared. Fresh start.");
        return;
      }
      if (text.length > 1500) {
        await sendText(env, chatId, "That's a lot — keep questions under 1500 characters.");
        return;
      }

      await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
      // Re-send "typing…" every 6s while Claude works (Telegram clears it after ~5s).
      const typing = setInterval(() => {
        tg(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      }, 6000);

      let answer;
      try {
        const history = await loadHistory(env, chatId);
        answer = await answerQuestion(env, text, history, firstName);
        await saveHistory(env, chatId, history.concat([
          { role: "user", content: text },
          { role: "assistant", content: answer.text },
        ]));
      } finally {
        clearInterval(typing);
      }
      await sendText(env, chatId, answer.text);
    } catch (e) {
      console.error("telegram handler failed:", e);
      await sendText(env, chatId, "⚠️ Something broke answering that: " +
        String(e && e.message || e).slice(0, 300));
    }
  })());

  return new Response("ok");
}
