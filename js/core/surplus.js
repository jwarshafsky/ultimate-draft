// Multi-year keeper surplus projector — used by the keeper analyzer and the
// trade analyzer. Given a player's current salary and contract year,
// projects Year-by-Year surplus accounting for:
//   - $2/year escalator
//   - $40 / $50 max-keeper-year caps
//   - Aging curves (rough 1%/yr decline after age 30 for hitters)
//   - Confidence-decay on future projections

// Returns the salary in year N (year 1 = next season, ie. the one we're about
// to draft). Adds $2 per additional keeper year.
function projectedSalary(baseSalary, yearN) {
  return baseSalary + 2 * (yearN - 1);
}

// Returns max keeper years remaining based on draft price tier.
//   Drafted >$50: 1 additional keeper year (yearN max = 1)
//   Drafted >$40: 2 additional keeper years
//   Otherwise:    3 additional keeper years (the standard cap from constitution)
// Note: this is "additional" beyond current year. So a $45 player you just
// drafted can be kept Year 2 and Year 3, but not Year 4.
function maxKeeperYears(originalDraftPrice) {
  if (originalDraftPrice >= 51) return 1;
  if (originalDraftPrice >= 41) return 2;
  return 3;
}

// Decay future projected value by age (rough). Assumes player age available;
// if not, applies a flat 3% decay per year as a placeholder.
function decayValue(currentValue, yearN, age) {
  if (yearN === 1) return currentValue;
  let mult = 1;
  for (let y = 2; y <= yearN; y++) {
    if (age && age >= 30) mult *= 0.96;       // decline phase
    else if (age && age >= 27) mult *= 0.99;  // plateau
    else if (age && age >= 24) mult *= 1.01;  // pre-peak growth
    else if (age && age < 24)  mult *= 1.03;  // young upside
    else mult *= 0.97;                        // unknown age — small decay
  }
  return currentValue * mult;
}

// Surplus trajectory. yearsAhead = 3 by default; returns array of years.
function surplusTrajectory(opts) {
  const {
    playerValue,         // current projected $ value
    salary,              // year 1 salary
    originalDraftPrice,  // for keeper-year cap calc
    age,                 // optional, for aging curve
    yearsAhead = 3,
  } = opts;

  const maxYears = maxKeeperYears(originalDraftPrice || salary);
  const out = [];
  for (let y = 1; y <= yearsAhead; y++) {
    const eligible = y <= maxYears;
    const projSalary = projectedSalary(salary, y);
    const projValue = decayValue(playerValue, y, age);
    out.push({
      year: y,
      salary: projSalary,
      value: projValue,
      surplus: projValue - projSalary,
      keeperEligible: eligible,
      isKeepable: eligible && projValue - projSalary >= 0,
    });
  }
  return out;
}

// Returns a single "lifetime surplus" number summing eligible years where
// surplus is positive. Useful for ranking keeper candidates.
function lifetimeSurplus(opts) {
  return surplusTrajectory(opts)
    .filter(y => y.keeperEligible && y.surplus > 0)
    .reduce((s, y) => s + y.surplus, 0);
}
