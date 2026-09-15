import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INCOME_MODAL_PATH = resolve('src/components/income/IncomeModal.tsx');
const DASHBOARD_PATH = resolve('src/pages/Dashboard.tsx');
const TRANSACTIONS_PATH = resolve('src/pages/Transactions.tsx');
const APP_PATH = resolve('src/App.tsx');

function readSource(filePath) {
  return readFileSync(filePath, 'utf8');
}

describe('IncomeModal modalization contract', () => {
  it('IncomeModal exports IncomeModal', () => {
    const source = readSource(INCOME_MODAL_PATH);
    assert.ok(
      source.includes('export function IncomeModal'),
      'IncomeModal.tsx must export IncomeModal',
    );
  });

  it('IncomeModal accepts isOpen, onClose, and onSuccess props', () => {
    const source = readSource(INCOME_MODAL_PATH);
    assert.ok(source.includes('isOpen'), 'IncomeModal must accept isOpen prop');
    assert.ok(source.includes('onClose'), 'IncomeModal must accept onClose prop');
    assert.ok(source.includes('onSuccess'), 'IncomeModal must accept onSuccess prop');
  });

  it('IncomeModal uses createIncome from incomeApi', () => {
    const source = readSource(INCOME_MODAL_PATH);
    assert.ok(
      source.includes("from '../../api/incomeApi'") || source.includes('from "../../api/incomeApi"'),
      'IncomeModal must import from incomeApi',
    );
    assert.ok(source.includes('createIncome'), 'IncomeModal must call createIncome');
  });

  it('Dashboard imports and renders IncomeModal', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      source.includes('IncomeModal'),
      'Dashboard must import and render IncomeModal',
    );
    assert.ok(
      source.includes('from "../components/income/IncomeModal"'),
      'Dashboard must import IncomeModal from components/income/IncomeModal',
    );
  });

  it('Dashboard has showIncomeModal state', () => {
    const source = readSource(DASHBOARD_PATH);
    assert.ok(
      source.includes('showIncomeModal'),
      'Dashboard must manage showIncomeModal state',
    );
  });

  it('Transactions imports and renders IncomeModal', () => {
    const source = readSource(TRANSACTIONS_PATH);
    assert.ok(
      source.includes('IncomeModal'),
      'Transactions must import and render IncomeModal',
    );
    assert.ok(
      source.includes('from "../components/income/IncomeModal"'),
      'Transactions must import IncomeModal from components/income/IncomeModal',
    );
  });

  it('Transactions has Add Income button and showIncomeModal state', () => {
    const source = readSource(TRANSACTIONS_PATH);
    assert.ok(
      source.includes('showIncomeModal'),
      'Transactions must manage showIncomeModal state',
    );
    assert.ok(
      source.includes('Add Income'),
      'Transactions must have an Add Income button',
    );
  });

  it('/income/new route still exists in App.tsx', () => {
    const source = readSource(APP_PATH);
    assert.ok(
      source.includes('income/new'),
      'income/new route must still exist in App.tsx for deep-link compatibility',
    );
  });
});
