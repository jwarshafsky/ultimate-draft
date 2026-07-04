// Claude-powered AI draft assistant. Sends current draft state (your roster,
// remaining budget, category projections, top remaining values, nomination
// targets) to Claude via the proxy, gets back a short recommendation. Runs on
// every new pick (or manually triggered) and shows the suggestion alongside
// the live draft.
//
// Proxy contract:
//   POST {PROXY_URL}/claude
//        body: { model, system, messages: [...], max_tokens }
//        → forwards to api.anthropic.com/v1/messages with server-side key
//        returns: { content: [{ type:"text", text:"..." }] }
//
// The proxy holds the Anthropic API key; client just sends prompts.

const AI = {
  enabled: false,
  model: "claude-opus-4-7",
  lastSuggestion: null,
  lastSentAt: 0,
  cooldownMs: 8000,  // don't spam Claude — minimum gap between calls
  busy: false,
  history: [],       // [{ ts, suggestion, contextSummary }]
};

function aiEnabled() { return AI.enabled; }
function setAiEnabled(b) { AI.enabled = !!b; }

// Distilled auction/keeper strategy the assistant must reason from — synthesized
// from the fantasy-kb (01-valuation, 07-draft-prep) and DraftKick's salary-cap
// guide. Kept tight (it rides in every call). Mirrors docs/strategy-north-star.md.
const AUCTION_STRATEGY = `AUCTION STRATEGY PLAYBOOK — apply these; they are how this league is won:
- CLEARING PRICE: right price = inflated value (value × keeper inflation × positional scarcity). Expect stars to clear $5-10 OVER sticker; SB and saves carry a premium; catchers deflate. First player nominated in a tier gets a small discount; the last one pays $5-10 more.
- MAX BID = remaining budget − $1 per still-open roster slot. Never let a bid strand the roster; if $/open-slot is drifting toward ~$3, stop chasing.
- BUDGET SHAPE: stars-and-scrubs = concentrate on elites, fill the rest at $1-3; spread = many $15-30 pieces. You can pivot AWAY from stars-and-scrubs mid-draft but never TOWARD it, so don't overspend early and get stranded. Respect the user's stars-vs-scrubs tilt.
- NOMINATION WARFARE: nominate players you do NOT want to drain rivals' budgets and enforce prices — but only bid one up when confident someone else will take him. Mix nominations so you don't telegraph your targets.
- LIVE-BID TACTICS: psychological resistance at round numbers ($10/$20/$30) — bid $21 to break a $20 wall. Shutdown = jump straight to a rival's known max bid to end it efficiently; Squeeze = push a rival to his max then drop out, draining him.
- ENDGAME: the goal isn't the most cash, it's staying able to bid — keep your max bid above $1 as long as possible; flexibility beats hoarding.
- CATEGORY PUNTS: a coherent punt can win — punt saves (roster cheap HLD setup men), punt power (SB/AVG anchors + cheap complements), or punt SP ratios (cheap RP for ERA/WHIP/HLD). If a category is out of reach, redeploy that budget instead of overpaying.
- KEEPERS/INFLATION: kept bargains inflate everyone else — factor the live inflation multiplier into every price.`;

// Build a compact prompt with everything Claude needs to give useful advice.
function buildAiContext() {
  const me = getMyTeam();
  if (!me) return null;
  const inflation = computeLiveInflation() || computeTieredInflation();
  const myRoster = getMyRoster();
  const cats = projectTeamCategories(myRoster);
  const myBudget = LEAGUE.draftBudget - (
    (typeof _liveDraft !== "undefined" ? _liveDraft.picks : [])
      .filter(p => p.team === me.id)
      .reduce((s, p) => s + p.price, 0)
  ) - Object.entries(getEffectiveKeeperSelections()[me.id] || {})
    .filter(([_, f]) => f.keeper)
    .reduce((s, [n]) => s + (getCurrentKeeperSalary(n) ?? 0), 0);
  const slotsFilled = myRoster.length;
  const slotsRemaining = LEAGUE.rosterSize - slotsFilled - (
    Object.values(getEffectiveKeeperSelections()[me.id] || {}).filter(f => f.minorKeeper).length
  );

  // Top remaining undrafted players (by inflated value), capped to ~30
  const draftedNames = new Set((typeof _liveDraft !== "undefined" ? _liveDraft.picks : []).map(p => p.player));
  const _aiNk = (typeof normalizePlayerName === "function") ? normalizePlayerName : (s => String(s || "").toLowerCase());
  const keptNames = (typeof draftExcludedNames === "function") ? draftExcludedNames() : new Set(collectKeepers().map(k => _aiNk(k.name)));
  const topPool = getValues()
    .filter(p => p.value > 5 && !draftedNames.has(p.name) && !keptNames.has(_aiNk(p.name)))
    .slice(0, 30)
    .map(p => ({
      name: p.name,
      pos: p.posKey,
      value: Math.round(p.value),
      inflated: Math.round(inflatedValue(p, inflation)),
    }));

  // My pre-set target prices (dream/fair/walk-away) for any flagged players
  const myTargets = [];
  for (const p of topPool) {
    const t = getTargetPrices(p.name);
    if (t) {
      myTargets.push({ name: p.name, pos: p.pos, dream: t.dream, fair: t.fair, walkAway: t.walkAway, currentInflated: p.inflated });
    }
  }
  // My strategy prefs from Settings
  const strategy = (typeof getMyStrategy === "function") ? getMyStrategy() : null;

  return {
    myTeam: me.name,
    myBudget,
    slotsFilled,
    slotsRemaining,
    perSlot: slotsRemaining > 0 ? (myBudget / slotsRemaining).toFixed(1) : "0",
    inflation: inflation?.multiplier.toFixed(2),
    myCategoryRanks: cats.ranks,
    myRotoPoints: cats.rotoPoints.toFixed(1),
    myStrategy: strategy,
    myTargetPrices: myTargets,
    topPool,
    recentPicks: (typeof _liveDraft !== "undefined" ? _liveDraft.picks : []).slice(-6).map(p => ({
      player: p.player, team: p.team, price: p.price,
    })),
    nominations: suggestNominations().slice(0, 8).map(s => ({
      kind: s.kind, player: s.player.name, pos: s.player.posKey, target: s.priceTarget,
    })),
  };
}

async function callAi(context, userMessage) {
  if (!ESPN.proxyUrl) throw new Error("Proxy URL not configured (set in Live Draft view).");
  const proxyClaudeUrl = ESPN.proxyUrl.replace(/\/$/, "") + "/claude";
  const system = `You are an expert fantasy baseball draft assistant for a 12-team keeper auction league using OBP, QS, SV+HLD as categories. Budget is $260 per team, 70/30 hitter/pitcher split. Roster: 1 C, 1 1B, 1 2B, 1 3B, 1 SS, 5 OF, 1 MI, 1 CI, 1 UTIL, 6 SP, 4 RP, 4 BN.

You give short, actionable advice: which players to bid on, target prices, when to nominate dump candidates, and category-balance trade-offs. Honor the user's pre-set dream/fair/walk-away prices (never recommend bidding above walk-away). Respect user's strategy preferences (stars-vs-scrubs tilt, risk tolerance, punt categories). Keep responses under 150 words. Use specific dollar amounts and player names. Format as 1-3 tight bullets.

${AUCTION_STRATEGY}

Ground every recommendation in the playbook above, but the user's explicit target prices and strategy settings always override it.`;
  const userPrompt = `Current draft state:
\`\`\`
${JSON.stringify(context, null, 2)}
\`\`\`

${userMessage || "What should I do next? Specific advice please."}`;

  const body = {
    model: AI.model,
    system,
    messages: [{ role: "user", content: userPrompt }],
    max_tokens: 400,
  };
  const r = await fetch(proxyClaudeUrl, {
    method: "POST",
    headers: proxyHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error("Claude proxy " + r.status + ": " + errText);
  }
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || "").join("\n").trim();
  return text;
}

async function askAi(userMessage) {
  if (AI.busy) return;
  const now = Date.now();
  if (now - AI.lastSentAt < AI.cooldownMs) {
    return "Cooling down — wait a moment before asking again.";
  }
  AI.busy = true;
  AI.lastSentAt = now;
  try {
    const context = buildAiContext();
    if (!context) throw new Error("My team not set.");
    const reply = await callAi(context, userMessage);
    AI.lastSuggestion = reply;
    AI.history.push({ ts: now, message: userMessage || "(auto)", suggestion: reply });
    return reply;
  } catch (e) {
    return "AI error: " + (e.message || e);
  } finally {
    AI.busy = false;
  }
}

// Renders the AI panel for inclusion inside the Live Draft view.
function renderAiAssistantPanel() {
  let html = '<div class="card"><h2>AI Assistant <span class="muted small">Claude ' + esc(AI.model) + '</span></h2>';
  if (!ESPN.proxyUrl) {
    html += '<p class="muted small">Set the proxy URL (below) to enable. The proxy holds your Anthropic API key server-side.</p>';
    return html + '</div>';
  }
  if (!AI.enabled) {
    html += '<p class="muted small">AI assistant is off. Toggle on to get real-time suggestions after each pick.</p>';
    html += '<button class="btn" id="ai-toggle">Enable AI assistant</button>';
    return html + '</div>';
  }
  html += '<div style="display: flex; gap: 8px; align-items: center; margin-bottom: 10px;">';
  html += '<input id="ai-input" placeholder="Ask Claude (or leave blank for general advice)…" style="flex: 1;">';
  html += '<button class="btn primary" id="ai-ask" style="width: auto; padding: 8px 14px;">Ask</button>';
  html += '<button class="btn ghost" id="ai-toggle" title="Disable">⏸</button>';
  html += '</div>';

  if (AI.busy) {
    html += '<p class="muted small">Thinking…</p>';
  } else if (AI.lastSuggestion) {
    html += '<div style="background: var(--bg-3); border-radius: 6px; padding: 12px; white-space: pre-wrap; font-size: 13px;">' + esc(AI.lastSuggestion) + '</div>';
    html += '<div class="muted small" style="margin-top: 6px;">Last asked: ' + new Date(AI.lastSentAt).toLocaleTimeString() + '</div>';
  } else {
    html += '<p class="muted small">No suggestions yet. Ask a question or wait for the next pick to trigger one.</p>';
  }
  html += '</div>';
  return html;
}

function wireAiPanel() {
  document.getElementById("ai-toggle")?.addEventListener("click", () => {
    AI.enabled = !AI.enabled;
    renderDraft();
  });
  document.getElementById("ai-ask")?.addEventListener("click", async () => {
    const input = document.getElementById("ai-input");
    const q = input ? input.value : "";
    AI.busy = true; renderDraft();
    await askAi(q);
    renderDraft();
  });
  document.getElementById("ai-input")?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") document.getElementById("ai-ask").click();
  });
}

// Auto-trigger on every new pick (with cooldown applied).
if (typeof onEspnPick === "function") {
  onEspnPick(async () => {
    if (!AI.enabled) return;
    if (Date.now() - AI.lastSentAt < AI.cooldownMs) return;
    await askAi("A new pick was just made. Short take?");
    if (currentView === "draft") renderDraft();
  });
}
