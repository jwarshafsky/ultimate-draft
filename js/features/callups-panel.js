// Call-ups panel — shows every tracked minor leaguer (from The League App
// rosters + Jeff's predicted MiL keepers) with his stashed/called-up status and
// a manual override. Rendered at the bottom of the Keepers tab (pre-draft home)
// and inside Live Draft (collapsed) so draft-day flips are one click away.
//
// Draft impact of the status (see js/data/callups.js):
//   stashed → excluded from the auction pool AND from projected ML rosters
//   up      → occupies an ML roster slot at his call-up cost

function renderCallupsPanel(opts) {
  const collapsed = !!(opts && opts.collapsed);
  if (typeof listMinorLeaguers !== "function") return "";
  const rows = listMinorLeaguers();
  const upCount = rows.filter(r => r.status === "up").length;
  const summary = rows.length + " minor leaguer" + (rows.length === 1 ? "" : "s") + " tracked · " +
    upCount + " called up · " + (rows.length - upCount) + " stashed (off the auction board)";

  let body = '';
  if (!rows.length) {
    body = '<p class="muted small">No minor leaguers found yet — they come from The League App rosters (Refresh rosters on the Keepers tab) and your predicted MiL keepers.</p>';
  } else {
    // Group by team, my team first, then by owner name.
    const byTeam = new Map();
    for (const r of rows) {
      const key = r.teamId || "?";
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key).push(r);
    }
    const teamName = (id) => (typeof getTeam === "function" && getTeam(id)?.owner) || (id === "?" ? "Unassigned" : id);
    const myId = (typeof getMyTeam === "function") ? getMyTeam()?.id : null;
    const order = [...byTeam.keys()].sort((a, b) => (a === myId ? -1 : b === myId ? 1 : String(teamName(a)).localeCompare(String(teamName(b)))));

    body = '<div class="grid cols-3" style="align-items:start;">';
    for (const tid of order) {
      const list = byTeam.get(tid).slice().sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "up" ? -1 : 1));
      body += '<div class="card" style="padding:8px 10px;">';
      body += '<b class="small">' + esc(String(teamName(tid))) + '</b> <span class="muted small">(' + list.length + ')</span>';
      body += '<table style="font-size:11px; margin-top:4px;"><tbody>';
      for (const r of list) {
        const up = r.status === "up";
        body += '<tr>';
        body += '<td>' + esc(r.name) + (r.source === "predicted" ? ' <span class="dim" title="from your predicted MiL keepers">◦</span>' : '') + '</td>';
        body += '<td class="num">' + (up
          ? '<span style="color:var(--good);">▲ up</span>'
          : '<span class="muted">▽ stash</span>') + '</td>';
        body += '<td style="white-space:nowrap;">';
        body += '<button class="btn ghost cu-toggle" data-name="' + esc(r.name) + '" data-to="' + (up ? "stashed" : "up") + '" style="padding:0 6px; font-size:10px;" title="' + (up ? "Send down (stash)" : "Call up to ML roster") + '">' + (up ? "▽" : "▲") + '</button>';
        if (r.override) body += '<button class="btn ghost cu-auto" data-name="' + esc(r.name) + '" style="padding:0 6px; font-size:10px;" title="Clear manual override (back to League App data)">↺</button>';
        body += '</td>';
        body += '</tr>';
      }
      body += '</tbody></table></div>';
    }
    body += '</div>';
    body += '<p class="muted small" style="margin:6px 0 0;">▲/▽ toggles call-up status (manual override, synced across devices) · ↺ reverts to The League App data · ◦ = from your predicted MiL keepers. Stashed players are off the auction board and off projected ML rosters.</p>';
  }

  let html = '<div class="card">';
  if (collapsed) {
    html += '<details><summary style="cursor:pointer;"><b>Call-ups & minor-league stashes</b> <span class="muted small">' + summary + '</span></summary>';
    html += '<div style="margin-top:8px;">' + body + '</div></details>';
  } else {
    html += '<h2>Call-ups & minor-league stashes</h2>';
    html += '<p class="muted small" style="margin:0 0 8px;">' + summary + '</p>';
    html += body;
  }
  html += '</div>';
  return html;
}

function wireCallupsPanel(rerenderFn) {
  document.querySelectorAll(".cu-toggle").forEach(b => b.addEventListener("click", () => {
    setCallupStatusOverride(b.dataset.name, b.dataset.to);
    if (typeof rerenderFn === "function") rerenderFn();
  }));
  document.querySelectorAll(".cu-auto").forEach(b => b.addEventListener("click", () => {
    setCallupStatusOverride(b.dataset.name, "auto");
    if (typeof rerenderFn === "function") rerenderFn();
  }));
}
