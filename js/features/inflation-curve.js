// Inflation curve graph — track inflation snapshots over time as picks come
// in. Helpful to see whether the room is overpaying (deflating future picks)
// or underpaying (inflating future picks).

const _inflationLog = {
  snapshots: [], // [{ pick, multiplier, ts }]
};

function recordInflationSnapshot() {
  const inf = computeLiveInflation();
  if (!inf) return;
  _inflationLog.snapshots.push({
    pick: _liveDraft.picks.length,
    multiplier: inf.multiplier,
    ts: Date.now(),
  });
  // Keep last 200
  if (_inflationLog.snapshots.length > 200) _inflationLog.snapshots.shift();
}

// Render a simple SVG line chart of inflation over time.
function renderInflationCurve() {
  const snaps = _inflationLog.snapshots;
  // Need at least 2 points to draw a line
  if (snaps.length < 2) {
    return '<div class="card"><h3>Inflation Over Time</h3><p class="muted small">Curve renders after a few picks. Each pick adds a snapshot.</p></div>';
  }
  const w = 600, h = 110, padL = 40, padR = 16, padT = 12, padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxX = snaps[snaps.length - 1].pick;
  const minX = snaps[0].pick;
  const vals = snaps.map(s => s.multiplier);
  const maxY = Math.max(1.3, Math.max(...vals) + 0.05);
  const minY = Math.min(0.85, Math.min(...vals) - 0.05);
  const xScale = (x) => padL + ((x - minX) / Math.max(1, maxX - minX)) * innerW;
  const yScale = (y) => padT + (1 - (y - minY) / (maxY - minY)) * innerH;

  // Build path
  let d = "";
  for (let i = 0; i < snaps.length; i++) {
    const x = xScale(snaps[i].pick);
    const y = yScale(snaps[i].multiplier);
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  }
  // 1.0x reference line
  const refY = yScale(1.0);

  // Y-axis ticks
  const yTicks = [];
  for (let v = Math.ceil(minY * 10) / 10; v <= maxY; v += 0.1) {
    yTicks.push(v);
  }
  let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="background: var(--bg-3); border-radius: 6px;">`;
  // Grid
  for (const t of yTicks) {
    const y = yScale(t);
    svg += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
    svg += `<text x="${padL - 4}" y="${y + 3}" font-size="9" text-anchor="end" fill="var(--text-3)">${t.toFixed(1)}x</text>`;
  }
  // 1.0 line
  svg += `<line x1="${padL}" y1="${refY}" x2="${w - padR}" y2="${refY}" stroke="var(--text-2)" stroke-dasharray="3 3" stroke-width="0.8"/>`;
  svg += `<text x="${w - padR - 2}" y="${refY - 3}" font-size="9" text-anchor="end" fill="var(--text-2)">1.0x (neutral)</text>`;
  // Curve
  svg += `<path d="${d}" stroke="var(--accent)" stroke-width="1.5" fill="none"/>`;
  // Most recent point
  const last = snaps[snaps.length - 1];
  svg += `<circle cx="${xScale(last.pick).toFixed(1)}" cy="${yScale(last.multiplier).toFixed(1)}" r="3" fill="var(--accent)"/>`;
  // X-axis label
  svg += `<text x="${w / 2}" y="${h - 6}" font-size="10" text-anchor="middle" fill="var(--text-3)">Picks made</text>`;
  svg += '</svg>';

  // Trend label
  const recent = snaps.slice(-10);
  const trend = recent.length >= 2 ? (recent[recent.length - 1].multiplier - recent[0].multiplier) : 0;
  const trendLabel = Math.abs(trend) < 0.02 ? "stable" : trend > 0 ? "↑ rising (room underpaying)" : "↓ falling (room overpaying)";
  const trendClass = Math.abs(trend) < 0.02 ? "muted" : trend > 0 ? "good" : "bad";

  return '<div class="card"><h3>Inflation Over Time <span class="' + trendClass + ' small">· ' + trendLabel + '</span></h3>' + svg + '</div>';
}

function clearInflationCurve() {
  _inflationLog.snapshots = [];
}
