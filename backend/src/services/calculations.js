// All calculation logic lives here so it's tested once and reused everywhere.

// Returns the current hour (0-23) in India Standard Time (UTC+5:30), regardless
// of what timezone the server itself is running in. Used for all time-slot bias logic.
function getIstHour(now = new Date()) {
  const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
  // toLocaleString can return "24" for midnight in some environments - normalize to 0
  const parsed = parseInt(istString, 10);
  return parsed === 24 ? 0 : parsed;
}

// Given current views, target views, and deadline, calculates how many
// 5-minute intervals remain and how many views are needed per interval.
export function calculateRequiredPerInterval(currentViews, targetViews, deadline, now = new Date()) {
  const viewsNeeded = Math.max(targetViews - currentViews, 0);
  const msLeft = new Date(deadline).getTime() - now.getTime();
  const minutesLeft = Math.max(msLeft / 1000 / 60, 0);
  const intervalsLeft = Math.max(Math.ceil(minutesLeft / 5), 1); // at least 1 to avoid divide by zero

  const requiredPerInterval = viewsNeeded / intervalsLeft;

  return {
    viewsNeeded,
    minutesLeft: Math.round(minutesLeft),
    intervalsLeft,
    requiredPerInterval: Math.round(requiredPerInterval)
  };
}

// Calculates the actual average views gained per 5-minute interval,
// using the last N snapshots (default: last 6 = 30 minutes of data).
export function calculateActualFiveMinAvg(snapshots, intervalCount = 6) {
  if (snapshots.length < 2) return 0;

  const recent = snapshots.slice(-intervalCount - 1); // need N+1 points for N deltas
  const deltas = [];
  for (let i = 1; i < recent.length; i++) {
    deltas.push(recent[i].views - recent[i - 1].views);
  }

  if (deltas.length === 0) return 0;
  const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  return Math.round(avg);
}

// Returns the current time-slot bias based on hour of day, in India Standard Time (IST).
// IMPORTANT: the server (Render) runs in UTC regardless of where you are, so using
// `now.getHours()` directly would read the WRONG hour (e.g. 8AM IST looks like 2:30AM
// to a UTC server, which fell into the wrong bucket below). We explicitly convert to
// IST (UTC+5:30) here so the bias is always correct for your actual local time.
export function getCurrentTimeBias(now = new Date()) {
  const hour = getIstHour(now);

  if (hour >= 10 && hour < 12) {
    return { bias: 'cautious', label: 'Cautious zone', riskMultiplier: 0.5 };
  }
  if (hour >= 12 && hour < 16) {
    return { bias: 'yes', label: 'YES advantage', riskMultiplier: 1 };
  }
  if (hour >= 16 && hour < 24) {
    return { bias: 'no', label: 'NO advantage', riskMultiplier: 1 };
  }
  // Before 10AM - outside all defined rule windows, no bias applies
  return { bias: 'neutral', label: 'No data (before 10AM)', riskMultiplier: 1 };
}

// Applies the +10% weightage to whichever side has the time-slot advantage.
// Returns which side (yes/no) should be highlighted on the event card.
export function getWeightedSide(bias) {
  if (bias === 'yes') return 'yes';
  if (bias === 'no') return 'no';
  return null; // cautious zone has no side advantage
}

// Given a balance, returns the matching risk tier and suggested trade amount range.
// riskTiers should be passed in from the `rules` table (category = 'risk_tier').
export function calculateSuggestedRisk(balance, riskTiers, timeBias) {
  const tier = riskTiers.find(t => balance >= t.range_min && balance <= t.range_max);
  if (!tier) return null;

  let minPct = parseFloat(tier.risk_min_pct);
  let maxPct = parseFloat(tier.risk_max_pct);

  // Cautious zone halves the suggested risk
  if (timeBias === 'cautious') {
    minPct = minPct / 2;
    maxPct = maxPct / 2;
  }

  return {
    tier: { min: tier.range_min, max: tier.range_max },
    riskPct: { min: minPct, max: maxPct },
    suggestedAmount: {
      min: Math.round((balance * minPct) / 100),
      max: Math.round((balance * maxPct) / 100)
    },
    cautionApplied: timeBias === 'cautious'
  };
}

// Trade entry P&L: (sell - buy) * quantity
export function calculateEntryPnl(buyPrice, sellPrice, quantity) {
  return Math.round((sellPrice - buyPrice) * quantity * 100) / 100;
}

// Aggregates a list of entry P&Ls into gross profit, total losses, commission, net.
// IMPORTANT: commission is 15% of gross profit ONLY. Losses are separate and
// are NOT netted against gross profit before commission is calculated.
export function calculateTradeTotals(entryPnls) {
  let grossProfit = 0;
  let totalLosses = 0;

  for (const pnl of entryPnls) {
    if (pnl > 0) grossProfit += pnl;
    else totalLosses += pnl; // stored as negative
  }

  grossProfit = Math.round(grossProfit * 100) / 100;
  totalLosses = Math.round(totalLosses * 100) / 100;

  const commission = Math.round(grossProfit * 0.15 * 100) / 100;
  const netProfit = Math.round((grossProfit - commission + totalLosses) * 100) / 100;

  return { grossProfit, totalLosses, commission, netProfit };
}

// Withdrawal commission: flat 3% taken on every withdrawal amount.
export function calculateWithdrawalCommission(amount) {
  return Math.round(amount * 0.03 * 100) / 100;
}
