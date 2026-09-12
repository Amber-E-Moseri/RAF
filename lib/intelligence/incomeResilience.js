/**
 * Income Variability / Plan Resilience — Phase 7.
 *
 * STATUS: BLOCKED
 *
 * Cannot be implemented until the following product semantics are explicitly approved:
 *
 *   1. What counts as "essential"?
 *   2. Are all fixed bills essential?
 *   3. Are all debt minimums required?
 *   4. Is savings ever a protected minimum?
 *   5. How is Buffer treated?
 *   6. Are category percentages sufficient to define minimum viable income?
 *   7. Is a variable-income household expected to fund the full plan every month?
 *
 * Do NOT invent formulas.
 * Do NOT compute requiredIncome as fixedBills + debtMinimums + arbitrary fraction.
 * Do NOT compute planMinIncome as totalAllocated / largestPercent.
 *
 * Return this sentinel from any API that checks this phase.
 */

export const INCOME_RESILIENCE_STATUS = 'BLOCKED';

export function computeIncomeResilience() {
  return {
    status: INCOME_RESILIENCE_STATUS,
    reason: 'Phase 7 requires explicit product-semantic approval before implementation.',
    blockedOn: [
      'definition of essential commitments',
      'savings as protected minimum y/n',
      'buffer treatment',
      'variable-income household policy',
    ],
  };
}
