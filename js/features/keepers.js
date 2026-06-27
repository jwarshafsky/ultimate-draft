// Keepers view — per-team keeper board. For each team you check off who you
// think (or, for your own team, decide) will be kept, see the league-website
// mark alongside, and rank candidates by inflation-adjusted surplus.
//
//   • My Keeper       — your pick/prediction (local, per team)        [ask 1]
//   • League mark     — what the league site has flagged (Supabase)   [ask 2]
//   • Projection src  — Steamer/BATX/ATC ROS $ (or preseason)         [ask 3]
//   • Sorted by Value, with a per-team total                          [ask 4]
//   • Value = Predicted $ − (Keeper Cost ÷ Inflation)                 [ask 5]
//
// Candidate pool = each team's live ESPN roster + their minor-league keepers,
// with keeper eligibility surfaced (expiring contracts; manual flag for
// post-trade-deadline FA adds we can't detect from draft history).

const KEEPER_INFLATION_KEY = "ud_keeper_inflation_v1";

const _keepersState = {
  rosters: null,        // { teamId: [espnPlayer] } once loaded
  loadingRosters: false,
  rosterError: null,
  onlyKeepers: false,   // hide non-keeper roster players
  inflation: null,      // user override; null = use computed flat multiplier
};

// Format a surplus/Value dollar amount: "+$12", "−$3", "$0" (no "$-0").
function _fmtSurplus(v) {
  const r = Math.round(v);
  if (r === 0) return "$0";
  return (r > 0 ? "+$" : "−$") + Math.abs(r);
}

// Predicted $ for a player from the chosen source: ROS auction $ if the source
// has it, otherwise the preseason valuation.
function _keeperPredValue(name, type, source) {
  if (source && source !== "preseason" && typeof getRosDollar === "function") {
    const d = getRosDollar(source, name, type);
    if (d != null) return d;
  }
  const v = getPlayerValue(name);
  return v ? v.value : null;
}

// Effective inflation multiplier (e.g. 1.15). User override wins; else the
// engine's flat multiplier; else 1.0.
function _keeperInflation() {
  if (_keepersState.inflation == null) {
    const saved = parseFloat(localStorage.getItem(KEEPER_INFLATION_KEY));
    if (isFinite(saved) && saved > 0) _keepersState.inflation = saved;
  }
  if (_keepersState.inflation != null && _keepersState.inflation > 0) return _keepersState.inflation;
  const flat = (typeof computeFlatInflation === "function") ? computeFlatInflation() : null;
  return flat && flat.multiplier > 0 ? flat.multiplier : 1.0;
}

// Which projection sources are available to choose from.
function _keeperSources() {
  const out = [];
  if (typeof ROS_SOURCES !== "undefined") {
    for (const s of ROS_SOURCES) {
      if (rosHasData(s.id)) {
        out.push({ id: s.id, label: s.label, hasDollars: rosHasDollars(s.id) });
      }
    }
  }
  const meta = getProjectionMeta();
  if ((meta.hitterCount || 0) + (meta.pitcherCount || 0) > 0) {
    out.push({ id: "preseason", label: "Preseason — " + (meta.source || "FanGraphs"), hasDollars: true });
  }
  return out;
}

function _currentKeeperSource(sources) {
  const pref = (typeof getKeeperProjSource === "function") ? getKeeperProjSource() : null;
  if (pref && sources.some(s => s.id === pref)) return pref;
  // Prefer an in-season ROS source that actually carries dollar values.
  const withDollars = sources.find(s => s.id !== "preseason" && s.hasDollars);
  if (withDollars) return withDollars.id;
  return sources.length ? sources[0].id : "preseason";
}

// Build the candidate list for one team: ESPN roster majors + MiL keepers +
// anything you've already marked. Each entry is enriched for display.
function _teamCandidates(team, source, inflation) {
  const selections = getKeeperSelections();
  const teamSel = selections[team.id] || {};
  const rosters = _keepersState.rosters;
  const byName = new Map();

  const add = (name, base) => {
    if (!name) return;
    if (!byName.has(name)) byName.set(name, { name, ...base });
    else Object.assign(byName.get(name), base);
  };

  // Live ESPN roster (majors).
  if (rosters && rosters[team.id]) {
    for (const p of rosters[team.id]) {
      add(p.name, { pos: p.pos || "", type: p.type || "H", isMinor: false, onRoster: true });
    }
  }
  // Minor-league keepers from the league site (stashed off the ESPN roster).
  for (const [name, f] of Object.entries(teamSel)) {
    if (f.minorKeeper) add(name, { isMinor: true });
  }
  // League-marked majors + anything you've picked — so nothing you care about
  // is missing even before rosters load.
  for (const [name, f] of Object.entries(teamSel)) {
    if (f.keeper && !byName.has(name)) add(name, { isMinor: false });
  }
  for (const name of (typeof getMyTeamPicks === "function" ? getMyTeamPicks(team.id) : [])) {
    if (!byName.has(name)) add(name, { isMinor: false });
  }

  const rows = [];
  for (const c of byName.values()) {
    const leagueSel = teamSel[c.name] || null;
    if (c.isMinor == null) c.isMinor = !!(leagueSel && leagueSel.minorKeeper);
    let type = c.type;
    let pos = c.pos;
    if (!type || !pos) {
      const v = getPlayerValue(c.name);
      type = type || (v ? v.type : "H");
      pos = pos || (v ? v.pos : "—");
    }
    const myPicked = (typeof isMyKeeper === "function") && isMyKeeper(team.id, c.name);
    const myIneligible = (typeof isMyIneligible === "function") && isMyIneligible(team.id, c.name);
    const rawCost = c.isMinor ? 0 : getCurrentKeeperSalary(c.name);
    const cost = rawCost == null ? 0 : rawCost;
    const costMissing = !c.isMinor && rawCost == null;
    const predValue = _keeperPredValue(c.name, type, source);
    const surplus = predValue != null ? predValue - cost : null;            // plain
    const value = predValue != null ? predValue - cost / inflation : null;  // inflation-adjusted
    const contract = c.isMinor ? null : getKeeperContractStatus(c.name);
    const eligible = c.isMinor ? !myIneligible : (!!contract && contract.canKeepNextSeason && !myIneligible);

    rows.push({
      name: c.name, pos, type, isMinor: c.isMinor, onRoster: !!c.onRoster,
      leagueSel, myPicked, myIneligible,
      cost, costMissing, predValue, surplus, value, contract, eligible,
    });
  }

  // Sort by inflation-adjusted Value (surplus), nulls last.
  rows.sort((a, b) => {
    if (a.value == null && b.value == null) return a.name.localeCompare(b.name);
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return b.value - a.value;
  });
  return rows;
}

function renderKeepers() {
  const root = document.getElementById("view-root");
  const sources = _keeperSources();
  const source = _currentKeeperSource(sources);
  const inflation = _keeperInflation();
  const meta = getProjectionMeta();
  const hasAnyProj = sources.length > 0;

  // === Controls ===
  let html = '<div class="card"><h2>Keepers by Team</h2>';
  html += '<p class="muted small">Check who you think each team keeps (your picks for your own team). The <b>League</b> column shows what’s flagged on the league site. <b>Value</b> = Predicted $ − (Keeper Cost ÷ Inflation). Sorted by Value.</p>';
  html += '<div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:8px;">';

  // Projection source
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">Projection $ ';
  if (sources.length) {
    html += '<select id="kp-source">';
    for (const s of sources) {
      const tag = s.id === "preseason" ? "" : (s.hasDollars ? " · $" : " · no $");
      html += '<option value="' + esc(s.id) + '"' + (s.id === source ? " selected" : "") + '>' + esc(s.label) + tag + '</option>';
    }
    html += '</select>';
  } else {
    html += '<span class="dim">none loaded</span>';
  }
  html += '</label>';

  // Inflation
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">Inflation ' +
    '<input id="kp-infl" type="number" step="0.05" min="1" max="3" value="' + inflation.toFixed(2) + '" style="width:80px;"></label>';

  // Load rosters
  html += '<button class="btn" id="kp-load" style="width:auto; padding:6px 12px;">' +
    (_keepersState.loadingRosters ? "Loading…" : (_keepersState.rosters ? "Refresh rosters" : "Load rosters from ESPN")) + '</button>';

  // Only-keepers filter
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">' +
    '<input type="checkbox" id="kp-only"' + (_keepersState.onlyKeepers ? " checked" : "") + '> Only keepers</label>';
  html += '</div>';

  html += '<p class="small muted" style="margin-top:6px;">Inflation starts at <b>1.00</b> with no keepers and rises as you check players — driven only by your predicted keepers (flagged-ineligible picks excluded). Updates Values, Board &amp; Overview app-wide.</p>';
  if (_keepersState.rosterError) {
    html += '<p class="small" style="color:var(--bad); margin-top:6px;">Roster load failed: ' + esc(_keepersState.rosterError) + '</p>';
  }
  if (!_keepersState.rosters) {
    html += '<p class="small muted" style="margin-top:6px;">Load ESPN rosters to predict keepers from each team’s full roster. Until then, only flagged + your picks show.</p>';
  } else {
    const teamCt = Object.values(_keepersState.rosters).filter(a => a && a.length).length;
    const playerCt = Object.values(_keepersState.rosters).reduce((s, a) => s + (a ? a.length : 0), 0);
    const lowWarn = teamCt < LEAGUE.teams.length || playerCt < LEAGUE.teams.length * 15;
    const rm = _keepersState.rosterMeta || {};
    const unmapped = (rm.unmappedIds && rm.unmappedIds.length) ? rm.unmappedIds.join(", ") : "";
    html += '<p class="small ' + (lowWarn ? "" : "muted") + '" style="margin-top:6px;' + (lowWarn ? "color:var(--warn);" : "") + '">' +
      'Loaded <b>' + teamCt + '/' + LEAGUE.teams.length + '</b> teams · <b>' + playerCt + '</b> rostered players' +
      (rm.rawTeamCount != null ? ' · ESPN returned ' + rm.rawTeamCount + ' teams' : '') +
      (unmapped ? ' · <b style="color:var(--bad);">unmapped ESPN team ids: ' + esc(unmapped) + '</b> (team-id map needs updating)' : '') +
      (lowWarn && !unmapped ? ' — that looks low; try “Refresh rosters”. Minor leaguers are stashed off ESPN rosters and come from league MiL marks.' : '') + '</p>';
  }
  if (source && source !== "preseason" && !rosHasDollars(source)) {
    html += '<p class="small" style="color:var(--warn); margin-top:6px;">This ROS source has no projected $ — Predicted $ falls back to preseason values. Import a FanGraphs export with a Dollars column (Data tab) for ROS pricing.</p>';
  }
  if (!hasAnyProj) {
    html += '<p class="small muted" style="margin-top:6px;">No projections loaded — import on the Data tab to see Predicted $ and Value.</p>';
  }
  html += '</div>';

  // === Per-team boards ===
  const me = LEAGUE.teams.find(t => t.isMe);
  const others = LEAGUE.teams.filter(t => !t.isMe).slice().sort((a, b) => a.owner.localeCompare(b.owner));
  const order = me ? [me, ...others] : others;

  const rostersLoaded = !!_keepersState.rosters;
  for (const t of order) {
    let rows = _teamCandidates(t, source, inflation);
    const rosterCount = (rostersLoaded && _keepersState.rosters[t.id]) ? _keepersState.rosters[t.id].length : 0;
    if (_keepersState.onlyKeepers) {
      rows = rows.filter(r => r.myPicked || (r.leagueSel && (r.leagueSel.keeper || r.leagueSel.minorKeeper)));
    }
    // When rosters are loaded, always render every team (so a team that came
    // back empty is visible, not silently dropped). Otherwise skip empty teams.
    if (!rows.length && !rostersLoaded) continue;

    const picks = rows.filter(r => r.myPicked);
    const mlPicks = picks.filter(r => !r.isMinor);
    const milPicks = picks.filter(r => r.isMinor);
    const totalCost = mlPicks.reduce((s, r) => s + r.cost, 0);
    const totalSurplus = picks.reduce((s, r) => s + (r.surplus || 0), 0);
    const totalValue = picks.reduce((s, r) => s + (r.value || 0), 0);

    html += '<div class="card"' + (t.isMe ? ' style="border-color: rgba(79,142,247,.4);"' : '') + '>';
    html += '<h2>' + esc(t.name) + ' <span class="muted small">· ' + esc(t.owner) +
      (rostersLoaded ? ' · ' + rosterCount + ' rostered' : '') + '</span></h2>';
    // Pick summary + cap status
    const mlOver = mlPicks.length > LEAGUE.maxMlKeepers;
    const milOver = milPicks.length > LEAGUE.maxMilKeepers;
    html += '<div class="small muted" style="margin-bottom:8px;">';
    html += 'My keepers: <b>' + picks.length + '</b> · ' +
      'ML <b style="color:' + (mlOver ? "var(--bad)" : "inherit") + '">' + mlPicks.length + '/' + LEAGUE.maxMlKeepers + '</b> · ' +
      'MiL <b style="color:' + (milOver ? "var(--bad)" : "inherit") + '">' + milPicks.length + '/' + LEAGUE.maxMilKeepers + '</b> · ' +
      'Cost <b>$' + totalCost + '</b> · Surplus <b style="color:' + (totalSurplus > 0 ? "var(--good)" : totalSurplus < 0 ? "var(--bad)" : "inherit") + '">' + _fmtSurplus(totalSurplus) + '</b>' +
      ' · Value <b style="color:' + (totalValue > 0 ? "var(--good)" : totalValue < 0 ? "var(--bad)" : "inherit") + '">' + _fmtSurplus(totalValue) + '</b>';
    html += '</div>';

    if (!rows.length) {
      html += '<p class="small dim">No roster players loaded for this team.</p></div>';
      continue;
    }

    html += '<table><thead><tr>';
    html += '<th style="width:34px;">Keep</th><th>Player</th><th>Pos</th><th>League</th>' +
      '<th class="num">Cost</th><th class="num">Pred $</th><th class="num" title="Predicted $ − Cost">Surplus</th>' +
      '<th class="num" title="Predicted $ − (Cost ÷ Inflation)">Value</th><th>Eligibility</th>';
    html += '</tr></thead><tbody>';

    for (const r of rows) {
      const tid = esc(t.id), pn = esc(r.name);
      const warnRow = r.myPicked && !r.eligible;
      let cls = r.myPicked ? (r.isMinor ? "minor-kept" : "kept") : "";
      html += '<tr class="' + cls + '"' + (warnRow ? ' style="background:rgba(229,115,115,.08);"' : '') + '>';

      // My-keeper checkbox
      html += '<td class="num"><input type="checkbox" class="kp-check" data-team="' + tid + '" data-player="' + pn + '"' + (r.myPicked ? " checked" : "") + '></td>';

      // Player
      html += '<td>' + esc(r.name) + (r.isMinor ? ' <span class="kbd" style="color:var(--minor);">MiL</span>' : '') + '</td>';

      // Pos
      html += '<td>' + esc(r.pos || "—") + '</td>';

      // League mark
      const ls = r.leagueSel;
      const badges = [];
      if (ls) {
        if (ls.keeper) badges.push('<span class="kbd" style="color:var(--keeper);" title="Marked keeper on league site">K</span>');
        if (ls.minorKeeper) badges.push('<span class="kbd" style="color:var(--minor);" title="Marked minor-league keeper">MiL</span>');
        if (ls.rule5) badges.push('<span class="kbd" style="color:var(--warn);" title="Rule 5">R5</span>');
        if (ls.tradeBlock) badges.push('<span class="kbd" style="color:var(--accent);" title="Trade block">TB</span>');
      }
      html += '<td>' + (badges.length ? badges.join(" ") : '<span class="dim">—</span>') + '</td>';

      // Cost
      html += '<td class="num">' + (r.isMinor ? '<span class="dim">$0</span>' : (r.costMissing ? '<span class="dim" title="No draft record — assumed">$' + r.cost + '?</span>' : '$' + r.cost)) + '</td>';

      // Predicted $
      html += '<td class="num">' + (r.predValue != null ? '$' + r.predValue.toFixed(0) : '<span class="dim">—</span>') + '</td>';

      // Surplus = Predicted $ − Cost
      const sp = r.surplus;
      html += '<td class="num ' + (sp != null ? (sp > 0 ? "good" : sp < 0 ? "bad" : "") : "") + '">' +
        (sp != null ? _fmtSurplus(sp) : '<span class="dim">—</span>') + '</td>';

      // Value = Predicted $ − (Cost ÷ Inflation)
      const v = r.value;
      html += '<td class="num ' + (v != null ? (v > 0 ? "good" : v < 0 ? "bad" : "") : "") + '">' +
        (v != null ? _fmtSurplus(v) : '<span class="dim">—</span>') + '</td>';

      // Eligibility
      html += '<td>' + _eligibilityCell(t.id, r) + '</td>';

      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  if (!order.some(t => _teamCandidates(t, source, inflation).length)) {
    html += '<div class="empty"><p>Nothing to show yet.</p><p class="small">Load ESPN rosters, or mark keepers on the league site.</p></div>';
  }

  root.innerHTML = html;

  // Keep the topbar inflation badge in sync — it now reflects predicted keepers.
  const badge = document.getElementById("inflation-badge");
  if (badge && typeof computeTieredInflation === "function") {
    const inf = computeTieredInflation();
    if (inf) {
      badge.textContent = "infl " + inf.multiplier.toFixed(2) + "x";
      badge.className = "badge " + (inf.multiplier > 1.2 ? "hot" : inf.multiplier < 1.0 ? "cold" : "");
    }
  }

  _wireKeepers();
}

// Eligibility cell: contract status badge + a manual "ineligible" toggle for
// cases (post-deadline FA adds) we can't infer from history.
function _eligibilityCell(teamId, r) {
  const tid = esc(teamId), pn = esc(r.name);
  let out = "";
  if (r.myIneligible) {
    out += '<span class="kbd" style="color:var(--bad);" title="Manually marked ineligible">INELIGIBLE</span> ';
  } else if (r.isMinor) {
    out += '<span class="kbd" style="color:var(--minor);">MiL keeper</span> ';
  } else if (r.contract) {
    const c = r.contract;
    if (!c.known) out += '<span class="kbd dim" title="No draft record">unknown</span> ';
    else if (c.status === "final") out += '<span class="kbd" style="color:var(--bad);" title="Used all keeper years">' + esc(c.label) + '</span> ';
    else if (c.status === "expiring") out += '<span class="kbd" style="color:var(--warn);">' + esc(c.label) + '</span> ';
    else out += '<span class="kbd" style="color:var(--good);">' + esc(c.label) + '</span> ';
    if (c.estimated) out += '<span class="kbd dim" title="Original price estimated (auction predates history)">est</span> ';
  }
  // Toggle link
  out += '<a href="#" class="kp-inelig" data-team="' + tid + '" data-player="' + pn + '" style="font-size:11px; color:var(--dim);">' +
    (r.myIneligible ? "clear" : "mark ineligible") + '</a>';
  return out;
}

function _wireKeepers() {
  document.querySelectorAll(".kp-check").forEach(el => {
    el.addEventListener("change", () => {
      setMyKeeper(el.dataset.team, el.dataset.player, el.checked);
      renderKeepers();
    });
  });
  document.querySelectorAll(".kp-inelig").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const cur = isMyIneligible(el.dataset.team, el.dataset.player);
      setMyIneligible(el.dataset.team, el.dataset.player, !cur);
      renderKeepers();
    });
  });
  const src = document.getElementById("kp-source");
  if (src) src.addEventListener("change", () => { setKeeperProjSource(src.value); renderKeepers(); });
  const infl = document.getElementById("kp-infl");
  if (infl) infl.addEventListener("change", () => {
    const v = parseFloat(infl.value);
    if (isFinite(v) && v > 0) { _keepersState.inflation = v; localStorage.setItem(KEEPER_INFLATION_KEY, String(v)); }
    renderKeepers();
  });
  const only = document.getElementById("kp-only");
  if (only) only.addEventListener("change", () => { _keepersState.onlyKeepers = only.checked; renderKeepers(); });
  const load = document.getElementById("kp-load");
  if (load) load.addEventListener("click", _loadKeeperRosters);
}

async function _loadKeeperRosters() {
  if (_keepersState.loadingRosters) return;
  _keepersState.loadingRosters = true;
  _keepersState.rosterError = null;
  renderKeepers();
  try {
    const res = await fetchEspnRosters(0);
    _keepersState.rosters = res.rosters || {};
    _keepersState.rosterMeta = { rawTeamCount: res.rawTeamCount, unmappedIds: res.unmappedIds || [] };
  } catch (e) {
    _keepersState.rosterError = e.message || String(e);
  } finally {
    _keepersState.loadingRosters = false;
    renderKeepers();
  }
}
