// Player comparison tool. Pin 2-3 players side-by-side and compare:
// projections, value (raw + inflated), NFBC range, xStats, surplus trajectory,
// keeper years remaining, notes/tags.

const _compare = {
  players: [],  // [name, name, ...]
};

function addToCompare(name) {
  if (_compare.players.includes(name)) return;
  if (_compare.players.length >= 3) {
    _compare.players.shift();
  }
  _compare.players.push(name);
  if (typeof rerender === "function") rerender();
}

function removeFromCompare(name) {
  _compare.players = _compare.players.filter(p => p !== name);
  if (typeof rerender === "function") rerender();
}

function clearCompare() {
  _compare.players = [];
  if (typeof rerender === "function") rerender();
}

function renderCompare() {
  const root = document.getElementById("view-root");
  let html = '';

  // Picker
  html += '<div class="card"><h2>Player Comparison</h2>';
  html += '<p class="muted small">Pin up to 3 players side-by-side — search a name to add.</p>';
  html += '<div style="display: flex; gap: 8px; align-items: center;">';
  html += '<input id="cmp-search" placeholder="Search player to add..." style="flex: 1;" list="cmp-options">';
  html += '<datalist id="cmp-options">';
  for (const p of getValues().slice(0, 400)) {
    html += '<option value="' + esc(p.name) + '">';
  }
  html += '</datalist>';
  html += '<button class="btn primary" id="cmp-add" style="width: auto; padding: 8px 14px;">Add</button>';
  if (_compare.players.length) {
    html += '<button class="btn ghost danger" id="cmp-clear">Clear all</button>';
  }
  html += '</div>';
  if (_compare.players.length) {
    html += '<div class="small muted" style="margin-top: 8px;">Pinned: ' + _compare.players.map(esc).join(", ") + '</div>';
  }
  html += '</div>';

  if (!_compare.players.length) {
    html += '<div class="empty"><p>No players pinned yet.</p></div>';
    root.innerHTML = html;
    wireCompareHandlers();
    return;
  }

  // Side-by-side comparison
  html += '<div class="card"><h2>Side-by-Side</h2>';
  html += '<table><thead><tr><th>Metric</th>';
  for (const name of _compare.players) {
    html += '<th>' + esc(name) + ' <button class="btn ghost cmp-remove" data-name="' + esc(name) + '" style="padding: 0 6px; font-size: 11px; margin-left: 4px;">×</button></th>';
  }
  html += '</tr></thead><tbody>';

  const players = _compare.players.map(n => ({
    name: n,
    value: getPlayerValue(n),
    proj: getProjection(n),
    nfbc: getNfbc(n),
    sc: getStatcast(n),
    note: getPlayerNote(n),
  }));

  const rows = [
    { label: "Position", get: p => p.value?.posKey || p.proj?.pos || "—" },
    { label: "Team", get: p => p.value?.team || p.proj?.team || "—" },
    { label: "Projected $", get: p => p.value ? '$' + p.value.value.toFixed(0) : "—" },
    { label: "NFBC avg $", get: p => p.nfbc?.avg ? '$' + p.nfbc.avg.toFixed(0) : "—" },
    { label: "NFBC range", get: p => p.nfbc?.min && p.nfbc?.max ? '$' + p.nfbc.min + '-$' + p.nfbc.max : "—" },
    { label: "NFBC ADP", get: p => p.nfbc?.adp ? p.nfbc.adp.toFixed(1) : "—" },
    { label: "PA / IP", get: p => p.proj?.PA || p.proj?.IP || "—" },
    { label: "R / QS", get: p => p.proj?.R != null ? p.proj.R : (p.proj?.QS != null ? p.proj.QS : "—") },
    { label: "HR / K", get: p => p.proj?.HR != null ? p.proj.HR : (p.proj?.K != null ? p.proj.K : "—") },
    { label: "RBI / SV+HLD", get: p => p.proj?.RBI != null ? p.proj.RBI : (p.proj ? ((p.proj.SV || 0) + (p.proj.HLD || 0)) : "—") },
    { label: "SB / ERA", get: p => p.proj?.SB != null ? p.proj.SB : (p.proj?.ERA != null ? p.proj.ERA.toFixed(2) : "—") },
    { label: "OBP / WHIP", get: p => p.proj?.OBP ? p.proj.OBP.toFixed(3) : (p.proj?.WHIP ? p.proj.WHIP.toFixed(2) : "—") },
    { label: "xwOBA / xERA", get: p => p.sc?.xwOBA ? p.sc.xwOBA.toFixed(3) : (p.sc?.xERA ? p.sc.xERA.toFixed(2) : "—") },
    { label: "Hard Hit %", get: p => p.sc?.hardHit ? p.sc.hardHit.toFixed(1) + "%" : "—" },
    { label: "Barrel %", get: p => p.sc?.barrel ? p.sc.barrel.toFixed(1) + "%" : "—" },
    { label: "Buy/Sell signal", get: p => {
        const s = statcastBuySell(p.name);
        if (!s) return "—";
        return '<span class="' + (s.signal === "buy" ? "good" : "bad") + '">' + (s.signal === "buy" ? "↑ BUY" : "↓ SELL") + '</span>';
      }
    },
    { label: "Tags", get: p => (p.note.tags || []).map(t => '<span style="font-size: 11px; margin-right: 4px;">' + esc(t) + '</span>').join("") || "—" },
    { label: "Notes", get: p => p.note.note ? '<span class="small">' + esc(p.note.note) + '</span>' : "—" },
  ];

  // Multi-year surplus trajectory rows (1 row per year)
  const years = [1, 2, 3];
  for (const y of years) {
    rows.push({
      label: "Yr " + y + " value",
      get: p => {
        if (!p.value) return "—";
        const t = surplusTrajectory({ playerValue: p.value.value, salary: 0, originalDraftPrice: 0, yearsAhead: y });
        const row = t[y - 1];
        return row ? '$' + row.value.toFixed(0) : "—";
      }
    });
  }

  for (const r of rows) {
    html += '<tr><td><strong>' + esc(r.label) + '</strong></td>';
    for (const p of players) {
      html += '<td>' + r.get(p) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  root.innerHTML = html;
  wireCompareHandlers();
}

function wireCompareHandlers() {
  document.getElementById("cmp-add")?.addEventListener("click", () => {
    const name = document.getElementById("cmp-search").value.trim();
    if (name) {
      addToCompare(name);
      document.getElementById("cmp-search").value = "";
    }
  });
  document.getElementById("cmp-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("cmp-add").click();
  });
  document.getElementById("cmp-clear")?.addEventListener("click", () => clearCompare());
  document.querySelectorAll(".cmp-remove").forEach(b => {
    b.addEventListener("click", () => removeFromCompare(b.dataset.name));
  });
}
