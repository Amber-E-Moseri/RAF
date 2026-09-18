import { logAuditEvent } from '../audit/auditLog.js';
import { formatCents, parseMoneyToCents, unwrapRows, monthStart } from '../raf/reporting.js';
import { MonthlyReviewHttpError, requireDbContract } from './shared.js';
export { MonthlyReviewHttpError } from './shared.js';

// ── Lifecycle States ─────────────────────────────────────────────────────────
export const LifecycleState = Object.freeze({
  OPEN: 'OPEN',
  REVIEWING: 'REVIEWING',
  CLOSED: 'CLOSED',
});

function normalizePeriod(value) {
  let normalized;
  try {
    normalized = monthStart(value);
  } catch {
    throw new MonthlyReviewHttpError(400, 'period must be a valid ISO date');
  }
  if (String(value).trim() !== normalized) {
    throw new MonthlyReviewHttpError(400, 'period must be the first day of the month');
  }
  return normalized;
}

// ── Lifecycle Query ──────────────────────────────────────────────────────────

export async function getMonthLifecycleState({ db, householdId, period }) {
  if (!householdId) throw new MonthlyReviewHttpError(400, 'householdId is required');
  requireDbContract(db);
  const normalizedPeriod = normalizePeriod(period);

  return db.transaction(async (tx) => {
    const [closes, review] = await Promise.all([
      typeof tx.listMonthCloses === 'function'
        ? tx.listMonthCloses({ householdId, period: normalizedPeriod })
        : [],
      tx.getMonthlyReviewByMonth({ householdId, reviewMonth: normalizedPeriod }),
    ]);

    const latestClose = closes.filter((c) => c.status === 'CLOSED').sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;

    if (latestClose) {
      return {
        state: LifecycleState.CLOSED,
        period: normalizedPeriod,
        version: latestClose.version,
        closedAt: latestClose.closedAt,
        closedBy: latestClose.closedBy ?? null,
        snapshot: latestClose.snapshot ?? null,
        bufferDisposition: latestClose.bufferDisposition ?? null,
        closeId: latestClose.id,
        review: review ?? null,
        history: closes,
      };
    }

    if (review) {
      return {
        state: LifecycleState.REVIEWING,
        period: normalizedPeriod,
        review,
        history: [],
      };
    }

    return {
      state: LifecycleState.OPEN,
      period: normalizedPeriod,
      review: null,
      history: [],
    };
  });
}

// ── Close Readiness ──────────────────────────────────────────────────────────

export async function getCloseReadiness({ db, householdId, period }) {
  if (!householdId) throw new MonthlyReviewHttpError(400, 'householdId is required');
  requireDbContract(db);
  const normalizedPeriod = normalizePeriod(period);

  return db.transaction(async (tx) => {
    const [closes, review, transactions, allocationCategories, goals, debts, debtPayments] = await Promise.all([
      typeof tx.listMonthCloses === 'function'
        ? tx.listMonthCloses({ householdId, period: normalizedPeriod })
        : [],
      tx.getMonthlyReviewByMonth({ householdId, reviewMonth: normalizedPeriod }),
      tx.listTransactions({ householdId, from: normalizedPeriod, to: normalizedPeriod }),
      tx.listAllocationCategories({ householdId, asOf: normalizedPeriod }),
      typeof tx.listGoals === 'function' ? tx.listGoals({ householdId }) : [],
      typeof tx.listDebts === 'function' ? tx.listDebts({ householdId }) : [],
      tx.listDebtPayments({ householdId, from: normalizedPeriod, to: normalizedPeriod }),
    ]);

    const latestClose = closes.filter((c) => c.status === 'CLOSED').sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
    const txRows = unwrapRows(transactions);
    const unreviewedCount = txRows.filter((t) => !t.reviewedAt).length;
    const totalTxCount = txRows.length;

    const bufferCategory = allocationCategories.find((c) => c.isBuffer === true && c.isActive !== false) ?? null;

    const goalContributionsTotal = txRows
      .filter((t) => t.linkedGoalId && t.direction === 'debit')
      .reduce((sum, t) => sum + parseMoneyToCents(t.amount), 0);

    const debtPaymentsTotal = debtPayments.reduce((sum, p) => sum + parseMoneyToCents(p.amount), 0);

    const warnings = [];
    const blockers = [];

    if (latestClose) {
      blockers.push({ code: 'ALREADY_CLOSED', message: 'This month is already closed.' });
    }

    if (unreviewedCount > 0) {
      warnings.push({ code: 'UNREVIEWED_TRANSACTIONS', message: `${unreviewedCount} transaction(s) have not been reviewed.`, count: unreviewedCount });
    }

    const canClose = blockers.length === 0;

    return {
      period: normalizedPeriod,
      state: latestClose ? LifecycleState.CLOSED : review ? LifecycleState.REVIEWING : LifecycleState.OPEN,
      canClose,
      summary: {
        totalTransactions: totalTxCount,
        unreviewedTransactions: unreviewedCount,
        hasMonthlyReview: Boolean(review),
        bufferCategory: bufferCategory ? { id: bufferCategory.id, label: bufferCategory.label } : null,
        goalContributionsTotal: formatCents(goalContributionsTotal),
        debtPaymentsTotal: formatCents(debtPaymentsTotal),
        goalCount: goals.length,
        debtCount: debts.length,
      },
      warnings,
      blockers,
    };
  });
}

// ── Transition to REVIEWING ──────────────────────────────────────────────────

export async function transitionToReviewing({ db, householdId, period, userId }) {
  if (!householdId) throw new MonthlyReviewHttpError(400, 'householdId is required');
  requireDbContract(db);
  const normalizedPeriod = normalizePeriod(period);

  return db.transaction(async (tx) => {
    // Use the DB-native conditional write when available.
    // The NOT EXISTS guard inside transitionMonthlyReviewToReviewing is
    // evaluated atomically at READ COMMITTED isolation, so it sees any
    // CLOSED record committed by a concurrent closeMonth — including one
    // that committed after the caller read state but before this write.
    // This invariant holds independently of the hybrid adapter and its
    // advisory lock, so it remains correct after both are removed.
    if (typeof tx.transitionMonthlyReviewToReviewing === 'function') {
      const result = await tx.transitionMonthlyReviewToReviewing({
        householdId,
        period: normalizedPeriod,
        insertPayload: { netSurplus: '0.00', splitApplied: false, distributions: {}, alertStatus: 'ok', notes: null },
      });
      if (result.blocked) {
        throw new MonthlyReviewHttpError(409, 'Month is already closed. Reopen it before starting a new review.');
      }
      const review = result.review;
      await logAuditEvent({
        tx,
        workspaceId: householdId,
        userId,
        event: 'month.reviewing_started',
        entityId: review.id,
        metadata: { period: normalizedPeriod },
      });
      return { state: LifecycleState.REVIEWING, period: normalizedPeriod, review };
    }

    // Fallback path: hybrid adapter (sequential reads under advisory lock).
    // Executes only when the direct-SQL method is absent.
    const [closes, existing] = await Promise.all([
      typeof tx.listMonthCloses === 'function'
        ? tx.listMonthCloses({ householdId, period: normalizedPeriod })
        : [],
      tx.getMonthlyReviewByMonth({ householdId, reviewMonth: normalizedPeriod }),
    ]);

    const latestClose = closes.filter((c) => c.status === 'CLOSED').sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
    if (latestClose) {
      throw new MonthlyReviewHttpError(409, 'Month is already closed. Reopen it before starting a new review.');
    }

    let review;
    if (existing) {
      review = await tx.updateMonthlyReview({
        householdId,
        reviewId: existing.id,
        patch: { status: 'reviewing', updatedAt: new Date().toISOString() },
      });
    } else {
      review = await tx.insertMonthlyReview({
        householdId,
        reviewMonth: normalizedPeriod,
        status: 'reviewing',
        netSurplus: '0.00',
        splitApplied: false,
        distributions: {},
        alertStatus: 'ok',
        notes: null,
      });
    }

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'month.reviewing_started',
      entityId: review.id,
      metadata: { period: normalizedPeriod },
    });

    return { state: LifecycleState.REVIEWING, period: normalizedPeriod, review };
  });
}

// ── Build Close Snapshot ─────────────────────────────────────────────────────

async function buildCloseSnapshot({ tx, householdId, period }) {
  const [incomeEntries, incomeAllocations, transactions, debtPayments, allocationCategories, goals, debts] = await Promise.all([
    tx.listIncomeEntries({ householdId, from: period, to: period }),
    tx.listIncomeAllocations({ householdId, from: period, to: period }),
    tx.listTransactions({ householdId, from: period, to: period }),
    tx.listDebtPayments({ householdId, from: period, to: period }),
    tx.listAllocationCategories({ householdId, asOf: period }),
    typeof tx.listGoals === 'function' ? tx.listGoals({ householdId }) : [],
    typeof tx.listDebts === 'function' ? tx.listDebts({ householdId }) : [],
  ]);

  const txRows = unwrapRows(transactions);
  const bufferCategory = allocationCategories.find((c) => c.isBuffer === true && c.isActive !== false) ?? null;

  // Income totals
  const totalIncomeCents = incomeEntries.reduce((sum, e) => sum + parseMoneyToCents(e.amount ?? '0.00'), 0);

  // Per-allocation allocated amounts
  const allocatedByBucketId = new Map();
  for (const alloc of incomeAllocations) {
    const bid = alloc.allocationCategoryId ?? alloc.categoryId ?? null;
    if (bid) allocatedByBucketId.set(bid, (allocatedByBucketId.get(bid) ?? 0) + parseMoneyToCents(alloc.allocatedAmount ?? alloc.amount ?? '0.00'));
  }

  // Per-allocation spent amounts
  const spentByBucketId = new Map();
  for (const t of txRows) {
    if (t.direction !== 'debit') continue;
    const bid = t.categoryId ?? null;
    if (bid) spentByBucketId.set(bid, (spentByBucketId.get(bid) ?? 0) + Math.abs(parseMoneyToCents(t.amount ?? '0.00')));
  }

  const totalSpentCents = txRows
    .filter((t) => t.direction === 'debit')
    .reduce((sum, t) => sum + Math.abs(parseMoneyToCents(t.amount ?? '0.00')), 0);

  const allocationSnapshots = allocationCategories
    .filter((c) => c.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((c) => {
      const allocated = allocatedByBucketId.get(c.id) ?? 0;
      const spent = spentByBucketId.get(c.id) ?? 0;
      const remaining = allocated - spent;
      return {
        categoryId: c.id,
        slug: c.slug,
        label: c.label ?? c.slug,
        isBuffer: c.isBuffer === true,
        allocated: formatCents(allocated),
        spent: formatCents(spent),
        remaining: formatCents(remaining),
      };
    });

  // Buffer state
  let bufferSnapshot = null;
  if (bufferCategory) {
    const allocated = allocatedByBucketId.get(bufferCategory.id) ?? 0;
    const spent = spentByBucketId.get(bufferCategory.id) ?? 0;
    const remaining = Math.max(allocated - spent, 0);
    bufferSnapshot = {
      categoryId: bufferCategory.id,
      label: bufferCategory.label,
      allocated: formatCents(allocated),
      spent: formatCents(spent),
      remaining: formatCents(remaining),
      overrun: allocated - spent < 0,
      overrunAmount: formatCents(Math.max(spent - allocated, 0)),
    };
  }

  // Goal contributions
  const goalsById = new Map(goals.map((g) => [g.id, g]));
  const goalContribsByGoalId = new Map();
  for (const t of txRows) {
    if (!t.linkedGoalId || t.direction !== 'debit') continue;
    goalContribsByGoalId.set(t.linkedGoalId, (goalContribsByGoalId.get(t.linkedGoalId) ?? 0) + parseMoneyToCents(t.amount ?? '0.00'));
  }
  const goalContributions = [...goalContribsByGoalId.entries()].map(([goalId, cents]) => {
    const goal = goalsById.get(goalId);
    return { goalId, goalName: goal?.name ?? null, amount: formatCents(cents) };
  });
  const totalGoalContributions = [...goalContribsByGoalId.values()].reduce((sum, c) => sum + c, 0);

  // Debt payments
  const debtsById = new Map(debts.map((d) => [d.id, d]));
  const debtPaymentsByDebtId = new Map();
  for (const p of debtPayments) {
    debtPaymentsByDebtId.set(p.debtId, (debtPaymentsByDebtId.get(p.debtId) ?? 0) + parseMoneyToCents(p.amount ?? '0.00'));
  }
  const debtPaymentsList = [...debtPaymentsByDebtId.entries()].map(([debtId, cents]) => {
    const debt = debtsById.get(debtId);
    return { debtId, debtName: debt?.name ?? null, amount: formatCents(cents) };
  });
  const totalDebtPayments = [...debtPaymentsByDebtId.values()].reduce((sum, c) => sum + c, 0);

  // Transaction review state
  const reviewedCount = txRows.filter((t) => Boolean(t.reviewedAt)).length;
  const unreviewedCount = txRows.length - reviewedCount;

  return {
    capturedAt: new Date().toISOString(),
    period,
    income: {
      totalReceived: formatCents(totalIncomeCents),
    },
    spending: {
      totalSpent: formatCents(totalSpentCents),
      netSurplus: formatCents(totalIncomeCents - totalSpentCents),
    },
    allocations: allocationSnapshots,
    buffer: bufferSnapshot,
    goals: {
      contributions: goalContributions,
      totalContributions: formatCents(totalGoalContributions),
    },
    debts: {
      payments: debtPaymentsList,
      totalPayments: formatCents(totalDebtPayments),
    },
    transactions: {
      total: txRows.length,
      reviewed: reviewedCount,
      unreviewed: unreviewedCount,
    },
  };
}

// ── Close Month ──────────────────────────────────────────────────────────────

export async function closeMonth({ db, householdId, period, userId, bufferDispositionInput = null }) {
  if (!householdId) throw new MonthlyReviewHttpError(400, 'householdId is required');
  requireDbContract(db);
  const normalizedPeriod = normalizePeriod(period);

  return db.transaction(async (tx) => {
    const closes = typeof tx.listMonthCloses === 'function'
      ? await tx.listMonthCloses({ householdId, period: normalizedPeriod })
      : [];

    const existingClosed = closes.filter((c) => c.status === 'CLOSED').sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
    if (existingClosed) {
      throw new MonthlyReviewHttpError(409, 'Month is already closed. Reopen it before closing again.');
    }

    const highestVersion = closes.reduce((max, c) => Math.max(max, c.version ?? 0), 0);
    const nextVersion = highestVersion + 1;

    const snapshot = await buildCloseSnapshot({ tx, householdId, period: normalizedPeriod });

    // Validate buffer disposition if provided
    let bufferDisposition = null;
    if (bufferDispositionInput && snapshot.buffer) {
      const remainingCents = parseMoneyToCents(snapshot.buffer.remaining);
      if (remainingCents > 0) {
        const requestedCents = bufferDispositionInput.amount
          ? parseMoneyToCents(bufferDispositionInput.amount)
          : remainingCents;

        if (requestedCents > remainingCents) {
          throw new MonthlyReviewHttpError(422, 'Buffer disposition amount exceeds remaining buffer balance.');
        }

        bufferDisposition = {
          type: bufferDispositionInput.type,
          amount: formatCents(Math.min(requestedCents, remainingCents)),
          targetId: bufferDispositionInput.targetId ?? null,
        };
      }
    }

    const now = new Date().toISOString();
    const closeRecord = await tx.insertMonthClose({
      householdId,
      workspaceId: householdId,
      period: normalizedPeriod,
      version: nextVersion,
      status: 'CLOSED',
      closedAt: now,
      closedBy: userId ?? null,
      reopenedAt: null,
      reopenedBy: null,
      reopenReason: null,
      snapshot,
      bufferDisposition,
    });

    // Upsert monthly_review to status='closed'
    const existingReview = await tx.getMonthlyReviewByMonth({ householdId, reviewMonth: normalizedPeriod });
    let review;
    if (existingReview) {
      review = await tx.updateMonthlyReview({
        householdId,
        reviewId: existingReview.id,
        patch: { status: 'closed', updatedAt: now },
      });
    } else {
      review = await tx.insertMonthlyReview({
        householdId,
        reviewMonth: normalizedPeriod,
        status: 'closed',
        netSurplus: snapshot.spending.netSurplus,
        splitApplied: false,
        distributions: {},
        alertStatus: 'ok',
        notes: null,
      });
    }

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'month.closed',
      entityId: closeRecord.id,
      metadata: { period: normalizedPeriod, version: nextVersion },
    });

    return {
      state: LifecycleState.CLOSED,
      period: normalizedPeriod,
      version: nextVersion,
      closeId: closeRecord.id,
      closedAt: now,
      snapshot,
      bufferDisposition,
      review,
    };
  });
}

// ── Reopen Month ─────────────────────────────────────────────────────────────

export async function reopenMonth({ db, householdId, period, userId, reason = null }) {
  if (!householdId) throw new MonthlyReviewHttpError(400, 'householdId is required');
  requireDbContract(db);
  const normalizedPeriod = normalizePeriod(period);

  return db.transaction(async (tx) => {
    const closes = typeof tx.listMonthCloses === 'function'
      ? await tx.listMonthCloses({ householdId, period: normalizedPeriod })
      : [];

    const latestClose = closes.filter((c) => c.status === 'CLOSED').sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
    if (!latestClose) {
      throw new MonthlyReviewHttpError(409, 'Month is not currently closed. Nothing to reopen.');
    }

    const now = new Date().toISOString();
    await tx.updateMonthClose({
      householdId,
      closeId: latestClose.id,
      patch: {
        status: 'REOPENED',
        reopenedAt: now,
        reopenedBy: userId ?? null,
        reopenReason: reason ?? null,
      },
    });

    // Set monthly_review back to reviewing state
    const existingReview = await tx.getMonthlyReviewByMonth({ householdId, reviewMonth: normalizedPeriod });
    let review;
    if (existingReview) {
      review = await tx.updateMonthlyReview({
        householdId,
        reviewId: existingReview.id,
        patch: { status: 'reviewing', updatedAt: now },
      });
    } else {
      review = await tx.insertMonthlyReview({
        householdId,
        reviewMonth: normalizedPeriod,
        status: 'reviewing',
        netSurplus: '0.00',
        splitApplied: false,
        distributions: {},
        alertStatus: 'ok',
        notes: null,
      });
    }

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'month.reopened',
      entityId: latestClose.id,
      metadata: { period: normalizedPeriod, version: latestClose.version, reason: reason ?? null },
    });

    return {
      state: LifecycleState.REVIEWING,
      period: normalizedPeriod,
      previousCloseId: latestClose.id,
      previousCloseVersion: latestClose.version,
      previousSnapshotPreserved: true,
      review,
    };
  });
}

// ── Buffer Disposition Apply ─────────────────────────────────────────────────

export async function applyBufferDisposition({ db, householdId, period, userId, disposition }) {
  if (!householdId) throw new MonthlyReviewHttpError(400, 'householdId is required');
  requireDbContract(db);
  const normalizedPeriod = normalizePeriod(period);

  const { type, amount, targetId = null } = disposition ?? {};
  const validTypes = ['apply_to_goal', 'apply_to_debt', 'return_to_plan'];
  if (!validTypes.includes(type)) {
    throw new MonthlyReviewHttpError(400, `disposition.type must be one of: ${validTypes.join(', ')}`);
  }

  return db.transaction(async (tx) => {
    // Must not be closed yet
    const closes = typeof tx.listMonthCloses === 'function'
      ? await tx.listMonthCloses({ householdId, period: normalizedPeriod })
      : [];
    if (closes.some((c) => c.status === 'CLOSED')) {
      throw new MonthlyReviewHttpError(409, 'Month is already closed. Disposition must be provided during close.');
    }

    const allocationCategories = await tx.listAllocationCategories({ householdId, asOf: normalizedPeriod });
    const bufferCategory = allocationCategories.find((c) => c.isBuffer === true && c.isActive !== false) ?? null;
    if (!bufferCategory) {
      throw new MonthlyReviewHttpError(422, 'No active buffer allocation found for this workspace.');
    }

    const incomeAllocations = await tx.listIncomeAllocations({ householdId, from: normalizedPeriod, to: normalizedPeriod });
    const transactions = unwrapRows(await tx.listTransactions({ householdId, from: normalizedPeriod, to: normalizedPeriod }));

    const allocatedCents = incomeAllocations
      .filter((a) => (a.allocationCategoryId ?? a.categoryId) === bufferCategory.id)
      .reduce((sum, a) => sum + parseMoneyToCents(a.allocatedAmount ?? a.amount ?? '0.00'), 0);

    const spentCents = transactions
      .filter((t) => t.categoryId === bufferCategory.id && t.direction === 'debit')
      .reduce((sum, t) => sum + Math.abs(parseMoneyToCents(t.amount ?? '0.00')), 0);

    const remainingCents = Math.max(allocatedCents - spentCents, 0);
    if (remainingCents <= 0) {
      return {
        applied: false,
        reason: 'No buffer remaining to dispose.',
        bufferRemaining: '0.00',
      };
    }

    const requestedCents = amount ? parseMoneyToCents(amount) : remainingCents;
    if (requestedCents > remainingCents) {
      throw new MonthlyReviewHttpError(422, `Disposition amount (${formatCents(requestedCents)}) exceeds buffer remaining (${formatCents(remainingCents)}).`);
    }
    if (requestedCents <= 0) {
      throw new MonthlyReviewHttpError(422, 'Disposition amount must be positive.');
    }

    const dispositionAmount = formatCents(requestedCents);
    let appliedAction = null;

    if (type === 'apply_to_goal') {
      if (!targetId) throw new MonthlyReviewHttpError(400, 'targetId (goalId) is required for apply_to_goal disposition.');
      const goal = typeof tx.getGoalById === 'function'
        ? await tx.getGoalById({ householdId, goalId: targetId })
        : null;
      if (!goal || goal.householdId !== householdId) {
        throw new MonthlyReviewHttpError(422, `Goal ${targetId} not found in this workspace.`);
      }
      const goalCategory = goal.bucketId ? allocationCategories.find((c) => c.id === goal.bucketId) ?? null : null;
      const created = await tx.insertTransaction({
        householdId,
        transactionDate: normalizedPeriod,
        description: `Buffer disposition: ${goal.name ?? targetId}`,
        amount: dispositionAmount,
        direction: 'debit',
        categoryId: goalCategory?.id ?? null,
        linkedGoalId: targetId,
        source: 'buffer_disposition',
      });
      appliedAction = { type: 'transaction', id: created.id };
    } else if (type === 'apply_to_debt') {
      if (!targetId) throw new MonthlyReviewHttpError(400, 'targetId (debtId) is required for apply_to_debt disposition.');
      const debt = typeof tx.getDebtById === 'function'
        ? await tx.getDebtById({ householdId, debtId: targetId })
        : null;
      if (!debt || debt.householdId !== householdId) {
        throw new MonthlyReviewHttpError(422, `Debt ${targetId} not found in this workspace.`);
      }
      const debtCategory = allocationCategories.find((c) => c.slug === 'debt_payoff') ?? null;
      const created = await tx.insertTransaction({
        householdId,
        transactionDate: normalizedPeriod,
        description: `Buffer disposition: ${debt.name ?? targetId}`,
        amount: dispositionAmount,
        direction: 'debit',
        categoryId: debtCategory?.id ?? null,
        linkedDebtId: targetId,
        source: 'buffer_disposition',
      });
      await tx.insertDebtPayment({
        householdId,
        debtId: targetId,
        transactionId: created.id,
        paymentDate: normalizedPeriod,
        amount: dispositionAmount,
      });
      appliedAction = { type: 'transaction', id: created.id };
    } else if (type === 'return_to_plan') {
      appliedAction = { type: 'return_to_plan', note: 'Funds remain as general unallocated for next month plan.' };
    }

    await logAuditEvent({
      tx,
      workspaceId: householdId,
      userId,
      event: 'month.buffer_disposition_applied',
      entityId: null,
      metadata: { period: normalizedPeriod, dispositionType: type, targetId: targetId ?? null },
    });

    return {
      applied: true,
      dispositionType: type,
      amount: dispositionAmount,
      bufferRemaining: formatCents(remainingCents),
      appliedAction,
    };
  });
}
