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

// The single keeper-inflation value used for the topbar badge on every tab, so
// it doesn't change as you move between Keepers / Values / Overview. Mirrors the
// keeper page's own two-pass computation (override, else pool inflation from the
// active source + eligible predicted keepers).
function computeKeeperInflation() {
  const source = _currentKeeperSource(_keeperSources());
  let keptCost = 0, keptValue = 0;
  for (const t of LEAGUE.teams) {
    for (const r of _teamCandidates(t, source)) {
      if (r.myPicked && r.eligible) { keptCost += r.cost; keptValue += (r.predValue || 0); }
    }
  }
  const override = _keeperInflationOverride();
  return override != null ? override : _poolInflation(source, keptCost, keptValue);
}

// Update the topbar inflation badge from the shared keeper-inflation value.
function updateInflationBadge() {
  const badge = document.getElementById("inflation-badge");
  if (!badge) return;
  const inf = computeKeeperInflation();
  badge.textContent = "keeper infl " + inf.toFixed(2) + "×";
  badge.title = "Auction prices should run ~" + Math.round((inf - 1) * 100) +
    "% above sticker value because keepers lock up bargains — based on your Keepers-tab predictions.";
  badge.className = "badge " + (inf > 1.2 ? "hot" : inf < 1.0 ? "cold" : "");
}

// Manual inflation override the user typed (persisted), or null for auto.
function _keeperInflationOverride() {
  if (_keepersState.inflation == null) {
    const saved = parseFloat(localStorage.getItem(KEEPER_INFLATION_KEY));
    if (isFinite(saved) && saved > 0) _keepersState.inflation = saved;
  }
  return (_keepersState.inflation != null && _keepersState.inflation > 0) ? _keepersState.inflation : null;
}

// Auto inflation from the SAME $ pool that drives Predicted $ (so it works
// in-season off ROS/FG-$ even when no preseason projections are loaded).
// Normalized so a no-keeper league reads exactly 1.00; checked keepers (which
// are bargains) push it above 1, which is what makes Value diverge from Surplus.
//   inflation = [(budget − keptCost) / (poolValue − keptValue)] / (budget / poolValue)
function _poolInflation(source, keptCost, keptValue) {
  let poolValue = 0;
  const map = (source && source !== "preseason" && typeof getRosDollarMap === "function") ? getRosDollarMap(source) : null;
  if (map && Object.keys(map).length) {
    for (const k in map) { if (map[k] > 0) poolValue += map[k]; }
  } else if (typeof getValues === "function") {
    for (const p of getValues()) { if (p.value > 0) poolValue += p.value; }
  }
  if (poolValue <= 0) return 1;
  const budget = LEAGUE.draftBudget * LEAGUE.numTeams;
  const remVal = poolValue - keptValue;
  if (remVal <= 0) return 1;
  const infl = ((budget - keptCost) / remVal) / (budget / poolValue);
  return infl > 0 && isFinite(infl) ? infl : 1;
}

// Projection sources + active source — shared app-wide (same as the Values tab)
// so the two tabs always agree on which $ data they're showing.
function _keeperSources() {
  return (typeof projectionSources === "function") ? projectionSources() : [];
}

function _currentKeeperSource(sources) {
  if (typeof activeProjSource === "function") return activeProjSource() || "preseason";
  const pref = (typeof getKeeperProjSource === "function") ? getKeeperProjSource() : null;
  if (pref && sources.some(s => s.id === pref)) return pref;
  const withDollars = sources.find(s => s.id !== "preseason" && s.hasDollars);
  return withDollars ? withDollars.id : (sources.length ? sources[0].id : "preseason");
}

// Build one team's candidate list. Membership comes from the LIVE ESPN roster
// (the only current truth for who's actually on a team); contracts/cost are
// overlaid by name from The League App (accurate keeper years). Minor-league
// stashes (not on the ESPN active roster) come from The League App's minors.
// If ESPN isn't available, fall back to The League App's anchor entirely.
function _teamCandidates(team, source) {
  const teamSel = getKeeperSelections()[team.id] || {};
  const season = (typeof leagueRosterSeason === "function") ? leagueRosterSeason() : new Date().getFullYear();
  const espn = _keepersState.rosters;            // { teamId: [espnPlayer] } or null
  const ld = (typeof getLeagueTeamRoster === "function") ? getLeagueTeamRoster(team.id) : null;
  const rows = [];
  const seen = new Set();

  const push = (name, o) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    const v = getPlayerValue(name);
    const type = o.type || (v ? v.type : "H");
    const pos = o.pos || (v ? v.pos : "—");
    let cost = o.cost == null ? 0 : o.cost;
    // Manual cost override (Jeff edited the Cost cell) wins over the overlaid
    // League App cost and sticks until he edits it again.
    const costOverride = (typeof getMyKeeperCost === "function") ? getMyKeeperCost(team.id, name) : null;
    const costOverridden = costOverride != null;
    if (costOverridden) cost = costOverride;
    const myPicked = (typeof isMyKeeper === "function") && isMyKeeper(team.id, name);
    const myIneligible = (typeof isMyIneligible === "function") && isMyIneligible(team.id, name);
    // Prospects use the same projected $ (ROS / next-year) as everyone else;
    // it's just null for players the projection source doesn't cover yet.
    const predValue = _keeperPredValue(name, type, source);
    const surplus = predValue != null ? predValue - cost : null;            // Pred $ − Cost
    const contractExpired = !!(o.contract && !o.contract.canKeepNextSeason); // used all keeper years
    const eligible = !contractExpired && !myIneligible;
    rows.push({
      name, pos, type, kind: o.kind, isMinor: o.kind === "minor",
      leagueSel: teamSel[name] || null, myPicked, myIneligible,
      cost, costOverridden, costMissing: costOverridden ? false : !!o.costMissing, predValue, surplus, value: null,
      contract: o.contract || null, contractExpired, eligible,
    });
  };

  if (espn && espn[team.id]) {
    // Current ML roster from ESPN; overlay The League App contract by name.
    for (const p of espn[team.id]) {
      const ci = (typeof getLeagueContractByName === "function") ? getLeagueContractByName(p.name, season) : null;
      if (ci) push(p.name, { pos: p.pos, type: p.type, kind: ci.kind, contract: ci.contract, cost: ci.cost, costMissing: ci.costMissing });
      else {
        const rawCost = getCurrentKeeperSalary(p.name);   // FA pickup — no League App contract
        push(p.name, { pos: p.pos, type: p.type, kind: "fa", contract: null, cost: rawCost == null ? 0 : rawCost, costMissing: rawCost == null });
      }
    }
    // Minor-league stashes (not on the ESPN active roster).
    if (ld) for (const p of (ld.minors || [])) push(p.name, { kind: "minor", contract: leagueMinorContract(p, season), cost: 0 });
  } else if (ld) {
    // Fallback: no ESPN — use The League App anchor (may be stale for majors).
    for (const p of (ld.majors || [])) { const c = leagueMajorContract(p, season); push(p.name, { kind: "major", contract: c, cost: c.nextYearPrice }); }
    for (const p of (ld.callups || [])) { const c = leagueMinorContract(p, season); const ov = (typeof getCallupOverride === "function") ? getCallupOverride(p.name) : null; push(p.name, { kind: "callup", contract: c, cost: ov && ov.price != null ? ov.price : 0, costMissing: !(ov && ov.price != null) }); }
    for (const p of (ld.minors || [])) push(p.name, { kind: "minor", contract: leagueMinorContract(p, season), cost: 0 });
  }

  // Include any player you've marked who isn't otherwise listed, so it's never lost.
  for (const name of (typeof getMyTeamPicks === "function" ? getMyTeamPicks(team.id) : [])) {
    if (seen.has(name)) continue;
    const ci = (typeof getLeagueContractByName === "function") ? getLeagueContractByName(name, season) : null;
    if (ci) push(name, { kind: ci.kind, contract: ci.contract, cost: ci.cost, costMissing: ci.costMissing });
    else { const rawCost = getCurrentKeeperSalary(name); push(name, { kind: "fa", contract: null, cost: rawCost == null ? 0 : rawCost, costMissing: rawCost == null }); }
  }

  return rows;   // Value + sorting happen in renderKeepers once inflation is known.
}

// Eligible keepers first; expired/ineligible sink to the bottom. Within each
// group, sort by Value (inflation-adjusted surplus), nulls last.
function _sortKeeperRows(rows) {
  rows.sort((a, b) => {
    const ae = a.eligible ? 0 : 1, be = b.eligible ? 0 : 1;
    if (ae !== be) return ae - be;
    if (a.value == null && b.value == null) return a.name.localeCompare(b.name);
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return b.value - a.value;
  });
  return rows;
}

function renderKeepers() {
  const root = document.getElementById("view-root");
  // Auto-load rosters (ESPN membership + League App contracts) once on first view.
  if (!_keepersState.autoLoaded && !_keepersState.loadingRosters) {
    _keepersState.autoLoaded = true;
    _loadKeeperRosters(false);
  }
  const sources = _keeperSources();
  const source = _currentKeeperSource(sources);
  const meta = getProjectionMeta();
  const hasAnyProj = sources.length > 0;

  // Team order: me first, then others alphabetically.
  const me = LEAGUE.teams.find(t => t.isMe);
  const others = LEAGUE.teams.filter(t => !t.isMe).slice().sort((a, b) => a.owner.localeCompare(b.owner));
  const order = me ? [me, ...others] : others;

  // Pass 1: build each team's rows; sum eligible checked picks for inflation.
  const teamRows = new Map();
  let keptCost = 0, keptValue = 0;
  for (const t of order) {
    const rows = _teamCandidates(t, source);
    teamRows.set(t.id, rows);
    for (const r of rows) if (r.myPicked && r.eligible) { keptCost += r.cost; keptValue += (r.predValue || 0); }
  }
  // Inflation: manual override if set, else auto from the selected $ pool
  // (exactly 1.00 with no keepers; rises as bargains are kept).
  const inflOverride = _keeperInflationOverride();
  const inflation = inflOverride != null ? inflOverride : _poolInflation(source, keptCost, keptValue);
  // Pass 2: assign Value = Pred $ − (Cost ÷ Inflation), then sort (expired last).
  for (const t of order) {
    const rows = teamRows.get(t.id);
    for (const r of rows) r.value = r.predValue != null ? r.predValue - r.cost / inflation : null;
    _sortKeeperRows(rows);
  }

  // === Controls ===
  let html = '<div class="card"><h2>Keepers by Team</h2>';
  html += '<p class="muted small"><b>Surplus</b> = Predicted $ − Cost. <b>Value</b> = Predicted $ − (Cost ÷ Inflation) — so Value = Surplus only while Inflation is 1.00, and exceeds it as you check keepers. Expired players sink to the bottom and can’t be checked. <b>Minor-leaguers</b> are valued at their projected ROS/next-year $ when the projection source covers them (else “no proj”); since their cost is $0, that projected $ is their full surplus. <b>Cost is editable</b> — type over any figure to override The League App; it sticks until you change it (↺ resets).</p>';
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

  // Inflation (effective value shown; editing sets a manual override)
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">Inflation ' +
    '<input id="kp-infl" type="number" step="0.05" min="1" max="3" value="' + inflation.toFixed(2) + '" style="width:80px;">' +
    '<span class="dim" style="font-size:11px;">' + (inflOverride != null ? '<a href="#" id="kp-infl-auto">auto</a>' : 'auto') + '</span></label>';

  // Refresh both sources.
  html += '<button class="btn" id="kp-load" style="width:auto; padding:6px 12px;">' +
    (_keepersState.loadingRosters ? "Refreshing…" : "Refresh rosters") + '</button>';

  // Only-keepers filter
  html += '<label class="small muted" style="display:inline-flex; align-items:center; gap:6px;">' +
    '<input type="checkbox" id="kp-only"' + (_keepersState.onlyKeepers ? " checked" : "") + '> Only keepers</label>';
  html += '</div>';

  html += '<p class="small muted" style="margin-top:6px;">Who’s on each team comes from your <b>live ESPN roster</b>; keeper years &amp; cost are overlaid from <b>The League App</b>. Minor-league stashes come from The League App. Inflation starts at <b>1.00</b> and rises only as you check players.</p>';

  // Status: ESPN membership + League App contracts.
  const rosterData = (typeof getLeagueRosterData === "function") ? getLeagueRosterData() : null;
  const espn = _keepersState.rosters;
  const proxySet = (typeof getProxyUrl === "function") && getProxyUrl();
  const statusBits = [];
  if (espn) {
    const teamCt = Object.values(espn).filter(a => a && a.length).length;
    const playerCt = Object.values(espn).reduce((s, a) => s + (a ? a.length : 0), 0);
    const rm = _keepersState.rosterMeta || {};
    const unmapped = (rm.unmappedIds && rm.unmappedIds.length) ? rm.unmappedIds.join(", ") : "";
    statusBits.push('ESPN: ' + teamCt + '/' + LEAGUE.teams.length + ' teams, ' + playerCt + ' players' +
      (unmapped ? ' <b style="color:var(--bad);">unmapped ids: ' + esc(unmapped) + '</b>' : ''));
  } else if (_keepersState.espnError) {
    statusBits.push('<span style="color:var(--warn);">ESPN: ' + esc(_keepersState.espnError) + ' (using League App roster anchor)</span>');
  } else if (!proxySet) {
    statusBits.push('<span style="color:var(--warn);">ESPN: no proxy set (Settings) — using League App roster anchor, which can be stale for majors</span>');
  } else if (_keepersState.loadingRosters) {
    statusBits.push('ESPN: loading…');
  }
  if (rosterData) {
    const at = (typeof getLeagueRostersUpdatedAt === "function") ? getLeagueRostersUpdatedAt() : null;
    statusBits.push('League App contracts: season ' + rosterData.season + (at ? ', synced ' + new Date(at).toLocaleString() : ''));
  } else if (_keepersState.leagueError) {
    statusBits.push('<span style="color:var(--bad);">League App: ' + esc(_keepersState.leagueError) + '</span>');
  }
  if (statusBits.length) html += '<p class="small muted" style="margin-top:6px;">' + statusBits.join(' · ') + '</p>';

  if (source && source !== "preseason" && !rosHasDollars(source)) {
    html += '<p class="small" style="color:var(--warn); margin-top:6px;">This ROS source has no projected $ — Predicted $ falls back to preseason values. Import a FanGraphs export with a Dollars column (Data tab) for ROS pricing.</p>';
  }
  if (!hasAnyProj) {
    html += '<p class="small muted" style="margin-top:6px;">No projections loaded — import on the Data tab to see Predicted $ and Value.</p>';
  }
  html += '</div>';

  // === Per-team boards ===
  const rostersLoaded = !!(espn || rosterData);
  for (const t of order) {
    let rows = teamRows.get(t.id) || [];
    const ldTeam = rosterData ? rosterData.teams.find(x => x.id === t.id) : null;
    const espnCount = (espn && espn[t.id]) ? espn[t.id].length : 0;
    const milCount = ldTeam ? (ldTeam.minors || []).length : 0;
    const rosterCount = espn ? (espnCount + milCount) : (ldTeam ? ((ldTeam.majors||[]).length + (ldTeam.callups||[]).length + milCount) : 0);
    if (_keepersState.onlyKeepers) {
      rows = rows.filter(r => r.myPicked || (r.leagueSel && (r.leagueSel.keeper || r.leagueSel.minorKeeper)));
    }
    // When rosters are loaded, always render every team (so a team that came
    // back empty is visible, not silently dropped). Otherwise skip empty teams.
    if (!rows.length && !rostersLoaded) continue;

    const picks = rows.filter(r => r.myPicked && r.eligible);
    const mlPicks = picks.filter(r => !r.isMinor);
    const milPicks = picks.filter(r => r.isMinor);
    const totalCost = mlPicks.reduce((s, r) => s + r.cost, 0);
    const totalSurplus = picks.reduce((s, r) => s + (r.surplus || 0), 0);
    const totalValue = picks.reduce((s, r) => s + (r.value || 0), 0);

    html += '<div class="card"' + (t.isMe ? ' style="border-color: rgba(79,142,247,.4);"' : '') + '>';
    html += '<h2>' + esc(t.owner) +
      (rostersLoaded ? ' <span class="muted small">· ' + rosterCount + ' rostered</span>' : '') + '</h2>';
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
      const expired = !r.eligible;            // expired contract or manually ineligible
      let cls = (r.myPicked && r.eligible) ? (r.isMinor ? "minor-kept" : "kept") : "";
      html += '<tr class="' + cls + '"' + (expired ? ' style="opacity:.6;"' : '') + '>';

      // My-keeper checkbox — disabled for expired/ineligible players (can't keep).
      // (Stays enabled if somehow already checked, so a stale pick can be cleared.)
      const disable = expired && !r.myPicked;
      html += '<td class="num"><input type="checkbox" class="kp-check" data-team="' + tid + '" data-player="' + pn + '"' +
        (r.myPicked ? " checked" : "") + (disable ? ' disabled title="Expired — can\'t be kept"' : '') + '></td>';

      // Player (+ roster-kind badge)
      const kindBadge = r.kind === "minor" ? ' <span class="kbd" style="color:var(--minor);" title="Minor leaguer">MiL</span>'
        : r.kind === "callup" ? ' <span class="kbd" style="color:var(--minor);" title="Called up from minors">CU</span>' : '';
      html += '<td>' + esc(r.name) + kindBadge + '</td>';

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

      // Cost — editable (minors are fixed at $0 by rule). A manual edit sticks
      // until re-edited; ↺ resets to the League App cost.
      if (r.isMinor) {
        html += '<td class="num"><span class="dim">$0</span></td>';
      } else {
        // The $ + input stay put; the trailing ↺/? lives in a fixed-width slot
        // to its right that's always reserved, so editing never shifts the number.
        const trailing = r.costOverridden
          ? '<a href="#" class="kp-cost-reset" data-team="' + tid + '" data-player="' + pn + '" title="Reset to League App cost" style="text-decoration:none;">↺</a>'
          : (r.costMissing ? '<span class="dim" title="No draft record — assumed">?</span>' : '');
        html += '<td class="num"><span style="display:inline-flex; align-items:center; justify-content:flex-end; white-space:nowrap;">' +
          '<span>$<input type="number" class="kp-cost" data-team="' + tid + '" data-player="' + pn + '" value="' + r.cost + '" min="0" step="1" ' +
          'title="' + (r.costOverridden ? 'Manual cost — overrides The League App' : 'Edit keeper cost (sticks until changed)') + '" ' +
          'style="width:42px; padding:1px 3px; text-align:right; background:transparent; border:1px solid var(--border); border-radius:3px; color:' +
          (r.costOverridden ? 'var(--accent);font-weight:600' : 'inherit') + ';"></span>' +
          '<span style="display:inline-block; width:16px; margin-left:3px; text-align:center; font-size:11px;">' + trailing + '</span>' +
          '</span></td>';
      }

      // Predicted $ — projected ROS/next-year auction value. Minors that the
      // projection source doesn't cover yet read "no proj" (dim) rather than —.
      html += '<td class="num">' + (r.predValue != null
        ? '$' + r.predValue.toFixed(0)
        : (r.isMinor || r.kind === "callup"
            ? '<span class="dim" title="No projection for this prospect in the selected source yet">no proj</span>'
            : '<span class="dim">—</span>')) + '</td>';

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

  if (!rostersLoaded && !order.some(t => (teamRows.get(t.id) || []).length)) {
    html += '<div class="empty"><p>Loading rosters from The League App…</p><p class="small">If this persists, click “Refresh rosters”.</p></div>';
  }


  root.innerHTML = html;

  // Keep the topbar inflation badge in sync (same value used on every tab).
  updateInflationBadge();

  _wireKeepers();
}

// Eligibility cell: contract status badge + a manual "ineligible" toggle for
// cases (post-deadline FA adds) we can't infer from history.
function _eligibilityCell(teamId, r) {
  const tid = esc(teamId), pn = esc(r.name);
  let out = "";
  if (r.myIneligible) {
    out += '<span class="kbd" style="color:var(--bad);" title="Manually marked ineligible">INELIGIBLE</span> ';
  } else if (r.contract) {
    const c = r.contract;
    const color = c.status === "final" ? "var(--bad)" : c.status === "expiring" ? "var(--warn)" : "var(--good)";
    out += '<span class="kbd" style="color:' + color + ';">' + esc(c.label) + '</span> ';
  } else {
    out += '<span class="kbd dim" title="No contract on file — likely a FA pickup (keepable at $6 the first year)">FA / unknown</span> ';
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
  // Editable keeper cost — save on change (blur/Enter) and re-render so Surplus,
  // Value, and inflation pick up the new number.
  document.querySelectorAll(".kp-cost").forEach(el => {
    el.addEventListener("change", () => {
      const raw = el.value.trim();
      const n = parseFloat(raw);
      setMyKeeperCost(el.dataset.team, el.dataset.player, raw === "" || !isFinite(n) ? null : n);
      renderKeepers();
    });
    // Enter commits (and blurs) without submitting anything.
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
  });
  document.querySelectorAll(".kp-cost-reset").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      setMyKeeperCost(el.dataset.team, el.dataset.player, null);
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
  const inflAuto = document.getElementById("kp-infl-auto");
  if (inflAuto) inflAuto.addEventListener("click", (e) => {
    e.preventDefault();
    _keepersState.inflation = null; localStorage.removeItem(KEEPER_INFLATION_KEY);
    renderKeepers();
  });
  const only = document.getElementById("kp-only");
  if (only) only.addEventListener("change", () => { _keepersState.onlyKeepers = only.checked; renderKeepers(); });
  const load = document.getElementById("kp-load");
  if (load) load.addEventListener("click", () => _loadKeeperRosters(true));
}

async function _loadKeeperRosters(force) {
  if (_keepersState.loadingRosters) return;
  _keepersState.loadingRosters = true;
  _keepersState.leagueError = null;
  _keepersState.espnError = null;
  if (force) renderKeepers();   // show "Refreshing…" only on explicit refresh
  const tasks = [];
  // Contracts from The League App.
  if (typeof loadLeagueRosters === "function") {
    tasks.push(loadLeagueRosters(!!force).catch(e => { _keepersState.leagueError = e.message || String(e); }));
  }
  // Membership from live ESPN (only if a proxy is configured).
  if (typeof fetchEspnRosters === "function" && typeof getProxyUrl === "function" && getProxyUrl()) {
    tasks.push(fetchEspnRosters(0)
      .then(res => {
        _keepersState.rosters = res.rosters || {};
        _keepersState.rosterMeta = { rawTeamCount: res.rawTeamCount, unmappedIds: res.unmappedIds || [] };
      })
      .catch(e => { _keepersState.espnError = e.message || String(e); }));
  }
  try { await Promise.all(tasks); }
  finally { _keepersState.loadingRosters = false; renderKeepers(); }
}
