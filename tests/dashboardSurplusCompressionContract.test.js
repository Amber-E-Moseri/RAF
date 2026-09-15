import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DASHBOARD_PATH = resolve('src/pages/Dashboard.tsx');
const MONTHLY_REVIEW_PATH = resolve('src/pages/MonthlyReview.tsx');

function readSource(filePath) {
  return readFileSync(filePath, 'utf8');
}

describe('Dashboard surplus compression contract', () => {
  it('Dashboard does not import applyMonthlyReview', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('applyMonthlyReview'),
      'Dashboard must not import or call applyMonthlyReview — surplus execution is MonthlyReview authority only',
    );
  });

  it('Dashboard does not contain Quick Apply button', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('Quick apply'),
      'Dashboard must not render a Quick apply button',
    );
  });

  it('Dashboard does not define handleQuickApplySurplus', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('handleQuickApplySurplus'),
      'Dashboard must not define handleQuickApplySurplus',
    );
  });

  it('Dashboard does not define surplusDraftRows state', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('surplusDraftRows'),
      'Dashboard must not manage surplusDraftRows state',
    );
  });

  it('Dashboard does not define editingSurplusRowId state', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('editingSurplusRowId'),
      'Dashboard must not manage editingSurplusRowId state',
    );
  });

  it('Dashboard does not define surplusRowDraft state', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('surplusRowDraft'),
      'Dashboard must not manage surplusRowDraft state',
    );
  });

  it('Dashboard does not define openSurplusRowEditor', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('openSurplusRowEditor'),
      'Dashboard must not define openSurplusRowEditor',
    );
  });

  it('Dashboard does not define handleApplySurplusRowEdit', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      !source.includes('handleApplySurplusRowEdit'),
      'Dashboard must not define handleApplySurplusRowEdit',
    );
  });

  it('Dashboard has read-only surplus prompt with Review allocation link', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      source.includes('Review allocation'),
      'Dashboard must show read-only "Review allocation" prompt for surplus',
    );
    assert.ok(
      source.includes('to="/monthly-review"') || source.includes('to=\'/monthly-review\''),
      'Surplus prompt must link to /monthly-review',
    );
  });

  it('Dashboard surplusExists is netSurplus > 0 without suggestedRows check', () => {
    const source = readSource(DASHBOARD_PATH);
    // Must contain the correct formula
    assert.ok(
      source.includes('surplusExists = Number(dashboardData.surplusRecommendations.netSurplus) > 0'),
      'surplusExists must be derived from netSurplus > 0 only (not gated on suggestedRows.length)',
    );
    // Must not contain the old gated formula
    assert.ok(
      !source.includes('surplusExists = Number(dashboardData.surplusRecommendations.netSurplus) > 0 && suggestedRows.length > 0'),
      'surplusExists must not be gated on suggestedRows.length',
    );
  });

  it('MonthlyReview still uses applyMonthlyReview (positive assertion)', () => {
    const source = readSource(MONTHLY_REVIEW_PATH);
    assert.ok(
      source.includes('applyMonthlyReview'),
      'MonthlyReview must remain the exclusive executor of applyMonthlyReview',
    );
  });
});
