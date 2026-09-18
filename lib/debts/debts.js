import { z } from 'zod';

import { logAuditEvent } from '../audit/auditLog.js';
import { isLiabilityAccount, resolveDebtBalanceAuthority } from './debtBalanceAuthority.js';
import { buildDebtListResponse, deriveDebtSnapshot } from '../raf/debts.js';
import { formatCents, parseMoneyToCents } from '../raf/reporting.js';

export class DebtHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DebtHttpError';
    this.status = status;
  }
}

const isoMoneyPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const aprPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

const nonNegativeMoneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine((value) => isoMoneyPattern.test(value), {
    message: 'must be a non-negative decimal with up to 2 places',
  })
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${(fraction + '00').slice(0, 2)}`;
  });

const positiveMoneySchema = nonNegativeMoneySchema.refine((value) => value !== '0.00', {
  message: 'must be greater than 0',
});

const aprSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine((value) => aprPattern.test(value), {
    message: 'must be a non-negative decimal with up to 2 places',
  })
  .transform((value) => Number(value))
  .refine((value) => value >= 0 && value <= 100, {
    message: 'must be between 0 and 100',
  })
  .transform((value) => Number(value.toFixed(2)));

const trimmedStringSchema = z.string().trim().min(1, 'is required');
// Types the user may create via the public adjustment API — persisted to raf.debt_adjustments.
// 'reconciliation' is system-only (establishManualAuthorityBoundary on account unlink).
// 'late_fee' is generated-only (buildGeneratedAdjustments, generated: true), never persisted.
const apiAdjustmentTypeSchema = z.enum(['correction', 'interest', 'fee']);
const statementDaySchema = z.number().int().min(1).max(28);
const paymentDueDaySchema = z.number().int().min(1).max(31);
const nullableIdSchema = z
  .string()
  .trim()
  .min(1, 'is required')
  .nullable()
  .optional();
const signedMoneyPattern = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const adjustmentMoneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine((value) => signedMoneyPattern.test(value), {
    message: 'must be a signed decimal with up to 2 places',
  })
  .transform((value) => {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const normalized = `${whole}.${(fraction + '00').slice(0, 2)}`;
    return negative ? `-${normalized}` : normalized;
  })
  .refine((value) => value !== '0.00' && value !== '-0.00', {
    message: 'must not be zero',
  });
const isoDateSchema = z.string().trim().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), {
  message: 'must be a valid ISO date',
});

export const createDebtSchema = z.object({
  name: trimmedStringSchema,
  startingBalance: positiveMoneySchema,
  apr: aprSchema,
  minimumPayment: nonNegativeMoneySchema,
  monthlyPayment: nonNegativeMoneySchema,
  statementDay: statementDaySchema.optional(),
  paymentDueDay: paymentDueDaySchema.optional(),
  lateFeeAmount: nonNegativeMoneySchema.optional().default('0.00'),
  autoPostInterest: z.boolean().optional().default(false),
  autoPostLateFee: z.boolean().optional().default(false),
  sortOrder: z.number().int().optional().default(0),
  financialAccountId: nullableIdSchema,
  financial_account_id: nullableIdSchema,
});

export const updateDebtSchema = z
  .object({
    name: trimmedStringSchema.optional(),
    apr: aprSchema.optional(),
    minimumPayment: nonNegativeMoneySchema.optional(),
    monthlyPayment: nonNegativeMoneySchema.optional(),
    statementDay: statementDaySchema.optional(),
    paymentDueDay: paymentDueDaySchema.optional(),
    lateFeeAmount: nonNegativeMoneySchema.optional(),
    autoPostInterest: z.boolean().optional(),
    autoPostLateFee: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    isActive: z.boolean().optional(),
    financialAccountId: nullableIdSchema,
    financial_account_id: nullableIdSchema,
    confirmedManualBalance: nonNegativeMoneySchema.optional(),
    confirmed_manual_balance: nonNegativeMoneySchema.optional(),
    startingBalance: z.any().optional(),
    currentBalance: z.any().optional(),
  })
  .superRefine((value, context) => {
    if (Object.prototype.hasOwnProperty.call(value, 'startingBalance')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startingBalance'],
        message: 'is a derived or immutable balance field and cannot be edited',
      });
    }

    if (Object.prototype.hasOwnProperty.call(value, 'currentBalance')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentBalance'],
        message: 'is a derived or immutable balance field and cannot be edited',
      });
    }

    const editableKeys = ['name', 'apr', 'minimumPayment', 'monthlyPayment', 'statementDay', 'paymentDueDay', 'lateFeeAmount', 'autoPostInterest', 'autoPostLateFee', 'sortOrder', 'isActive', 'financialAccountId', 'financial_account_id'];
    if (!editableKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one editable field is required',
      });
    }
  });

export const createDebtAdjustmentSchema = z.object({
  amount: adjustmentMoneySchema,
  adjustmentType: apiAdjustmentTypeSchema.optional(),
  adjustment_type: apiAdjustmentTypeSchema.optional(),
  effectiveDate: isoDateSchema.optional(),
  effective_date: isoDateSchema.optional(),
  note: z.string().trim().min(1, 'is required'),
}).superRefine((value, context) => {
  if (!value.adjustmentType && !value.adjustment_type) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adjustment_type'],
      message: 'is required',
    });
  }

  if (!value.effectiveDate && !value.effective_date) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effective_date'],
      message: 'is required',
    });
  }
});

export const paymentPaceAcknowledgementSchema = z.object({
  action: z.enum(['keep_plan', 'acknowledge_onetime', 'update_plan']),
  paymentPeriodMonth: z.string().trim().regex(/^\d{4}-\d{2}$/, 'must use YYYY-MM format'),
  newMonthlyPayment: nonNegativeMoneySchema.optional(),
}).superRefine((value, context) => {
  if (value.action === 'update_plan' && !value.newMonthlyPayment) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['newMonthlyPayment'],
      message: 'is required when action is update_plan',
    });
  }
});

function requireDbContract(db) {
  if (typeof db?.transaction !== 'function') {
    throw new Error('Debt DB adapter must implement transaction().');
  }
}

function parseWithSchema(schema, input, { businessRule = false } = {}) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
    throw new DebtHttpError(businessRule ? 422 : 400, `${path} ${issue.message}`.trim());
  }

  return result.data;
}

function groupDebtPaymentsByDebtId(payments) {
  const byDebtId = new Map();

  for (const payment of payments) {
    const existing = byDebtId.get(payment.debtId) ?? [];
    existing.push(payment);
    byDebtId.set(payment.debtId, existing);
  }

  return byDebtId;
}

function groupDebtAdjustmentsByDebtId(adjustments) {
  const byDebtId = new Map();

  for (const adjustment of adjustments) {
    const existing = byDebtId.get(adjustment.debtId) ?? [];
    existing.push(adjustment);
    byDebtId.set(adjustment.debtId, existing);
  }

  return byDebtId;
}

function normalizeDebtCreateInput(input) {
  return {
    ...input,
    financialAccountId: input.financialAccountId ?? input.financial_account_id ?? null,
  };
}

function normalizeDebtPatch(input) {
  const patch = { ...input };
  if (Object.prototype.hasOwnProperty.call(input, 'financialAccountId')
    || Object.prototype.hasOwnProperty.call(input, 'financial_account_id')) {
    patch.financialAccountId = input.financialAccountId ?? input.financial_account_id ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'confirmedManualBalance')
    || Object.prototype.hasOwnProperty.call(input, 'confirmed_manual_balance')) {
    patch.confirmedManualBalance = input.confirmedManualBalance ?? input.confirmed_manual_balance;
  }
  delete patch.financial_account_id;
  delete patch.confirmed_manual_balance;
  return patch;
}

function formatSignedCents(cents) {
  return cents < 0 ? `-${formatCents(Math.abs(cents))}` : formatCents(cents);
}

function manualAuthorityEffectiveDate(activeMonth, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (typeof activeMonth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(activeMonth)) {
    if (activeMonth.slice(0, 7) === today.slice(0, 7)) {
      return today;
    }
    const [year, month] = activeMonth.split('-').map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }

  return today;
}

async function establishManualAuthorityBoundary({
  tx,
  householdId,
  debt,
  payments,
  adjustments,
  activeMonth,
  confirmedManualBalance,
}) {
  if (confirmedManualBalance == null) {
    throw new DebtHttpError(422, 'confirmedManualBalance is required to unlink an account-backed debt');
  }
  if (typeof tx.insertDebtAdjustment !== 'function') {
    throw new DebtHttpError(500, 'debt reconciliation adjustments are not supported by this database adapter');
  }

  const manualDebt = {
    ...debt,
    financialAccountId: null,
    financial_account_id: null,
    balanceAuthority: resolveDebtBalanceAuthority({
      debt: { ...debt, financialAccountId: null, financial_account_id: null },
    }),
  };
  const manualSnapshot = deriveDebtSnapshot(manualDebt, payments, adjustments, activeMonth);
  const currentManualCents = parseMoneyToCents(manualSnapshot.currentBalance);
  const confirmedManualCents = parseMoneyToCents(confirmedManualBalance);
  const deltaCents = confirmedManualCents - currentManualCents;

  if (deltaCents === 0) {
    return adjustments;
  }

  const created = await tx.insertDebtAdjustment({
    householdId,
    debtId: debt.id,
    amount: formatSignedCents(deltaCents),
    adjustmentType: 'reconciliation',
    effectiveDate: manualAuthorityEffectiveDate(activeMonth),
    note: 'Manual balance confirmed while unlinking financial account authority',
  });

  return [...adjustments, created];
}

async function validateFinancialAccountLink({ tx, householdId, financialAccountId, debtId = null, active = true }) {
  if (!financialAccountId) {
    return null;
  }
  if (typeof tx.getFinancialAccountById !== 'function') {
    throw new DebtHttpError(500, 'financial account linking is not supported by this database adapter');
  }

  const account = await tx.getFinancialAccountById({ householdId, accountId: financialAccountId });
  if (!account) {
    throw new DebtHttpError(404, 'financial account not found');
  }
  if ((account.status ?? 'active') !== 'active') {
    throw new DebtHttpError(422, 'financial account must be active to link to a debt');
  }
  if (!isLiabilityAccount(account)) {
    throw new DebtHttpError(422, 'financial account must be a liability account to link to a debt');
  }

  if (active !== false && typeof tx.listDebts === 'function') {
    const existingDebts = await tx.listDebts({ householdId });
    const duplicate = existingDebts.find((debt) =>
      debt.id !== debtId
      && debt.isActive !== false
      && (debt.financialAccountId ?? debt.financial_account_id ?? null) === financialAccountId);
    if (duplicate) {
      throw new DebtHttpError(409, 'financial account is already linked to an active debt');
    }
  }

  return account;
}

async function resolveDebtAccounts(tx, householdId, debts) {
  const linkedAccountIds = [...new Set(debts.map((debt) => debt.financialAccountId ?? debt.financial_account_id).filter(Boolean))];
  if (linkedAccountIds.length === 0) {
    return new Map();
  }
  if (typeof tx.getFinancialAccountById !== 'function') {
    throw new DebtHttpError(500, 'financial account linking is not supported by this database adapter');
  }

  const entries = await Promise.all(linkedAccountIds.map(async (accountId) => {
    const account = await tx.getFinancialAccountById({ householdId, accountId });
    return [accountId, account];
  }));
  return new Map(entries.filter(([, account]) => account));
}

function attachBalanceAuthority(debt, accountById) {
  const financialAccountId = debt.financialAccountId ?? debt.financial_account_id ?? null;
  const financialAccount = financialAccountId ? accountById.get(financialAccountId) ?? null : null;
  return {
    ...debt,
    financialAccountId,
    balanceAuthority: resolveDebtBalanceAuthority({ debt: { ...debt, financialAccountId }, financialAccount }),
  };
}

function formatDebtAdjustmentResponse(adjustment) {
  return {
    id: adjustment.id,
    debt_id: adjustment.debtId,
    household_id: adjustment.householdId,
    amount: adjustment.amount,
    adjustment_type: adjustment.adjustmentType,
    effective_date: adjustment.effectiveDate,
    note: adjustment.note,
    created_at: adjustment.createdAt,
  };
}

function formatDebtResponse(snapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    startingBalance: snapshot.startingBalance,
    currentBalance: snapshot.currentBalance,
    financialAccountId: snapshot.financialAccountId ?? null,
    balanceAuthority: snapshot.balanceAuthority ?? null,
    apr: snapshot.apr,
    minimumPayment: snapshot.minimumPayment,
    monthlyPayment: snapshot.monthlyPayment,
    statementDay: snapshot.statementDay ?? null,
    paymentDueDay: snapshot.paymentDueDay ?? null,
    lateFeeAmount: snapshot.lateFeeAmount ?? '0.00',
    autoPostInterest: snapshot.autoPostInterest === true,
    autoPostLateFee: snapshot.autoPostLateFee === true,
    status: snapshot.status,
    sortOrder: snapshot.sortOrder,
    isActive: snapshot.isActive,
    totalAdjustments: snapshot.totalAdjustments,
    openingBalance: snapshot.openingBalance,
    paymentsThisMonth: snapshot.paymentsThisMonth,
    interestChargedThisMonth: snapshot.interestChargedThisMonth,
    feesThisMonth: snapshot.feesThisMonth,
    principalReductionThisMonth: snapshot.principalReductionThisMonth,
    paymentStatus: snapshot.paymentStatus,
    estimatedPayoffDate: snapshot.estimatedPayoffDate,
    monthsRemaining: snapshot.monthsRemaining,
    totalInterestRemaining: snapshot.totalInterestRemaining,
    paymentPace: snapshot.paymentPace ?? null,
    paymentInsight: snapshot.paymentInsight ?? null,
    insightAcknowledged: snapshot.insightAcknowledged === true,
    paymentObligation: snapshot.paymentObligation ?? null,
    balanceTrajectory: snapshot.balanceTrajectory ?? null,
    balanceExplanation: snapshot.balanceExplanation ?? null,
  };
}

async function resolveActiveMonth(tx, householdId) {
  if (typeof tx.getHousehold !== 'function') {
    return undefined;
  }

  const household = await tx.getHousehold({ householdId });
  return household?.activeMonth;
}

export async function getDebt({ db, householdId, debtId }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  if (!debtId) {
    throw new DebtHttpError(400, 'debtId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const debt = await tx.getDebtById({ householdId, debtId });
    if (!debt) {
      throw new DebtHttpError(404, 'debt not found');
    }

    return debt;
  });
}

export async function createDebt({ db, householdId, userId, input }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  requireDbContract(db);
  const parsedInput = normalizeDebtCreateInput(parseWithSchema(createDebtSchema, input));

  return db.transaction(async (tx) => {
    const activeMonth = await resolveActiveMonth(tx, householdId);
    const account = await validateFinancialAccountLink({
      tx,
      householdId,
      financialAccountId: parsedInput.financialAccountId,
      active: true,
    });
    const created = await tx.insertDebt({
      householdId,
      name: parsedInput.name,
      startingBalance: parsedInput.startingBalance,
      apr: parsedInput.apr,
      minimumPayment: parsedInput.minimumPayment,
      monthlyPayment: parsedInput.monthlyPayment,
      statementDay: parsedInput.statementDay ?? null,
      paymentDueDay: parsedInput.paymentDueDay ?? null,
      lateFeeAmount: parsedInput.lateFeeAmount ?? '0.00',
      autoPostInterest: parsedInput.autoPostInterest === true,
      autoPostLateFee: parsedInput.autoPostLateFee === true,
      sortOrder: parsedInput.sortOrder,
      financialAccountId: parsedInput.financialAccountId,
      isActive: true,
    });

    const snapshot = deriveDebtSnapshot({
      ...created,
      ...parsedInput,
      id: created.id,
      isActive: created.isActive ?? true,
      balanceAuthority: resolveDebtBalanceAuthority({ debt: created, financialAccount: account }),
      createdAt: created.createdAt ?? new Date().toISOString(),
    }, [], [], activeMonth);

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'debt.created',
      entityId: created.id,
    });

    return formatDebtResponse(snapshot);
  });
}

export async function listDebts({ db, householdId }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const activeMonth = await resolveActiveMonth(tx, householdId);
    const debts = await tx.listDebts({ householdId });
    const accountById = await resolveDebtAccounts(tx, householdId, debts);
    const debtPayments = await tx.listDebtPayments({ householdId });
    const debtAdjustments = typeof tx.listDebtAdjustments === 'function'
      ? await tx.listDebtAdjustments({ householdId })
      : [];
    const acknowledgements = new Map();
    const period = String(activeMonth ?? '').slice(0, 7);
    if (typeof tx.getPaymentPaceAcknowledgement === 'function' && /^\d{4}-\d{2}$/.test(period)) {
      await Promise.all(debts.map(async (debt) => {
        const acknowledgement = await tx.getPaymentPaceAcknowledgement({
          householdId,
          debtId: debt.id,
          paymentPeriodMonth: period,
        });
        if (acknowledgement) {
          acknowledgements.set(debt.id, acknowledgement);
        }
      }));
    }

    return buildDebtListResponse(
      debts.map((debt) => attachBalanceAuthority(debt, accountById)),
      groupDebtPaymentsByDebtId(debtPayments),
      groupDebtAdjustmentsByDebtId(debtAdjustments),
      activeMonth,
      acknowledgements,
    );
  });
}

export async function updateDebt({ db, householdId, debtId, userId, input }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  if (!debtId) {
    throw new DebtHttpError(400, 'debtId is required');
  }

  requireDbContract(db);

  if (Object.prototype.hasOwnProperty.call(input ?? {}, 'startingBalance')
    || Object.prototype.hasOwnProperty.call(input ?? {}, 'currentBalance')) {
    parseWithSchema(updateDebtSchema, input, { businessRule: true });
  }

  const parsedInput = normalizeDebtPatch(parseWithSchema(updateDebtSchema, input));

  return db.transaction(async (tx) => {
    const activeMonth = await resolveActiveMonth(tx, householdId);
    const existing = await tx.getDebtById({ householdId, debtId });
    if (!existing) {
      throw new DebtHttpError(404, 'debt not found');
    }
    const isFinancialAccountPatch = Object.prototype.hasOwnProperty.call(parsedInput, 'financialAccountId');
    const existingFinancialAccountId = existing.financialAccountId ?? existing.financial_account_id ?? null;
    const nextFinancialAccountId = Object.prototype.hasOwnProperty.call(parsedInput, 'financialAccountId')
      ? parsedInput.financialAccountId
      : existingFinancialAccountId;
    const nextActive = Object.prototype.hasOwnProperty.call(parsedInput, 'isActive')
      ? parsedInput.isActive
      : existing.isActive !== false;
    const unlinkingAccountAuthority = isFinancialAccountPatch
      && existingFinancialAccountId
      && nextFinancialAccountId == null;
    if (isFinancialAccountPatch
      && !existingFinancialAccountId
      && nextFinancialAccountId == null) {
      throw new DebtHttpError(409, 'debt is already manually balanced');
    }
    const account = unlinkingAccountAuthority ? null : await validateFinancialAccountLink({
      tx,
      householdId,
      financialAccountId: nextFinancialAccountId,
      debtId,
      active: nextActive,
    });
    const debtPatch = { ...parsedInput };
    delete debtPatch.confirmedManualBalance;

    const payments = await tx.listDebtPayments({ householdId, debtId });
    let adjustments = typeof tx.listDebtAdjustments === 'function'
      ? await tx.listDebtAdjustments({ householdId, debtId })
      : [];
    if (unlinkingAccountAuthority) {
      adjustments = await establishManualAuthorityBoundary({
        tx,
        householdId,
        debt: existing,
        payments,
        adjustments,
        activeMonth,
        confirmedManualBalance: parsedInput.confirmedManualBalance,
      });
    }

    const updated = await tx.updateDebt({
      householdId,
      debtId,
      patch: debtPatch,
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'debt.updated',
      entityId: debtId,
    });

    return formatDebtResponse(
      deriveDebtSnapshot(
        {
          ...existing,
          ...updated,
          ...debtPatch,
          id: debtId,
          financialAccountId: nextFinancialAccountId,
          balanceAuthority: resolveDebtBalanceAuthority({
            debt: { ...existing, ...updated, financialAccountId: nextFinancialAccountId },
            financialAccount: account,
          }),
        },
        payments,
        adjustments,
        activeMonth,
      ),
    );
  });
}

export async function linkDebtToFinancialAccount({ db, householdId, debtId, financialAccountId }) {
  return updateDebt({
    db,
    householdId,
    debtId,
    input: { financialAccountId },
  });
}

export async function unlinkDebtFromFinancialAccount({ db, householdId, debtId, confirmedManualBalance }) {
  return updateDebt({
    db,
    householdId,
    debtId,
    input: { financialAccountId: null, confirmedManualBalance },
  });
}

export async function deleteDebt({ db, householdId, debtId, userId }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  if (!debtId) {
    throw new DebtHttpError(400, 'debtId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const existing = await tx.getDebtById({ householdId, debtId });
    if (!existing) {
      throw new DebtHttpError(404, 'debt not found');
    }

    const paymentCount = await tx.countDebtPaymentsForDebt({ householdId, debtId });
    if (paymentCount > 0) {
      throw new DebtHttpError(422, 'debt has linked payments; set isActive=false instead');
    }

    await tx.deleteDebt({ householdId, debtId });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'debt.deleted',
      entityId: debtId,
    });
  });
}

export async function listDebtAdjustments({ db, householdId, debtId }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  if (!debtId) {
    throw new DebtHttpError(400, 'debtId is required');
  }

  requireDbContract(db);

  return db.transaction(async (tx) => {
    const existing = await tx.getDebtById({ householdId, debtId });
    if (!existing) {
      throw new DebtHttpError(404, 'debt not found');
    }

    return {
      items: (await tx.listDebtAdjustments({ householdId, debtId })).map(formatDebtAdjustmentResponse),
    };
  });
}

export async function createDebtAdjustment({ db, householdId, debtId, userId, input }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  if (!debtId) {
    throw new DebtHttpError(400, 'debtId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(createDebtAdjustmentSchema, input);

  return db.transaction(async (tx) => {
    const existing = await tx.getDebtById({ householdId, debtId });
    if (!existing) {
      throw new DebtHttpError(404, 'debt not found');
    }

    const created = await tx.insertDebtAdjustment({
      householdId,
      debtId,
      amount: parsedInput.amount,
      adjustmentType: parsedInput.adjustmentType ?? parsedInput.adjustment_type,
      effectiveDate: parsedInput.effectiveDate ?? parsedInput.effective_date,
      note: parsedInput.note,
    });

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'debt.adjustment_created',
      entityId: created.id,
    });

    return formatDebtAdjustmentResponse(created);
  });
}

export async function acknowledgeDebtPaymentPace({ db, householdId, debtId, input, userId = null }) {
  if (!householdId) {
    throw new DebtHttpError(400, 'householdId is required');
  }

  if (!debtId) {
    throw new DebtHttpError(400, 'debtId is required');
  }

  requireDbContract(db);
  const parsedInput = parseWithSchema(paymentPaceAcknowledgementSchema, input);

  return db.transaction(async (tx) => {
    const activeMonth = await resolveActiveMonth(tx, householdId);
    const existing = await tx.getDebtById({ householdId, debtId });
    if (!existing) {
      throw new DebtHttpError(404, 'debt not found');
    }
    if (typeof tx.insertPaymentPaceAcknowledgement !== 'function') {
      throw new DebtHttpError(500, 'payment pace acknowledgements are not supported by this database adapter');
    }

    let updatedDebt = existing;
    if (parsedInput.action === 'update_plan') {
      updatedDebt = await tx.updateDebt({
        householdId,
        debtId,
        patch: { monthlyPayment: parsedInput.newMonthlyPayment },
      });
      // The plan only ever changes on an explicit user action; record it. Metadata carries
      // no monetary values (see lib/audit/auditLog.js).
      await logAuditEvent({
        tx,
        workspaceId: householdId,
        userId,
        event: 'debt.updated',
        entityId: debtId,
        metadata: { entityType: 'debt', reason: 'payment_pace_update_plan', paymentPeriodMonth: parsedInput.paymentPeriodMonth },
      });
    }

    const acknowledgement = await tx.insertPaymentPaceAcknowledgement({
      householdId,
      debtId,
      paymentPeriodMonth: parsedInput.paymentPeriodMonth,
      action: parsedInput.action,
    });

    const payments = await tx.listDebtPayments({ householdId, debtId });
    const adjustments = typeof tx.listDebtAdjustments === 'function'
      ? await tx.listDebtAdjustments({ householdId, debtId })
      : [];

    return {
      acknowledged: true,
      acknowledgement,
      debt: formatDebtResponse(
        deriveDebtSnapshot(
          {
            ...existing,
            ...updatedDebt,
            paymentPaceAcknowledgement: acknowledgement,
          },
          payments,
          adjustments,
          activeMonth,
        ),
      ),
    };
  });
}

export const __internal = {
  createDebtSchema,
  createDebtAdjustmentSchema,
  paymentPaceAcknowledgementSchema,
  updateDebtSchema,
  groupDebtAdjustmentsByDebtId,
  groupDebtPaymentsByDebtId,
};
