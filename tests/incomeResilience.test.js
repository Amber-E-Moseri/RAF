import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeIncomeResilience, INCOME_RESILIENCE_STATUS } from '../lib/intelligence/incomeResilience.js';

describe('income resilience (Phase 7 — BLOCKED)', () => {
  // 45. Returns BLOCKED sentinel
  it('45. computeIncomeResilience always returns BLOCKED status', () => {
    const result = computeIncomeResilience();
    assert.equal(result.status, 'BLOCKED');
    assert.equal(INCOME_RESILIENCE_STATUS, 'BLOCKED');
  });

  // 46. BLOCKED reason and blockedOn present
  it('46. result includes reason and blockedOn list', () => {
    const result = computeIncomeResilience();
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.ok(Array.isArray(result.blockedOn) && result.blockedOn.length > 0);
  });

  // 47. No numeric metrics computed — no income, spending, or resilience figures
  it('47. BLOCKED result contains no computed numeric metrics', () => {
    const result = computeIncomeResilience();
    const numericKeys = Object.keys(result).filter(
      (k) => !['status', 'reason', 'blockedOn'].includes(k),
    );
    assert.equal(numericKeys.length, 0, `Unexpected keys: ${numericKeys.join(', ')}`);
  });
});
