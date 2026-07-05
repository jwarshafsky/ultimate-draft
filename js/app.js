// Ultimate Draft — top-level shell. Wires auth, view routing, and data load.

let currentView = "overview";

const VIEWS = {
  overview:  { render: () => renderOverview() },
  standings: { render: () => renderStandings() },
  keepers:   { render: () => renderKeepers() },
  values:    { render: () => renderValues() },
  hotfa:     { render: () => renderHotFa() },
  board:     { render: () => renderBoard() },
  compare:   { render: () => renderCompare() },
  trade:     { render: () => renderTrade() },
  scenarios: { render: () => renderScenarios() },
  mock:      { render: () => renderMock() },
  draft:     { render: () => renderDraft() },
  roster:    { render: () => renderRoster() },
  history:   { render: () => renderHistory() },
  data:      { render: () => renderData() },
  settings:  { render: () => renderSettings() },
};

function switchView(name) {
  // Leaving the draft tab: drop fullscreen chrome + the manual-entry flag so
  // a later return lands on the setup lobby, not a half-hidden shell.
  if (name !== "draft") {
    document.body.classList.remove("draft-mode");
    if (typeof _liveDraft !== "undefined") _liveDraft.manualView = false;
  }
  if (!VIEWS[name]) name = "overview";
  currentView = name;
  // Keep the tab in the URL so a reload lands where you were.
  if (("#" + name) !== location.hash) history.replaceState(null, "", "#" + name);
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.view === name);
  });
  const root = document.getElementById("view-root");
  root.innerHTML = '<div class="loading">Loading…</div>';
  try {
    VIEWS[name].render();
  } catch (e) {
    console.error(e);
    root.innerHTML = '<div class="empty"><p>View error:</p><p class="small">' + (e.message || e) + '</p></div>';
  }
}

// Coalesce data-driven rerenders through one animation frame so the startup
// loaders (league data, projections, draft dollars) don't each rebuild the view.
let _rerenderQueued = false;
function rerender() {
  if (!dataReady()) return;
  if (_rerenderQueued) return;
  _rerenderQueued = true;
  requestAnimationFrame(() => {
    _rerenderQueued = false;
    // Don't clobber an in-progress edit ANYWHERE — a background realtime
    // event mid-keystroke (Data-tab paste, Draft Setup strategy text, league
    // URL, budget cells, Draft Mode search) must not rebuild the view and eat
    // the user's typing.
    const ae = document.activeElement;
    if (ae && ae.closest("#view-root") &&
        (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.tagName === "SELECT")) return;
    switchView(currentView);
  });
}

function initApp() {
  // Auth UI
  document.getElementById("auth-google").addEventListener("click", signInGoogle);
  document.getElementById("auth-magic").addEventListener("click", () => {
    const email = document.getElementById("auth-email").value;
    sendMagicLink(email);
  });
  document.getElementById("auth-email").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("auth-magic").click();
  });
  document.getElementById("sign-out").addEventListener("click", signOut);
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => switchView(t.dataset.view));
  });

  // Auth-driven shell visibility
  onAuthChange((user) => {
    const gate = document.getElementById("auth-gate");
    const app = document.getElementById("app");
    if (user) {
      gate.hidden = true;
      app.hidden = false;
      const sub = document.getElementById("brand-sub");
      sub.textContent = "· " + (user.email.split("@")[0]);
      // Land on the tab from the URL hash (survives reloads).
      const hashView = (location.hash || "").slice(1);
      if (VIEWS[hashView]) currentView = hashView;
      // Kick off data load and realtime subscriptions.
      loadLeagueData();
      subscribeRealtime();
    } else {
      gate.hidden = false;
      app.hidden = true;
      unsubscribeRealtime();
    }
  });

  // Re-render when league data updates
  onDataChange(() => rerender());

  // Also rerender when projections load
  if (typeof onProjectionsChange === "function") {
    onProjectionsChange(() => rerender());
  }

  // Auto-populate live ROS projections (hosted, auto-refreshed) as the default,
  // unless the user has manually overridden a source. Same-origin, no auth.
  if (typeof autoloadHostedRos === "function") {
    autoloadHostedRos().then((changed) => { if (changed) rerender(); }).catch(() => {
      setStatus("projections", "live autoload failed", "warn");
    });
  }

  // Pull traded draft-dollar adjustments from the published sheet.
  if (typeof loadDraftDollars === "function") {
    loadDraftDollars().then(() => rerender()).catch(() => {
      console.warn("draft-dollar sheet load failed");
    });
  }
}

document.addEventListener("DOMContentLoaded", initApp);
