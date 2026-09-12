// Named configuration for intelligence thresholds — never hard-coded inline.

// Spending velocity: minimum days elapsed before runway estimate is meaningful.
export const VELOCITY_MIN_DAYS_ELAPSED = 3;

// Plan pressure: minimum consecutive closed months needed to fire a signal.
export const PRESSURE_MIN_MONTHS_OVER = 3;

// Plan pressure: lookback window (months) for signal detection.
export const PRESSURE_LOOKBACK_MONTHS = 4;

// Plan pressure: ratio of actual/planned that counts as "over".
export const PRESSURE_RATIO = 1.10;

// Category slugs that are NOT modelled as daily-spend and skip velocity.
export const NON_VELOCITY_CATEGORY_SLUGS = new Set([
  'savings',
  'buffer',
  'debt-payoff',
  'fixed-bills',
  'investment',
]);
