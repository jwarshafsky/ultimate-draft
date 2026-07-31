#!/usr/bin/env node
// Prototype: prove the FREE Google AI Studio (Gemini) key works for the kind of
// cheap, high-volume LLM work Ultimate Draft wants to offload from paid Claude —
// here, generating a short auction-draft blurb with STRUCTURED JSON output.
//
// This does NOT touch the app. It talks to Gemini two ways:
//   (default)  directly, to validate the key itself
//   --proxy    through the deployed /gemini relay, to validate the Worker route
//
// Setup:
//   1. Free key at https://aistudio.google.com/apikey
//   2. export GEMINI_API_KEY=AIza...
//   3. node proxy/test-gemini.js
//      node proxy/test-gemini.js --proxy   (after deploying + setting the secret,
//                                            also needs UD_PROXY_KEY exported)
//
// Requires Node 18+ (global fetch). Free tier: no charge, ~15 req/min.

// "-latest" alias tracks the newest flash model (3.6-flash as of 2026-07); the
// pinned 2.5 names are closed to new accounts like this key.
const MODEL = "gemini-flash-latest";
const PROXY_URL = "https://ultimate-draft-proxy.jwarshafsky.workers.dev";

// A realistic UD task: turn raw numbers into a terse draft-day take. Structured
// output means the app gets clean JSON back, not prose it has to parse.
const player = {
  name: "Bobby Witt Jr.",
  line: "2025: .295/.357/.588, 32 HR, 31 SB, 5x5 SS",
  projected$: 42,
  keeperSalary$: 18,
};

const payload = {
  contents: [{
    parts: [{
      text:
        "You value players for a 12-team 5x5 roto auction ($260 budget). " +
        "Given this player, return a punchy draft-day take.\n\n" +
        `Player: ${player.name}\n` +
        `Stats: ${player.line}\n` +
        `Projected auction value: $${player.projected$}\n` +
        `Keeper salary: $${player.keeperSalary$}\n`,
    }],
  }],
  generationConfig: {
    temperature: 0.4,
    // Thinking tokens count against maxOutputTokens on Gemini 3 — leave headroom
    // or the reply comes back empty. thinkingLevel replaced thinkingBudget.
    maxOutputTokens: 1000,
    thinkingConfig: { thinkingLevel: "low" },
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["keep", "toss-up", "drop"] },
        surplus$: { type: "integer" },
        blurb: { type: "string" },
      },
      required: ["verdict", "surplus$", "blurb"],
    },
  },
};

async function callDirect() {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("GEMINI_API_KEY not set (https://aistudio.google.com/apikey)");
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}

async function callProxy() {
  const udKey = (process.env.UD_PROXY_KEY || "").trim();
  const r = await fetch(`${PROXY_URL}/gemini`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(udKey ? { "x-ud-key": udKey } : {}),
    },
    body: JSON.stringify({ model: MODEL, ...payload }),
  });
  if (!r.ok) throw new Error(`Proxy ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}

(async () => {
  const useProxy = process.argv.includes("--proxy");
  console.log(`Route: ${useProxy ? "deployed /gemini relay" : "direct to Gemini"}`);
  const data = useProxy ? await callProxy() : await callDirect();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  console.log(`\nPlayer: ${player.name} — proj $${player.projected$}, keeps at $${player.keeperSalary$}\n`);
  try {
    const parsed = JSON.parse(text);
    console.log("Structured result from FREE Gemini:");
    console.log(`  verdict : ${parsed.verdict}`);
    console.log(`  surplus : $${parsed.surplus$}`);
    console.log(`  blurb   : ${parsed.blurb}`);
  } catch {
    console.log("Raw text (not JSON):", text || JSON.stringify(data).slice(0, 400));
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
