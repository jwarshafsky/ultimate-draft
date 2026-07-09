// Settings tab. Lets you tune the engine to refine your draft approach.
// All settings persist to localStorage and re-apply on next load.
//
// Adjustable knobs:
//   - Hitter/pitcher budget split (default 70%)
//   - Tier inflation absorption weights (T1-T5)
//   - Bench slots reserved at $1 each
//   - RP cap (drp= equivalent — how many RPs get above-$1 value)
//   - My strategy preferences (used by AI assistant + nomination):
//       * stars vs. scrubs tilt (-2 spread to +2 stars+scrubs)
//       * risk tolerance (-2 conservative to +2 ceiling chaser)
//       * preferred budget allocation curve
//   - AI assistant settings (model, cooldown, auto-trigger)
//   - Inflation mode (flat vs tiered)

const SETTINGS_KEY = "ud_settings_v1";

const _settings = {
  // Engine defaults — overridable via this UI
  hitBudgetPct: VALUATION.hitBudgetPct,   // 0.70
  benchSlots: VALUATION.benchSlots,        // 48
  rpCap: FANGRAPHS_SETTINGS.rpCap,         // 30
  tierAbsorption: { ...TIER_ABSORPTION },  // T1-T5 multipliers
  inflationMode: "tiered",                 // "tiered" | "flat"

  // My strategy preferences
  myStrategy: {
    starsVsScrubs: 0,    // -2 spread / 0 balanced / +2 stars+scrubs
    riskTolerance: 0,    // -2 safe floors / +2 high ceilings
    closerStance: "stream", // "pay-up" | "moderate" | "stream"
    catcherStance: "stream", // "pay-up" | "elite-only" | "stream"
    targetCategories: [], // categories to prioritize building toward
    puntCategories: [],   // categories you intentionally punt
  },

  // AI assistant settings
  ai: {
    enabled: false,
    autoTrigger: true,            // trigger AI on each new pick
    cooldownMs: 8000,
    model: "claude-opus-4-7",
  },
};

function loadSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (v) {
      Object.assign(_settings, v);
      // Push into engine globals
      VALUATION.hitBudgetPct = _settings.hitBudgetPct;
      VALUATION.benchSlots = _settings.benchSlots;
      FANGRAPHS_SETTINGS.rpCap = _settings.rpCap;
      VALUATION.replacement.RP = _settings.rpCap;
      Object.assign(TIER_ABSORPTION, _settings.tierAbsorption);
      if (typeof AI !== "undefined") {
        AI.model = _settings.ai.model;
        AI.cooldownMs = _settings.ai.cooldownMs;
      }
    }
  } catch (e) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
  // Re-apply
  VALUATION.hitBudgetPct = _settings.hitBudgetPct;
  VALUATION.benchSlots = _settings.benchSlots;
  FANGRAPHS_SETTINGS.rpCap = _settings.rpCap;
  VALUATION.replacement.RP = _settings.rpCap;
  Object.assign(TIER_ABSORPTION, _settings.tierAbsorption);
  if (typeof AI !== "undefined") {
    AI.model = _settings.ai.model;
    AI.cooldownMs = _settings.ai.cooldownMs;
  }
  // Force values re-computation
  if (typeof refreshValues === "function") refreshValues();
  if (typeof rerender === "function") rerender();
}

function resetSettings() {
  localStorage.removeItem(SETTINGS_KEY);
  window.location.reload();
}

function renderSettings() {
  const root = document.getElementById("view-root");
  const s = _settings;
  let html = '';

  // === Budget & Inflation ===
  html += '<div class="card"><h2>Budget & Inflation</h2>';
  html += '<div class="grid cols-2" style="gap: 18px;">';
  html += '<div>';
  html += '<h3>Hitter / Pitcher Split</h3>';
  html += '<p class="muted small">Share of $260 budget allocated to hitters. FanGraphs default is 70% (Jeff\'s setting).</p>';
  html += '<div class="settings-slider"><input type="range" min="50" max="85" value="' + (s.hitBudgetPct * 100).toFixed(0) + '" id="set-hit-pct" style="flex: 1;">';
  html += '<span id="set-hit-pct-val" style="font-family: var(--mono); width: 80px; text-align: right;">' + (s.hitBudgetPct * 100).toFixed(0) + '% / ' + ((1 - s.hitBudgetPct) * 100).toFixed(0) + '%</span></div>';
  html += '</div>';
  html += '<div>';
  html += '<h3>Bench Reserve</h3>';
  html += '<p class="muted small">$$ pulled out of the value pool to cover bench picks at $1 each. Default 48 (4 bench × 12 teams).</p>';
  html += '<input id="set-bench" type="number" min="0" max="100" value="' + s.benchSlots + '" style="width: 120px;">';
  html += '</div>';
  html += '<div>';
  html += '<h3>RP Cap (drp=)</h3>';
  html += '<p class="muted small">Only top N relievers receive above-$1 value. FanGraphs default 30.</p>';
  html += '<input id="set-rp-cap" type="number" min="10" max="60" value="' + s.rpCap + '" style="width: 120px;">';
  html += '</div>';
  html += '<div>';
  html += '<h3>Inflation Mode</h3>';
  html += '<p class="muted small">Flat = uniform multiplier. Tiered = stars absorb more inflation than $1 endgame players (more realistic).</p>';
  html += '<select id="set-inf-mode" style="width: 160px;">';
  html += '<option value="tiered"' + (s.inflationMode === "tiered" ? " selected" : "") + '>Tiered (recommended)</option>';
  html += '<option value="flat"' + (s.inflationMode === "flat" ? " selected" : "") + '>Flat</option>';
  html += '</select>';
  html += '</div>';
  html += '</div></div>';

  // (Tier absorption + My Strategy sliders/stances/chips + the written plan all
  // moved to the Live Draft tab's Draft Setup lobby — Jeff wants every draft
  // knob where the drafting happens. Settings keeps the engine plumbing only.)
  html += '<div class="card"><h2>Draft Strategy</h2>';
  html += '<p class="muted small" style="margin:0;">Strategy sliders, category targets/punts, keeper-inflation tiers, and your written plan now live on the <a href="#" id="set-goto-draft">Live Draft tab</a>.</p>';
  html += '</div>';

  // === Proxy URL + key (ESPN + Claude) ===
  html += '<div class="card"><h2>Proxy URL</h2>';
  html += '<p class="muted small">Cloudflare Worker URL for ESPN history sync and Claude AI assistant. Set once here, used everywhere.</p>';
  html += '<div style="display: flex; gap: 8px; align-items: center;">';
  html += '<input id="set-proxy-url" type="url" placeholder="https://ultimate-draft-proxy.your-subdomain.workers.dev" value="' + esc(ESPN.proxyUrl) + '" style="flex: 1;">';
  html += '<button class="btn primary" id="set-proxy-save" style="width: auto; padding: 8px 14px;">Save</button>';
  html += '</div>';
  html += '<div class="small muted" style="margin-top: 6px;">' + (ESPN.proxyUrl ? '✓ Currently set' : 'Not yet configured') + '</div>';
  html += '<h3 style="margin-top: 12px;">Proxy key</h3>';
  html += '<p class="muted small">Secret the proxy requires on every request — without it, anyone with the URL could use your Anthropic key and ESPN account. Saved with the same button.</p>';
  html += '<input id="set-proxy-key" type="password" placeholder="paste the proxy key" value="' + esc(ESPN.proxyKey) + '" style="width: 100%;" autocomplete="off">';
  html += '<div class="small muted" style="margin-top: 6px;">' + (ESPN.proxyKey ? '✓ Key set' : '<span class="warn">No key — proxy requests will be rejected once the worker requires one</span>') + '</div>';

  // (The old "Test league ID" override field was retired 2026-07-05 — ESPN
  // mocks arm via the Draft Setup lobby's league-URL box + feed mode 'test',
  // and UD-native practice mocks are ephemeral. reconcileDraftContext clears
  // any aged override on entering Real mode. A residual override is still
  // surfaced below so it can't hide.)
  if (leagueOverrideActive()) {
    html += '<div class="small" style="margin-top: 10px; color: var(--warn);">⚠ TEST MODE — a league override (' + ESPN.leagueId + ') is active: every tab is reading that league, NOT The League. <a href="#" id="set-clear-override">Clear it</a>, or switch the Live Draft feed to Real.</div>';
  }
  html += '</div>';

  // === AI Assistant ===
  html += '<div class="card"><h2>AI Assistant</h2>';
  html += '<div class="grid cols-3" style="gap: 18px;">';
  html += '<div>';
  html += '<h3>Model</h3>';
  html += '<select id="set-ai-model" style="width: 100%;">';
  for (const m of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
    html += '<option value="' + m + '"' + (s.ai.model === m ? " selected" : "") + '>' + esc(m) + '</option>';
  }
  html += '</select>';
  html += '</div>';
  html += '<div>';
  html += '<h3>Cooldown (s)</h3>';
  html += '<input id="set-ai-cooldown" type="number" min="0" max="60" value="' + (s.ai.cooldownMs / 1000) + '" style="width: 100%;">';
  html += '<p class="muted small">Min seconds between auto-calls.</p>';
  html += '</div>';
  html += '<div>';
  html += '<h3>Auto-trigger</h3>';
  html += '<label style="display: flex; align-items: center; gap: 8px; margin-top: 8px;"><input type="checkbox" id="set-ai-auto"' + (s.ai.autoTrigger ? " checked" : "") + '> Fire automatically on each new pick</label>';
  html += '</div>';
  html += '</div></div>';

  // === Device Sync ===
  html += '<div class="card"><h2>Device Sync</h2>';
  html += '<p class="muted small">Your settings, projections, notes, keepers, and draft picks are backed up to the cloud automatically whenever they change. Sign in on any device and everything comes back on its own — nothing to configure.</p>';
  html += '<div class="small" id="sync-status-line" style="margin: 6px 0;">' + (typeof getCloudSyncInfo === "function" ? esc(getCloudSyncInfo().summary) : "—") + '</div>';
  html += '<button class="btn ghost" id="set-sync-now" style="width: auto; padding: 6px 14px;">↻ Sync now</button>';
  html += '</div>';

  // === Buttons ===
  html += '<div style="display: flex; gap: 8px; margin-top: 12px;">';
  html += '<button class="btn primary" id="set-save" style="width: auto; padding: 10px 18px;">Save Settings</button>';
  html += '<button class="btn ghost danger" id="set-reset">Reset to Defaults</button>';
  html += '</div>';

  root.innerHTML = html;
  wireSettingsHandlers();
}

function sliderLabel(val, labels) {
  if (val <= -2) return "←← " + labels[0];
  if (val === -1) return "← " + labels[0];
  if (val === 0) return labels[1];
  if (val === 1) return labels[2] + " →";
  return labels[2] + " →→";
}

function wireSettingsHandlers() {
  const live = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", fn);
  };
  live("set-hit-pct", (e) => {
    const v = parseInt(e.target.value, 10);
    document.getElementById("set-hit-pct-val").textContent = v + "% / " + (100 - v) + "%";
  });
  document.getElementById("set-goto-draft")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof switchView === "function") switchView("draft");
  });

  document.getElementById("set-proxy-save")?.addEventListener("click", () => {
    setProxyUrl(document.getElementById("set-proxy-url").value);
    setProxyKey(document.getElementById("set-proxy-key")?.value);
    renderSettings();
  });
  document.getElementById("set-clear-override")?.addEventListener("click", (e) => {
    e.preventDefault();
    setLeagueOverride("");
    renderSettings();
  });
  document.getElementById("set-save")?.addEventListener("click", () => {
    _settings.hitBudgetPct = parseInt(document.getElementById("set-hit-pct").value, 10) / 100;
    _settings.benchSlots = parseInt(document.getElementById("set-bench").value, 10) || 48;
    _settings.rpCap = parseInt(document.getElementById("set-rp-cap").value, 10) || 30;
    _settings.inflationMode = document.getElementById("set-inf-mode").value;
    _settings.ai.model = document.getElementById("set-ai-model").value;
    _settings.ai.cooldownMs = (parseInt(document.getElementById("set-ai-cooldown").value, 10) || 8) * 1000;
    _settings.ai.autoTrigger = document.getElementById("set-ai-auto").checked;
    saveSettings();
    alert("Settings saved.");
  });
  document.getElementById("set-reset")?.addEventListener("click", () => {
    if (confirm("Reset all settings to defaults?")) resetSettings();
  });
  document.getElementById("set-sync-now")?.addEventListener("click", async () => {
    if (typeof syncPullNow !== "function") return;
    const changed = await syncPullNow({ reloadOnChange: false });
    const line = document.getElementById("sync-status-line");
    if (line) line.textContent = getCloudSyncInfo().summary;
    if (changed) {
      if (confirm(changed + " item" + (changed === 1 ? "" : "s") + " updated from another device. Reload to apply?")) location.reload();
    }
  });
}

// Helpers for other modules to read strategy
function getMyStrategy() { return _settings.myStrategy; }
// The Draft Setup lobby's strategy controls write here directly (auto-save).
function setMyStrategyField(field, value) {
  _settings.myStrategy[field] = value;
  saveSettings();
}
function setTierAbsorptionWeight(tier, value) {
  const v = parseFloat(value);
  if (isFinite(v)) _settings.tierAbsorption[tier] = Math.max(0, Math.min(2.5, v));
  saveSettings();
}
function resetTierAbsorption() {
  _settings.tierAbsorption = { T1: 1.6, T2: 1.35, T3: 1.0, T4: 0.6, T5: 0.2 };
  saveSettings();
}
function getSettings() { return _settings; }

// Load settings at startup. Must run AFTER VALUATION and other globals exist.
loadSettings();
