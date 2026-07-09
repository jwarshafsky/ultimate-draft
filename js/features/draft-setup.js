// Draft Setup — the Live Draft tab's pre-draft lobby. Everything you configure
// BEFORE the auction lives here (league URL / test-vs-real, strategy, keeper
// review, budgets, call-ups, saved configurations); "⛶ Enter Draft" launches
// the fullscreen Draft Mode cockpit. The old classic layout survives as the
// manual-entry fallback view (link at the bottom; Draft Mode's Exit also
// returns here).

const DRAFT_CONFIGS_KEY = "ud_draft_configs_v1";   // synced

function _dsConfigs() {
  try { return JSON.parse(localStorage.getItem(DRAFT_CONFIGS_KEY) || "[]") || []; }
  catch (e) { return []; }
}
function _dsSaveConfigs(list) {
  try { localStorage.setItem(DRAFT_CONFIGS_KEY, JSON.stringify(list.slice(0, 20))); } catch (e) {}
}

// Pull leagueId + sport out of an ESPN league/draft URL (or a bare league id).
function parseLeagueUrl(text) {
  text = String(text || "").trim();
  if (!text) return null;
  if (/^\d{3,}$/.test(text)) return { leagueId: Number(text), sport: "flb" };
  const id = text.match(/leagueId=(\d+)/i);
  if (!id) return null;
  const sport = /football|\/ffl\//i.test(text) ? "ffl" : "flb";
  return { leagueId: Number(id[1]), sport };
}

// Apply a parsed league to the app: your real league clears the override and
// arms Real mode; anything else becomes a test-mode override.
function _dsApplyLeague(parsed) {
  if (!parsed) return;
  const home = (typeof UD_HOME_LEAGUE_ID !== "undefined") ? UD_HOME_LEAGUE_ID : 1200;
  if (Number(parsed.leagueId) === Number(home)) {
    if (typeof setLeagueOverride === "function") setLeagueOverride("");
    setFeedMode("real");
  } else {
    if (typeof setLeagueOverride === "function") setLeagueOverride(String(parsed.leagueId));
    setFeedMode("test");
  }
}

// Snapshot everything a draft needs into a named config.
function saveDraftConfig(label) {
  const strat = (typeof getDraftStrategy === "function") ? getDraftStrategy() : { text: "", brief: "" };
  const cfg = {
    id: "cfg_" + Date.now().toString(36),
    label: label || "Draft config",
    savedAt: Date.now(),
    leagueUrl: localStorage.getItem("ud_league_url_v1") || "",
    leagueId: ESPN.leagueId,
    feedMode: getFeedMode(),
    strategyText: strat.text || "",
    strategyBrief: strat.brief || "",
    budgetAdj: (() => { try { return JSON.parse(localStorage.getItem("ud_budget_adj_v1") || "{}"); } catch (e) { return {}; } })(),
    keepers: localStorage.getItem("ud_my_keepers_v1") || null,
  };
  const list = _dsConfigs().filter(c => c.label !== cfg.label);   // same name replaces
  list.unshift(cfg);
  _dsSaveConfigs(list);
  return cfg;
}

// Load a config. League/mode/strategy/budgets apply in place; keepers and
// call-up overrides (module-cached stores) need a reload, offered via confirm.
function loadDraftConfig(id) {
  const cfg = _dsConfigs().find(c => c.id === id);
  if (!cfg) return;
  // Ask about roster state FIRST — cancelling must not leave a half-applied
  // mix of new league/strategy with old keepers.
  const hasRosterState = !!cfg.keepers;
  let restoreRoster = false;
  if (hasRosterState) {
    restoreRoster = confirm('"' + cfg.label + '" includes keeper picks. Restore those too? (Replaces your current keeper checkboxes; the page reloads to apply.)\n\nOK = everything · Cancel = just league/mode/strategy/budgets');
  }
  if (cfg.leagueUrl) localStorage.setItem("ud_league_url_v1", cfg.leagueUrl);
  _dsApplyLeague({ leagueId: cfg.leagueId, sport: "flb" });
  setFeedMode(cfg.feedMode || "off");
  if (typeof getDraftStrategy === "function") {
    getDraftStrategy().brief = cfg.strategyBrief || "";
    setDraftStrategyText(cfg.strategyText || "");   // persists text + brief together
  }
  if (typeof replaceBudgetAdjustments === "function") replaceBudgetAdjustments(cfg.budgetAdj || {});
  if (restoreRoster) {
    if (cfg.keepers) localStorage.setItem("ud_my_keepers_v1", cfg.keepers);
    location.reload();
    return;
  }
  // The mode/league switch above may have changed the persist context (real vs
  // the device-local mock key). Reload _liveDraft from the NEW context's key so
  // the displayed picks match it — otherwise a later save could write the prior
  // context's picks into the wrong key (R10). The real draft stays safe in its
  // own key and reloads when the real context is restored.
  if (typeof loadLiveDraft === "function") loadLiveDraft();
  renderDraft();
}

function deleteDraftConfig(id) {
  _dsSaveConfigs(_dsConfigs().filter(c => c.id !== id));
}

// ---------------------------------------------------------------------------

function renderDraftSetup(root) {
  let html = '<div class="ds-wrap">';

  // === Header: enter draft ===
  const readyChips = _dsReadyChips();
  html += '<div class="card" style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">';
  html += '<div><h2 style="margin:0;">Draft Setup</h2><div class="muted small">Configure below, then enter the cockpit. ' + _liveDraft.picks.length + ' pick' + (_liveDraft.picks.length === 1 ? '' : 's') + ' recorded.</div></div>';
  html += '<span style="flex:1;"></span>';
  html += readyChips;
  html += '<button class="btn primary" id="ds-enter" style="font-size:16px; padding:10px 22px;">⛶ Enter Draft</button>';
  html += '</div>';

  // === Draft-day readiness (plan Phase 4) ===
  html += _dsReadinessCard();

  // === Connection: league URL + feed mode (reuses the pick-feed panel) ===
  html += '<div class="card"><h3 style="margin:0 0 6px;">League & connection</h3>';
  html += '<p class="muted small" style="margin:0 0 6px;">Paste your ESPN league or draft-room URL (or a league id). Your real league arms <b>Real</b> mode; any other league becomes a <b>Test</b> mock.</p>';
  html += '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">';
  html += '<input id="ds-league-url" placeholder="https://fantasy.espn.com/baseball/draft?leagueId=…" value="' + esc(localStorage.getItem("ud_league_url_v1") || "") + '" style="flex:1; min-width:320px;">';
  html += '<button class="btn" id="ds-league-apply" style="width:auto; padding:6px 14px;">Apply</button>';
  html += '<span class="small" id="ds-league-status">' + _dsLeagueStatus() + '</span>';
  html += '</div>';
  // Mock drafts don't know which seat is yours — ESPN team ids are anonymous.
  // This selector powers max bid / recommendations / roster fit in Test mode.
  if (typeof draftTestMode === "function" && draftTestMode()) {
    const my = (typeof getMyDraftEspnId === "function") ? getMyDraftEspnId() : null;
    html += '<div style="display:flex; gap:8px; align-items:center; margin-top:8px;">';
    html += '<label class="small muted">My team in this mock <span class="dim">(auto-detected from your ESPN draft tab when it connects; this is the league team id, not your draft-order spot)</span>:</label>';
    html += '<input id="ds-my-team" type="number" min="1" max="99" placeholder="—" value="' + (my != null ? my : '') + '" style="width:70px;" title="Your team number in the ESPN draft room (any league size)">';
    html += '<span class="muted small">check your team\'s position in the ESPN draft room</span>';
    html += '</div>';
  }
  html += '</div>';
  html += renderDraftFeedPanel();

  // === Practice vs bots (UD-native mock → the real cockpit) ===
  if (typeof renderMockFeedControls === "function") html += renderMockFeedControls(false);
  if (typeof renderMockArchive === "function") html += renderMockArchive();

  // === Strategy ===
  const strat = (typeof getDraftStrategy === "function") ? getDraftStrategy() : { text: "", brief: "" };
  html += '<div class="card"><h3 style="margin:0 0 6px;">Draft strategy</h3>';
  html += '<textarea id="ds-strategy-text" rows="5" style="width:100%; resize:vertical;" placeholder="Your plan — targets, position budgets, punts, players to avoid…">' + esc(strat.text) + '</textarea>';
  html += '<div style="display:flex; gap:8px; align-items:center; margin-top:6px; flex-wrap:wrap;">';
  html += '<button class="btn" id="ds-strategy-save" style="width:auto; padding:5px 12px;">Save</button>';
  html += '<button class="btn" id="ds-strategy-condense" style="width:auto; padding:5px 12px;">Condense for AI</button>';
  html += '<button class="btn ghost" id="ds-strategy-clear" style="width:auto; padding:5px 12px;" title="Reset sliders/stances, clear target &amp; punt categories, and wipe your written strategy + AI brief">Clear My Strategy</button>';
  html += '<span class="small muted" id="ds-strategy-status">' + (strat.brief ? "Brief ready — shown in Draft Mode + fed to the AI" : "No AI brief yet") + '</span>';
  html += '<span style="flex:1;"></span>';
  html += '<span class="small muted">Sliders & punt categories: Settings ▸ My Strategy</span>';
  html += '</div>';
  html += '<div id="ds-strategy-brief" class="small" style="margin-top:8px; padding:8px 10px; border:1px solid var(--border); background:var(--bg-3); white-space:pre-wrap;' + (strat.brief ? '' : ' display:none;') + '">' + esc(strat.brief) + '</div>';
  html += '</div>';

  // === Keepers & budgets ===
  html += _dsKeepersBudgetsCard();

  // === Call-ups ===

  // === Saved configurations ===
  html += _dsConfigsCard();

  // === Fallback link ===
  html += '<p class="small muted" style="margin:4px 0 0;">Sync trouble mid-draft? <a href="#" id="ds-manual">Open the manual-entry view</a> — the old pick-by-pick recorder.</p>';

  html += '</div>';
  root.innerHTML = html;
  wireDraftSetup();
}

function _dsReadyChips() {
  const dot = (on) => '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (on ? "var(--good)" : "var(--text-3)") + ';margin-right:4px;vertical-align:middle;"></span>';
  const mode = getFeedMode();
  let s = '<span class="small" style="display:inline-flex; gap:12px; flex-wrap:wrap;">';
  s += '<span>' + dot(_feed.extPresent) + 'extension</span>';
  s += '<span>' + dot(draftTabOpen()) + 'ESPN tab</span>';
  s += '<span>' + dot(mode !== "off") + 'feed ' + esc(mode) + '</span>';
  s += '<span>' + dot(getValues().length > 0) + 'projections</span>';
  s += '</span>';
  return s;
}

// ---------------------------------------------------------------------------
// Draft-day readiness (plan Phase 4): every data feed, connection, and prep
// item the cockpit leans on, checked in one card so nothing is discovered
// broken at the first nomination. Pure presence/freshness checks — no network.

function _dsAgeDays(iso) {
  if (!iso) return null;
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
function _dsAgeLabel(days) {
  if (days == null) return "";
  return days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago";
}

function _dsReadinessChecks() {
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail: detail || "" });
  const mode = getFeedMode();
  const isTest = (typeof draftTestMode === "function") && draftTestMode();

  // Feed + pipe
  if (mode === "real") add("ok", "Feed mode REAL", "home-league picks only");
  else if (mode === "test") add("warn", "Feed mode TEST", "mock context — flip to Real for draft day");
  else add("bad", "Feed mode OFF", "no picks will arrive; set Real (or Test for a mock)");
  add(_feed.extPresent ? "ok" : "bad", "Keeper Edge extension", _feed.extPresent ? "heartbeat live" : "no heartbeat — reload the extension at chrome://extensions");
  add(draftTabOpen() ? "ok" : "warn", "ESPN draft tab", draftTabOpen() ? "open" : "open it BEFORE the draft starts so the INIT backfill has the full state");

  // Proxy (ESPN data, Rotowire news, AI assistant all ride it)
  const proxyUrl = (typeof ESPN !== "undefined") && ESPN.proxyUrl;
  let proxyKey = null;
  try { proxyKey = localStorage.getItem("ud_proxy_key"); } catch (e) {}
  if (proxyUrl && proxyKey) add("ok", "Proxy", "URL + key set");
  else add("bad", "Proxy", !proxyUrl ? "no proxy URL (Settings)" : "no proxy key — ESPN/AI calls will 401 (Settings ▸ Proxy key)");

  // Projections + dollar values (the whole valuation stack)
  const src = (typeof activeProjSource === "function") ? activeProjSource() : null;
  const srcLabel = (src && typeof getRosSourceLabel === "function") ? getRosSourceLabel(src) : src;
  const hasDollars = src && (typeof rosHasDollars === "function") && rosHasDollars(src);
  if (hasDollars) {
    const rec = (typeof _ros !== "undefined" && _ros.data) ? _ros.data[src] : null;
    const days = _dsAgeDays(rec && (rec.updatedAt || rec.importedAt));
    add(days != null && days > 14 ? "warn" : "ok", "Dollar values (" + (srcLabel || "?") + ")",
      days != null ? "updated " + _dsAgeLabel(days) + (days > 14 ? " — consider a fresh FanGraphs export" : "") : "loaded");
  } else {
    add("bad", "Dollar values", "no $ source active — values, inflation, and every bid cue run on this (Data tab)");
  }
  const stats = src && (typeof rosHasData === "function") && rosHasData(src);
  add(stats ? "ok" : "warn", "Stat projections",
    stats ? (srcLabel || "loaded") : "none for the active source — projected standings, category fit, and pace need them (Data tab)");

  // Market data (optional but drives the market-vs-model cue)
  const nfbcMeta = (typeof getNfbcMeta === "function") ? getNfbcMeta() : null;
  if (nfbcMeta && nfbcMeta.count > 0) {
    const days = _dsAgeDays(nfbcMeta.importedAt);
    add(days != null && days > 21 ? "warn" : "ok", "Market data (NFBC)",
      nfbcMeta.count + " players" + (days != null ? ", " + _dsAgeLabel(days) : ""));
  } else {
    add("warn", "Market data (NFBC)", "not imported — market-vs-model cues stay hidden (Data tab)");
  }

  // Prep
  const strat = (typeof getDraftStrategy === "function") ? getDraftStrategy() : null;
  add(strat && strat.brief ? "ok" : "warn", "Strategy brief",
    strat && strat.brief ? "ready — shown in Draft Mode + fed to the AI" : "write + condense your plan below");
  if (!isTest) {
    let kept = 0;
    try {
      const sel = (typeof getEffectiveKeeperSelections === "function") ? getEffectiveKeeperSelections() : {};
      for (const t of Object.values(sel)) kept += Object.values(t).filter(f => f && (f.keeper || f.minorKeeper)).length;
    } catch (e) {}
    add(kept > 0 ? "ok" : "warn", "Keeper predictions", kept > 0 ? kept + " marked — inflation is live" : "none marked — inflation runs at 1.00 (Keepers tab)");
  }
  return checks;
}

function _dsReadinessCard() {
  let checks = [];
  try { checks = _dsReadinessChecks(); } catch (e) { console.warn("readiness checks failed:", e); return ''; }
  const bad = checks.filter(c => c.level === "bad").length;
  const warn = checks.filter(c => c.level === "warn").length;
  const icon = { ok: "✅", warn: "⚠️", bad: "❌" };
  let html = '<div class="card"><h3 style="margin:0 0 6px;">🧳 Draft-day readiness</h3>';
  html += '<p class="muted small" style="margin:0 0 8px;">' + (bad ? '<b style="color:var(--bad);">' + bad + ' blocker' + (bad === 1 ? '' : 's') + '</b>' + (warn ? ' + ' + warn + ' to review' : '')
    : warn ? '<b style="color:var(--warn);">' + warn + ' item' + (warn === 1 ? '' : 's') + ' to review</b>'
    : '<b style="color:var(--good);">All clear.</b>') + ' Checks refresh on every visit to this tab.</p>';
  html += '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:4px 18px;">';
  for (const c of checks) {
    html += '<div class="small" style="display:flex; gap:7px; align-items:baseline;">' + icon[c.level] +
      ' <span><b>' + esc(c.label) + '</b>' + (c.detail ? ' <span class="muted">— ' + esc(c.detail) + '</span>' : '') + '</span></div>';
  }
  html += '</div></div>';
  return html;
}

function _dsLeagueStatus() {
  const test = (typeof draftTestMode === "function") ? draftTestMode()
    : ((typeof leagueOverrideActive === "function") && leagueOverrideActive());
  if (test) {
    const viaOverride = (typeof leagueOverrideActive === "function") && leagueOverrideActive();
    return '<span style="color:var(--warn);">TEST — ' + (viaOverride ? 'league ' + esc(String(ESPN.leagueId)) : 'mock (any league)') + '</span>';
  }
  return '<span style="color:var(--good);">REAL — league ' + esc(String(ESPN.leagueId)) + '</span>';
}

function _dsKeepersBudgetsCard() {
  let html = '<div class="card"><h3 style="margin:0 0 6px;">Keepers & budgets</h3>';
  html += '<p class="muted small" style="margin:0 0 6px;">Keeper picks come from the <a href="#" id="ds-goto-keepers">Keepers tab</a>. Draft-$ shows the traded-dollars sheet; type in <b>Manual</b> to override a team\'s adjustment (blank = use sheet). <b>Ignored in Test mode</b> — mocks use generic $260 teams with no keepers.</p>';
  if (typeof computeTeamBudgets !== "function") return html + '</div>';
  const budgets = computeTeamBudgets();
  html += '<table style="font-size:12px;"><thead><tr><th>Team</th><th class="num">ML keep</th><th class="num">MiL</th><th class="num">Keeper $</th><th class="num">Sheet $±</th><th class="num">Manual $±</th><th class="num">Budget</th></tr></thead><tbody>';
  for (const t of LEAGUE.teams) {
    const b = budgets[t.id];
    if (!b) continue;
    const sheet = (typeof getDraftDollarAdjustment === "function") ? getDraftDollarAdjustment(t.id) : 0;
    const manual = (typeof getManualBudgetAdjustment === "function") ? getManualBudgetAdjustment(t.id) : null;
    html += '<tr' + (t.isMe ? ' style="background:rgba(79,142,247,.08);"' : '') + '>';
    html += '<td>' + esc(t.owner) + '</td>';
    html += '<td class="num">' + b.keeperCount + '</td><td class="num">' + b.minorCount + '</td>';
    html += '<td class="num">$' + b.keepers + '</td>';
    html += '<td class="num muted">' + (sheet >= 0 ? '+' : '') + sheet + '</td>';
    html += '<td class="num"><input class="ds-badj" data-team="' + esc(t.id) + '" type="number" placeholder="—" value="' + (manual != null ? manual : '') + '" style="width:64px; text-align:right;"></td>';
    html += '<td class="num"><b>$' + b.remaining + '</b></td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function _dsConfigsCard() {
  const configs = _dsConfigs();
  let html = '<div class="card"><h3 style="margin:0 0 6px;">Saved configurations</h3>';
  html += '<p class="muted small" style="margin:0 0 6px;">Snapshot of league/mode, strategy, budget overrides, keeper picks, and call-ups — load one to set up a future draft (or re-arm a mock) in one click.</p>';
  html += '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">';
  html += '<input id="ds-config-name" placeholder="Name this setup (e.g. 2027 real draft)" style="flex:1; min-width:220px;">';
  html += '<button class="btn primary" id="ds-config-save" style="width:auto; padding:6px 14px;">💾 Save current setup</button>';
  html += '</div>';
  if (!configs.length) {
    html += '<p class="muted small">No saved configurations yet.</p>';
  } else {
    html += '<table style="font-size:12px;"><thead><tr><th>Name</th><th>Saved</th><th>League</th><th>Mode</th><th></th><th></th></tr></thead><tbody>';
    for (const c of configs) {
      html += '<tr>';
      html += '<td><b>' + esc(c.label) + '</b></td>';
      html += '<td class="muted small">' + new Date(c.savedAt).toLocaleDateString() + '</td>';
      html += '<td>' + esc(String(c.leagueId)) + '</td>';
      html += '<td>' + esc(c.feedMode || "off") + '</td>';
      html += '<td><button class="btn ghost ds-config-load" data-id="' + esc(c.id) + '" style="padding:2px 10px;">Load</button></td>';
      html += '<td><button class="btn ghost ds-config-del" data-id="' + esc(c.id) + '" style="padding:2px 8px; color:var(--bad);">✕</button></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>';
  return html;
}

function wireDraftSetup() {
  document.getElementById("ds-enter")?.addEventListener("click", () => setDraftMode(true));
  document.getElementById("ds-manual")?.addEventListener("click", (e) => {
    e.preventDefault();
    _liveDraft.manualView = true;
    renderDraft();
  });
  document.getElementById("ds-goto-keepers")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof switchView === "function") switchView("keepers");
  });

  // League URL
  const applyLeague = () => {
    const raw = document.getElementById("ds-league-url").value;
    localStorage.setItem("ud_league_url_v1", raw);
    const parsed = parseLeagueUrl(raw);
    if (!parsed) {
      const st = document.getElementById("ds-league-status");
      if (st) st.innerHTML = '<span style="color:var(--bad);">No leagueId found in that URL</span>';
      return;
    }
    _dsApplyLeague(parsed);
    renderDraft();
  };
  document.getElementById("ds-league-apply")?.addEventListener("click", applyLeague);
  document.getElementById("ds-my-team")?.addEventListener("change", (e) => {
    if (typeof setMyDraftEspnId === "function") setMyDraftEspnId(e.target.value);
  });
  document.getElementById("ds-league-url")?.addEventListener("keydown", (e) => { if (e.key === "Enter") applyLeague(); });

  // Feed-panel buttons are wired once via delegation in draft.js.

  // Strategy
  document.getElementById("ds-strategy-save")?.addEventListener("click", () => {
    setDraftStrategyText(document.getElementById("ds-strategy-text").value);
    const st = document.getElementById("ds-strategy-status");
    if (st) st.textContent = "Saved.";
  });
  document.getElementById("ds-strategy-clear")?.addEventListener("click", () => {
    if (!confirm("Clear My Draft Strategy? This resets the sliders and stances, clears target/punt categories, and wipes your written strategy + AI brief.")) return;
    if (typeof clearMyStrategyAll === "function") clearMyStrategyAll();
    else if (typeof clearDraftStrategy === "function") clearDraftStrategy();   // settings.js not loaded — still wipe the text/brief
    renderDraft();   // re-renders the lobby: empty textarea, brief hidden, readiness check updates
  });
  document.getElementById("ds-strategy-condense")?.addEventListener("click", async () => {
    const st = document.getElementById("ds-strategy-status");
    setDraftStrategyText(document.getElementById("ds-strategy-text").value);
    if (st) st.textContent = "Condensing…";
    try {
      const brief = await condenseDraftStrategy();
      const box = document.getElementById("ds-strategy-brief");
      if (box) { box.textContent = brief; box.style.display = ""; }
      if (st) st.textContent = "Brief ready.";
    } catch (e) {
      if (st) st.textContent = "Failed: " + e.message;
    }
  });

  // Budget overrides — save on change, refresh the Budget column.
  document.querySelectorAll(".ds-badj").forEach(inp => inp.addEventListener("change", () => {
    setManualBudgetAdjustment(inp.dataset.team, inp.value);
    // Patch just this row's Budget cell — a full re-render would steal focus
    // and break tabbing across cells.
    const b = computeTeamBudgets()[inp.dataset.team];
    const cell = inp.closest("tr")?.querySelector("td:last-child b");
    if (b && cell) cell.textContent = "$" + b.remaining;
  }));

  // Call-ups

  // Configs
  document.getElementById("ds-config-save")?.addEventListener("click", () => {
    const name = (document.getElementById("ds-config-name").value || "").trim() || ("Draft config " + new Date().toLocaleDateString());
    // Persist any unsaved strategy text first so the snapshot is current.
    const txt = document.getElementById("ds-strategy-text");
    if (txt) setDraftStrategyText(txt.value);
    saveDraftConfig(name);
    renderDraft();
  });
  document.querySelectorAll(".ds-config-load").forEach(b => b.addEventListener("click", () => loadDraftConfig(b.dataset.id)));
  document.querySelectorAll(".ds-config-del").forEach(b => b.addEventListener("click", () => {
    const cfg = _dsConfigs().find(c => c.id === b.dataset.id);
    if (cfg && confirm('Delete saved configuration "' + cfg.label + '"?')) { deleteDraftConfig(b.dataset.id); renderDraft(); }
  }));
}
