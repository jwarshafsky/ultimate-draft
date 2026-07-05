// Per-team draft-budget adjustments. The traded-draft-dollars Google Sheet is
// the default source (draft-dollars.js); a manual override entered on the
// Draft Setup screen REPLACES the sheet value for that team — draft-day
// insurance for a stale sheet, and how mock/test budgets get shaped.
// Stored in ud_budget_adj_v1 (synced).

const BUDGET_ADJ_KEY = "ud_budget_adj_v1";
let _budgetAdj = null;   // { teamId: number }

function _baLoad() {
  if (_budgetAdj) return _budgetAdj;
  try { _budgetAdj = JSON.parse(localStorage.getItem(BUDGET_ADJ_KEY) || "{}") || {}; }
  catch (e) { _budgetAdj = {}; }
  return _budgetAdj;
}

function getManualBudgetAdjustment(teamId) {
  const v = _baLoad()[teamId];
  return (typeof v === "number" && isFinite(v)) ? v : null;
}

function setManualBudgetAdjustment(teamId, value) {
  const map = _baLoad();
  const n = parseFloat(value);
  if (value === "" || value == null || !isFinite(n)) delete map[teamId];
  else map[teamId] = Math.round(n);
  try { localStorage.setItem(BUDGET_ADJ_KEY, JSON.stringify(map)); } catch (e) {}
}

// Replace the whole override map (used when loading a saved draft config).
function replaceBudgetAdjustments(map) {
  _budgetAdj = (map && typeof map === "object") ? { ...map } : {};
  try { localStorage.setItem(BUDGET_ADJ_KEY, JSON.stringify(_budgetAdj)); } catch (e) {}
}

// Effective adjustment for budget math everywhere: manual override if set,
// else the traded-draft-dollars sheet value.
function getBudgetAdjustment(teamId) {
  const manual = getManualBudgetAdjustment(teamId);
  if (manual != null) return manual;
  return (typeof getDraftDollarAdjustment === "function") ? getDraftDollarAdjustment(teamId) : 0;
}
