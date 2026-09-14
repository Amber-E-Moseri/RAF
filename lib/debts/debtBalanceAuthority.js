import { formatCents, parseMoneyToCents } from '../raf/reporting.js';

export const LIABILITY_ACCOUNT_TYPES = new Set(['credit_card', 'line_of_credit', 'loan']);

export function isLiabilityAccount(account) {
  return LIABILITY_ACCOUNT_TYPES.has(account?.accountType ?? account?.account_type);
}

export function resolveDebtBalanceAuthority({ debt, financialAccount = null }) {
  if (debt?.financialAccountId || debt?.financial_account_id) {
    if (!financialAccount) {
      throw new Error('linked debt requires a financial account to resolve balance authority');
    }

    const balanceCents = Math.abs(parseMoneyToCents(financialAccount.currentBalance ?? financialAccount.current_balance ?? '0.00'));
    return {
      source: 'financial_account',
      balance: formatCents(balanceCents),
      asOf: financialAccount.balanceAsOf ?? financialAccount.balance_as_of ?? financialAccount.updatedAt ?? null,
      financialAccountId: financialAccount.id,
    };
  }

  return {
    source: 'manual_derived',
    balance: null,
    asOf: null,
    financialAccountId: null,
  };
}
