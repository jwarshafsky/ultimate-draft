// Pre-draft strategy — Jeff's free-text game plan plus an AI-condensed brief.
// The brief (not the raw essay) is injected into every AI assistant call and
// shown in Draft Mode's side rail, so the plan stays in front of him and the
// AI weighs it on every recommendation. Structured preferences (stars-vs-
// scrubs, punts, stances) live in settings.myStrategy; this file is the
// free-text layer on top.

const STRATEGY_KEY = "ud_draft_strategy_v1";   // synced across devices
let _draftStrategy = null;

function getDraftStrategy() {
  if (_draftStrategy) return _draftStrategy;
  try { _draftStrategy = JSON.parse(localStorage.getItem(STRATEGY_KEY) || "null") || {}; }
  catch (e) { _draftStrategy = {}; }
  if (typeof _draftStrategy.text !== "string") _draftStrategy.text = "";
  if (typeof _draftStrategy.brief !== "string") _draftStrategy.brief = "";
  return _draftStrategy;
}
function _strategySave() {
  try { localStorage.setItem(STRATEGY_KEY, JSON.stringify(getDraftStrategy())); } catch (e) {}
}
function setDraftStrategyText(text) {
  getDraftStrategy().text = String(text || "");
  _strategySave();
}

// Wipe both the free-text plan and the AI-condensed brief, then persist the
// same way setDraftStrategyText does so the cleared state syncs across devices.
function clearDraftStrategy() {
  const s = getDraftStrategy();
  s.text = "";
  s.brief = "";
  delete s.briefAt;
  _strategySave();
}

// The line the AI sees: the condensed brief if fresh, else the raw text.
function strategyForAi() {
  const s = getDraftStrategy();
  return s.brief || s.text.slice(0, 800) || null;
}

// Condense the raw strategy + structured preferences into a tight brief the
// assistant can carry in every prompt. One manual click — no auto-spend.
async function condenseDraftStrategy() {
  const s = getDraftStrategy();
  if (!s.text.trim()) throw new Error("Write your strategy first.");
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured (Settings).");
  const prefs = (typeof getMyStrategy === "function") ? getMyStrategy() : {};
  const body = {
    model: (typeof AI !== "undefined" && AI.model) || "claude-sonnet-5",
    system: "You condense a fantasy-baseball auction draft strategy into a brief the drafter's AI assistant will carry in every prompt on draft day. Keep every concrete constraint (dollar limits, player names, punts, position plans). Max 120 words, tight bullets, no preamble.",
    messages: [{
      role: "user",
      content: "Structured preferences:\n" + JSON.stringify(prefs) + "\n\nMy strategy, in my own words:\n" + s.text,
    }],
    max_tokens: 350,
  };
  const r = await fetch(ESPN.proxyUrl.replace(/\/$/, "") + "/claude", {
    method: "POST",
    headers: proxyHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Claude proxy " + r.status + ": " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const brief = (data.content || []).map(c => c.text || "").join("\n").trim();
  if (!brief) throw new Error("Empty response from the assistant.");
  s.brief = brief;
  s.briefAt = Date.now();
  _strategySave();
  return brief;
}
