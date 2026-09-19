import crypto from 'node:crypto';

import { Pool } from 'pg';

import { createInMemoryDb } from './inMemoryDb.js';
import { buildAllocationCategoriesRepository } from '../repositories/postgres/allocationCategoriesRepository.js';
import { buildIncomeRepository } from '../repositories/postgres/incomeRepository.js';
import { buildDebtsRepository } from '../repositories/postgres/debtsRepository.js';
import { buildGoalsRepository } from '../repositories/postgres/goalsRepository.js';
import { buildFixedBillsRepository } from '../repositories/postgres/fixedBillsRepository.js';
import { buildImportsRepository } from '../repositories/postgres/importsRepository.js';
import { buildHouseholdRepository } from '../repositories/postgres/householdRepository.js';
import { buildInvitationsRepository } from '../repositories/postgres/invitationsRepository.js';
import { buildWorkspaceActivityRepository } from '../repositories/postgres/workspaceActivityRepository.js';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isoNow() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function toSnake(value) {
  return String(value).replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function rowFromJson(row) {
  const json = row?.raw_json ?? null;
  if (json == null || typeof json !== 'object' || !json.id) return null;
  return json;
}

function diffRows(oldRows, newRows) {
  const oldMap = new Map(oldRows.map((r) => [String(r.id), JSON.stringify(r)]));
  const upserted = [];
  const deleted = [];

  for (const row of newRows) {
    const key = String(row.id);
    const serialized = JSON.stringify(row);
    if (!oldMap.has(key) || oldMap.get(key) !== serialized) {
      upserted.push(row);
    }
    oldMap.delete(key);
  }

  for (const id of oldMap.keys()) {
    deleted.push(id);
  }

  return { upserted, deleted };
}

const TABLES = [
  {
    table: 'app_users',
    stateKey: 'users',
    scope: 'global',
    columns: ['id', 'email', 'password_hash', 'remi_tier', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      email: r.email ?? null,
      password_hash: r.passwordHash ?? null,
      remi_tier: r.remiTier ?? 'free',
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'workspaces',
    stateKey: 'workspaces',
    scope: 'global',
    columns: ['id', 'name', 'type', 'owner_user_id', 'default_currency', 'timezone', 'country', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      name: r.name ?? null,
      type: r.type ?? 'household',
      owner_user_id: r.ownerUserId ?? null,
      default_currency: r.defaultCurrency ?? 'CAD',
      timezone: r.timezone ?? 'America/Toronto',
      country: r.country ?? 'CA',
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'workspace_members',
    stateKey: 'workspaceMembers',
    scope: 'global',
    sortColumn: 'joined_at',
    columns: ['id', 'workspace_id', 'user_id', 'role', 'status', 'joined_at', 'invited_by', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId,
      user_id: r.userId,
      role: r.role ?? 'member',
      status: r.status ?? 'active',
      joined_at: r.joinedAt ?? isoNow(),
      invited_by: r.invitedBy ?? null,
      raw_json: r,
    }),
  },
  {
    table: 'households',
    stateKey: 'households',
    scope: 'global',
    columns: ['id', 'workspace_id', 'owner_user_id', 'name', 'timezone', 'active_month', 'period_start_day', 'savings_floor', 'savings_floor_enabled', 'monthly_essentials_baseline', 'pdf_import_quota_tier', 'pdf_import_quota_expires_at', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.id,
      owner_user_id: r.ownerUserId ?? null,
      name: r.name ?? null,
      timezone: r.timezone ?? 'America/Toronto',
      active_month: r.activeMonth ?? null,
      period_start_day: r.periodStartDay ?? 1,
      savings_floor: r.savingsFloor ?? '0.00',
      savings_floor_enabled: r.savingsFloorEnabled === true,
      monthly_essentials_baseline: r.monthlyEssentialsBaseline ?? '0.00',
      pdf_import_quota_tier: r.pdfImportQuotaTier ?? 'free',
      pdf_import_quota_expires_at: r.pdfImportQuotaExpiresAt ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'allocation_categories',
    stateKey: 'allocationCategories',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'snapshot_id', 'slug', 'label', 'sort_order', 'allocation_percent', 'is_system', 'is_active', 'is_buffer', 'effective_from', 'superseded_at', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      snapshot_id: r.snapshotId ?? r.id,
      slug: r.slug,
      label: r.label,
      sort_order: r.sortOrder ?? 0,
      allocation_percent: r.allocationPercent ?? '0.0000',
      is_system: r.isSystem === true,
      is_active: r.isActive !== false,
      is_buffer: r.isBuffer === true,
      effective_from: r.effectiveFrom ?? '0001-01-01',
      superseded_at: r.supersededAt ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'surplus_split_rules',
    stateKey: 'surplusSplitRules',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'slug', 'label', 'split_percent', 'sort_order', 'is_active', 'destination_type', 'destination_bucket_slug', 'destination_goal_id', 'destination_debt_id', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      slug: r.slug,
      label: r.label,
      split_percent: r.splitPercent ?? '0.0000',
      sort_order: r.sortOrder ?? 0,
      is_active: r.isActive !== false,
      destination_type: r.destinationType ?? 'bucket',
      destination_bucket_slug: r.destinationBucketSlug ?? null,
      destination_goal_id: r.destinationGoalId ?? null,
      destination_debt_id: r.destinationDebtId ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'income_entries',
    stateKey: 'incomeEntries',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'source_name', 'amount', 'received_date', 'notes', 'idempotency_key', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      source_name: r.sourceName,
      amount: r.amount,
      received_date: r.receivedDate,
      notes: r.notes ?? null,
      idempotency_key: r.idempotencyKey ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'income_allocations',
    stateKey: 'incomeAllocations',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'income_entry_id', 'allocation_category_id', 'allocated_amount', 'allocation_percent', 'created_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      income_entry_id: r.incomeEntryId,
      allocation_category_id: r.allocationCategoryId,
      allocated_amount: r.allocatedAmount,
      allocation_percent: r.allocationPercent,
      created_at: r.createdAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'financial_accounts',
    stateKey: 'financialAccounts',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'name', 'account_type', 'institution', 'currency', 'current_balance', 'available_balance', 'balance_as_of', 'is_manual', 'status', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      name: r.name,
      account_type: r.accountType ?? 'checking',
      institution: r.institution ?? null,
      currency: r.currency ?? 'CAD',
      current_balance: r.currentBalance ?? '0.00',
      available_balance: r.availableBalance ?? null,
      balance_as_of: r.balanceAsOf ?? r.updatedAt ?? isoNow(),
      is_manual: r.isManual !== false,
      status: r.status ?? 'active',
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'transactions',
    stateKey: 'transactions',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'account_id', 'transaction_date', 'description', 'merchant', 'amount', 'direction', 'category_id', 'linked_debt_id', 'linked_goal_id', 'import_batch_id', 'source', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      account_id: r.accountId ?? null,
      transaction_date: r.transactionDate,
      description: r.description,
      merchant: r.merchant ?? null,
      amount: r.amount,
      direction: r.direction,
      category_id: r.categoryId ?? null,
      linked_debt_id: r.linkedDebtId ?? null,
      linked_goal_id: r.linkedGoalId ?? null,
      import_batch_id: r.importBatchId ?? null,
      source: r.source ?? 'manual',
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'debts',
    stateKey: 'debts',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'financial_account_id', 'name', 'starting_balance', 'apr', 'minimum_payment', 'monthly_payment', 'sort_order', 'is_active', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      financial_account_id: r.financialAccountId ?? null,
      name: r.name,
      starting_balance: r.startingBalance,
      apr: r.apr ?? '0',
      minimum_payment: r.minimumPayment ?? '0.00',
      monthly_payment: r.monthlyPayment ?? '0.00',
      sort_order: r.sortOrder ?? 0,
      is_active: r.isActive !== false,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'debt_payments',
    stateKey: 'debtPayments',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'debt_id', 'transaction_id', 'payment_date', 'amount', 'created_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      debt_id: r.debtId,
      transaction_id: r.transactionId ?? null,
      payment_date: r.paymentDate,
      amount: r.amount,
      created_at: r.createdAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'debt_payment_pace_acknowledgements',
    stateKey: 'debtPaymentPaceAcknowledgements',
    scope: 'workspace',
    sortColumn: 'acknowledgement_date',
    columns: ['id', 'workspace_id', 'debt_id', 'payment_period_month', 'action', 'acknowledgement_date', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      debt_id: r.debtId,
      payment_period_month: r.paymentPeriodMonth,
      action: r.action,
      acknowledgement_date: r.acknowledgementDate ?? r.createdAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'debt_payment_reconciliations',
    stateKey: 'debtPaymentReconciliations',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'primary_payment_id', 'duplicate_payment_id', 'status', 'match_type', 'confirmed_at', 'confirmed_by', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      primary_payment_id: r.primaryPaymentId,
      duplicate_payment_id: r.duplicatePaymentId,
      status: r.status,
      match_type: r.matchType,
      confirmed_at: r.confirmedAt ?? null,
      confirmed_by: r.confirmedBy ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'debt_adjustments',
    stateKey: 'debtAdjustments',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'debt_id', 'amount', 'adjustment_type', 'effective_date', 'note', 'created_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      debt_id: r.debtId,
      amount: r.amount,
      adjustment_type: r.adjustmentType ?? r.adjustment_type,
      effective_date: r.effectiveDate ?? r.effective_date,
      note: r.note ?? null,
      created_at: r.createdAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'fixed_bills',
    stateKey: 'fixedBills',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'name', 'category_slug', 'expected_amount', 'due_day_of_month', 'active', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      name: r.name,
      category_slug: r.categorySlug ?? r.category_slug,
      expected_amount: r.expectedAmount ?? r.expected_amount,
      due_day_of_month: r.dueDayOfMonth ?? r.due_day_of_month,
      active: r.active !== false,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'goals',
    stateKey: 'goals',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'bucket_id', 'name', 'target_amount', 'target_date', 'notes', 'active', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      bucket_id: r.bucketId,
      name: r.name,
      target_amount: r.targetAmount,
      target_date: r.targetDate ?? null,
      notes: r.notes ?? null,
      active: r.active !== false,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'monthly_reviews',
    stateKey: 'monthlyReviews',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'review_month', 'status', 'net_surplus', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      review_month: r.reviewMonth,
      status: r.status ?? 'draft',
      net_surplus: r.netSurplus ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'monthly_closes',
    stateKey: 'monthlyCloses',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'period', 'version', 'status', 'closed_at', 'closed_by', 'reopened_at', 'reopened_by', 'reopen_reason', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      period: r.period,
      version: r.version ?? 1,
      status: r.status ?? 'CLOSED',
      closed_at: r.closedAt ?? null,
      closed_by: r.closedBy ?? null,
      reopened_at: r.reopenedAt ?? null,
      reopened_by: r.reopenedBy ?? null,
      reopen_reason: r.reopenReason ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'import_batches',
    stateKey: 'importBatches',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'account_id', 'filename', 'source', 'status', 'row_count', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      account_id: r.accountId ?? null,
      filename: r.filename ?? null,
      source: r.source ?? null,
      status: r.status ?? 'pending',
      row_count: r.rowCount ?? 0,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'imported_transaction_rows',
    stateKey: 'importedRows',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'account_id', 'batch_id', 'status', 'parsed_date', 'parsed_amount', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      account_id: r.accountId ?? null,
      batch_id: r.batchId,
      status: r.status ?? 'unreviewed',
      parsed_date: r.parsedDate ?? null,
      parsed_amount: r.parsedAmount ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'imported_transactions',
    stateKey: 'importedTransactions',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'account_id', 'date', 'amount', 'description', 'status', 'classification_type', 'linked_transaction_id', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      account_id: r.accountId ?? null,
      date: r.date,
      amount: r.amount,
      description: r.description,
      status: r.status ?? 'unreviewed',
      classification_type: r.classificationType ?? null,
      linked_transaction_id: r.linkedTransactionId ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'account_reconciliations',
    stateKey: 'accountReconciliations',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'account_id', 'recorded_balance', 'reported_balance', 'discrepancy', 'reported_as_of', 'source', 'status', 'resolved_action', 'note', 'resolved_at', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      account_id: r.accountId,
      recorded_balance: r.recordedBalance,
      reported_balance: r.reportedBalance,
      discrepancy: r.discrepancy,
      reported_as_of: r.reportedAsOf,
      source: r.source ?? 'manual',
      status: r.status ?? 'open',
      resolved_action: r.resolvedAction ?? null,
      note: r.note ?? null,
      resolved_at: r.resolvedAt ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'merchant_rules',
    stateKey: 'merchantRules',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'match_type', 'match_value', 'category_id', 'priority', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      match_type: r.matchType ?? 'contains',
      match_value: r.matchValue ?? null,
      category_id: r.categoryId ?? null,
      priority: r.priority ?? 0,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'import_review_rules',
    stateKey: 'importReviewRules',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'rule_type', 'match_value', 'auto_apply', 'normalized_merchant', 'confirmation_count', 'correction_count', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      rule_type: r.ruleType ?? 'suggestion',
      match_value: r.matchValue ?? r.normalizedDescription ?? null,
      auto_apply: r.autoApply === true,
      normalized_merchant: r.normalizedMerchant ?? null,
      confirmation_count: r.confirmationCount ?? 1,
      correction_count: r.correctionCount ?? 0,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'pdf_import_quotas',
    stateKey: 'pdfImportQuotas',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'year_month', 'count', 'created_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      year_month: r.yearMonth,
      count: r.count ?? 0,
      created_at: r.createdAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'upcoming_expenses',
    stateKey: 'upcomingExpenses',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'name', 'amount', 'expected_date', 'category', 'account_id', 'priority', 'confidence', 'notes', 'status', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      name: r.name,
      amount: r.amount,
      expected_date: r.expectedDate,
      category: r.category ?? null,
      account_id: r.accountId ?? null,
      priority: r.priority ?? 'planned',
      confidence: r.confidence ?? 'confirmed',
      notes: r.notes ?? null,
      status: r.status ?? 'active',
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'remi_conversations',
    stateKey: 'remiConversations',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'user_id', 'title', 'created_at', 'archived_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      user_id: r.userId,
      title: r.title ?? 'New conversation',
      created_at: r.createdAt ?? isoNow(),
      archived_at: r.archivedAt ?? null,
      raw_json: r,
    }),
  },
  {
    table: 'remi_messages',
    stateKey: 'remiMessages',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'conversation_id', 'role', 'content', 'tokens_used', 'created_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      conversation_id: r.conversationId,
      role: r.role,
      content: r.content,
      tokens_used: r.tokensUsed ?? 0,
      created_at: r.createdAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'email_preferences',
    stateKey: 'emailPreferences',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'reminders_enabled', 'preferred_day', 'preferred_hour', 'timezone', 'contact_email', 'created_at', 'updated_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      reminders_enabled: r.remindersEnabled !== false,
      preferred_day: r.preferredDay ?? 'monday',
      preferred_hour: r.preferredHour ?? 9,
      timezone: r.timezone ?? 'America/Toronto',
      contact_email: r.contactEmail ?? null,
      created_at: r.createdAt ?? isoNow(),
      updated_at: r.updatedAt ?? isoNow(),
      raw_json: r,
    }),
  },
  {
    table: 'email_send_log',
    stateKey: 'emailSendLog',
    scope: 'workspace',
    columns: ['id', 'workspace_id', 'reminder_type', 'status', 'sent_at', 'created_at', 'raw_json'],
    toRow: (r) => ({
      id: r.id,
      workspace_id: r.workspaceId ?? r.householdId,
      reminder_type: r.reminderType,
      status: r.status ?? 'sent',
      sent_at: r.sentAt ?? isoNow(),
      created_at: r.createdAt ?? isoNow(),
      raw_json: r,
    }),
  },
];

const POSTGRES_SCHEMA = 'raf';

async function loadState(client) {
  const state = {};
  for (const def of TABLES) {
    const sortCol = def.sortColumn ?? 'created_at';
    const result = await client.query(`select raw_json from ${POSTGRES_SCHEMA}.${def.table} order by ${sortCol} nulls first, id`);
    state[def.stateKey] = result.rows.map(rowFromJson).filter(Boolean);
  }
  return state;
}

async function flushTableDiff(client, def, oldRows, newRows) {
  const { upserted, deleted } = diffRows(oldRows, newRows);
  if (deleted.length) {
    await client.query(`delete from ${POSTGRES_SCHEMA}.${def.table} where id::text = any($1::text[])`, [deleted]);
  }

  for (const row of upserted) {
    const data = def.toRow(row);
    const columns = def.columns;
    const values = columns.map((column) => data[column]);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updates = columns
      .filter((column) => column !== 'id')
      .map((column) => `${column} = excluded.${column}`);
    await client.query(
      `insert into ${POSTGRES_SCHEMA}.${def.table} (${columns.join(', ')})
       values (${placeholders.join(', ')})
       on conflict (id) do update set ${updates.join(', ')}`,
      values,
    );
  }
}

function overlayState(target, source) {
  for (const def of TABLES) {
    target[def.stateKey] = clone(source[def.stateKey] ?? []);
  }
}

function withIdentity(row) {
  const raw = rowFromJson(row);
  if (!raw) return null;
  return {
    ...raw,
    id: raw.id ?? row.id,
    workspaceId: raw.workspaceId ?? row.workspace_id,
    householdId: raw.householdId ?? row.workspace_id,
  };
}

function workspaceIdFromHousehold(householdId) {
  return householdId;
}

async function selectRawByWorkspaceId(client, table, { householdId, idColumn = 'id', id }) {
  const result = await client.query(
    `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.${table} where workspace_id = $1 and ${idColumn} = $2 limit 1`,
    [workspaceIdFromHousehold(householdId), id],
  );
  return withIdentity(result.rows[0]);
}

async function updateRawByWorkspaceId(client, table, { householdId, idColumn = 'id', id, patch, columns }) {
  const existing = await selectRawByWorkspaceId(client, table, { householdId, idColumn, id });
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: isoNow() };
  const def = TABLES.find((entry) => entry.table === table);
  const row = def.toRow(updated);
  const selectedColumns = columns ?? def.columns.filter((column) => column !== 'id');
  const assignments = selectedColumns.map((column, index) => `${column} = $${index + 3}`);
  await client.query(
    `update ${POSTGRES_SCHEMA}.${table} set ${assignments.join(', ')} where workspace_id = $1 and ${idColumn} = $2`,
    [workspaceIdFromHousehold(householdId), id, ...selectedColumns.map((column) => row[column])],
  );
  return clone(updated);
}

function paginateRows(rows, { cursor = null, limit = 50 } = {}) {
  const start = cursor ? rows.findIndex((item) => String(item.id) === String(cursor)) + 1 : 0;
  const slice = rows.slice(Math.max(start, 0), Math.max(start, 0) + limit);
  return {
    items: slice,
    nextCursor: rows.length > Math.max(start, 0) + limit ? slice.at(-1)?.id ?? null : null,
  };
}

function buildDirectTransaction(client) {
  return {
    async setSecurityContext({ userId = null, workspaceId = null, householdId = null } = {}) {
      if (userId) {
        await client.query("select set_config('raf.user_id', $1, true)", [userId]);
      }
      if (workspaceId ?? householdId) {
        await client.query("select set_config('raf.workspace_id', $1, true)", [workspaceId ?? householdId]);
      }
    },
    async getWorkspace({ workspaceId }) {
      const result = await client.query(
        `select id, raw_json from ${POSTGRES_SCHEMA}.workspaces where id = $1 limit 1`,
        [workspaceId],
      );
      return withIdentity(result.rows[0]);
    },
    async getHousehold({ householdId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.households where id = $1 or workspace_id = $1 limit 1`,
        [householdId],
      );
      return withIdentity(result.rows[0]);
    },
    async getUserByEmail({ email }) {
      const result = await client.query(
        `select id, raw_json from ${POSTGRES_SCHEMA}.app_users where lower(email) = lower($1) limit 1`,
        [email],
      );
      return rowFromJson(result.rows[0]);
    },
    async insertBlacklistedToken({ jti, expiresAt }) {
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.token_blacklist (jti, expires_at)
         values ($1, $2)
         on conflict (jti) do update set expires_at = excluded.expires_at`,
        [jti, expiresAt],
      );
      return { id: jti, jti, expiresAt };
    },
    async isTokenBlacklisted({ jti }) {
      const result = await client.query(
        `select exists (
           select 1
           from ${POSTGRES_SCHEMA}.token_blacklist
           where jti = $1 and expires_at > now()
         ) as is_blacklisted`,
        [jti],
      );
      return result.rows[0]?.is_blacklisted === true;
    },
    async cleanupExpiredBlacklistedTokens() {
      const result = await client.query(
        `delete from ${POSTGRES_SCHEMA}.token_blacklist where expires_at <= now()`,
      );
      return result.rowCount ?? 0;
    },
    async logWorkspaceActivity({ workspaceId, actorUserId, action, entityType = null, entityId = null, metadata = {} }) {
      const now = isoNow();
      const row = {
        id: uuid(),
        workspaceId,
        actorUserId: actorUserId ?? null,
        action,
        entityType,
        entityId: entityId ? String(entityId) : null,
        metadata,
        createdAt: now,
      };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.workspace_activity
         (id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.id, workspaceId, row.actorUserId, action, entityType, row.entityId, metadata, now],
      );
      return clone(row);
    },
    async listWorkspacesForUser({ userId }) {
      const result = await client.query(
        `select w.id, w.raw_json, wm.role, wm.status
         from ${POSTGRES_SCHEMA}.workspace_members wm
         join ${POSTGRES_SCHEMA}.workspaces w on w.id = wm.workspace_id
         where wm.user_id = $1 and wm.status = 'active'
         order by w.created_at nulls first, w.id`,
        [userId],
      );
      return result.rows.map((row) => ({ ...withIdentity(row), role: row.role, status: row.status })).filter(Boolean);
    },
    async getUserWorkspaceAccess({ userId, workspaceId }) {
      const result = await client.query(
        `select wm.id, wm.workspace_id, wm.user_id, wm.role, wm.status, wm.invited_by, wm.joined_at, wm.raw_json
         from ${POSTGRES_SCHEMA}.workspace_members wm
         where wm.user_id = $1 and wm.workspace_id = $2 and wm.status = 'active'
         limit 1`,
        [userId, workspaceId],
      );
      return withIdentity(result.rows[0]);
    },
    async createWorkspaceMember({ workspaceId, userId, role = 'member', status = 'active', invitedBy = null }) {
      const now = isoNow();
      const row = { id: uuid(), workspaceId, householdId: workspaceId, userId, role, status, joinedAt: now, invitedBy };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.workspace_members (id, workspace_id, user_id, role, status, joined_at, invited_by, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.id, workspaceId, userId, role, status, now, invitedBy, row],
      );
      return clone(row);
    },
    async listWorkspaceMembers({ workspaceId }) {
      const result = await client.query(
        `select wm.id, wm.workspace_id, wm.user_id, wm.role, wm.status, wm.joined_at, wm.invited_by, wm.raw_json,
                u.email, u.raw_json as user_raw_json
         from ${POSTGRES_SCHEMA}.workspace_members wm
         left join ${POSTGRES_SCHEMA}.app_users u on u.id = wm.user_id
         where wm.workspace_id = $1
         order by wm.joined_at nulls first, wm.user_id`,
        [workspaceId],
      );
      return result.rows.map((row) => ({
        ...withIdentity(row),
        email: row.email ?? row.user_raw_json?.email ?? null,
        name: row.user_raw_json?.name ?? null,
      }));
    },
    async getWorkspaceMember({ workspaceId, userId }) {
      const rows = await this.listWorkspaceMembers({ workspaceId });
      return rows.find((row) => row.userId === userId) ?? null;
    },
    async updateWorkspaceMember({ workspaceId, userId, patch }) {
      const existing = await this.getWorkspaceMember({ workspaceId, userId });
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      await client.query(
        `update ${POSTGRES_SCHEMA}.workspace_members
         set role = $3, status = $4, invited_by = $5, raw_json = $6
         where workspace_id = $1 and user_id = $2`,
        [workspaceId, userId, updated.role, updated.status, updated.invitedBy ?? null, updated],
      );
      return clone(updated);
    },
    async removeWorkspaceMember({ workspaceId, userId }) {
      await client.query(
        `delete from ${POSTGRES_SCHEMA}.workspace_members where workspace_id = $1 and user_id = $2`,
        [workspaceId, userId],
      );
      await client.query(
        `delete from ${POSTGRES_SCHEMA}.user_households where workspace_id = $1 and user_id = $2`,
        [workspaceId, userId],
      ).catch(() => null);
    },
    async updateWorkspaceOwner({ workspaceId, newOwnerUserId }) {
      const workspace = await this.getWorkspace({ workspaceId });
      const updated = { ...workspace, ownerUserId: newOwnerUserId, updatedAt: isoNow() };
      await client.query(
        `update ${POSTGRES_SCHEMA}.workspaces set owner_user_id = $2, updated_at = $3, raw_json = $4 where id = $1`,
        [workspaceId, newOwnerUserId, updated.updatedAt, updated],
      );
      await client.query(
        `update ${POSTGRES_SCHEMA}.households set owner_user_id = $2, updated_at = $3 where workspace_id = $1`,
        [workspaceId, newOwnerUserId, updated.updatedAt],
      ).catch(() => null);
    },
    async deleteWorkspaceById({ workspaceId, requestingUserId }) {
      const membership = await this.getWorkspaceMember({ workspaceId, userId: requestingUserId });
      if (!membership || membership.role !== 'owner') {
        return false;
      }

      await client.query(
        `delete from ${POSTGRES_SCHEMA}.workspaces where id = $1 and owner_user_id = $2`,
        [workspaceId, requestingUserId],
      );
      return true;
    },
    async insertFinancialAccount(payload) {
      const now = isoNow();
      const row = { id: payload.id ?? uuid(), createdAt: now, updatedAt: now, ...payload, workspaceId: payload.workspaceId ?? payload.householdId, householdId: payload.householdId ?? payload.workspaceId };
      const def = TABLES.find((entry) => entry.table === 'financial_accounts');
      const data = def.toRow(row);
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.financial_accounts (${def.columns.join(', ')})
         values (${def.columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        def.columns.map((column) => data[column]),
      );
      return clone(row);
    },
    async listFinancialAccounts({ householdId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.financial_accounts where workspace_id = $1 order by name, id`,
        [workspaceIdFromHousehold(householdId)],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async getFinancialAccountById({ householdId, accountId }) {
      return selectRawByWorkspaceId(client, 'financial_accounts', { householdId, id: accountId });
    },
    async updateFinancialAccount({ householdId, accountId, patch }) {
      return updateRawByWorkspaceId(client, 'financial_accounts', { householdId, id: accountId, patch });
    },
    async insertAccountReconciliation(payload) {
      const now = isoNow();
      const row = { id: payload.id ?? uuid(), createdAt: now, updatedAt: now, ...payload, workspaceId: payload.workspaceId ?? payload.householdId, householdId: payload.householdId ?? payload.workspaceId };
      const def = TABLES.find((entry) => entry.table === 'account_reconciliations');
      const data = def.toRow(row);
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.account_reconciliations (${def.columns.join(', ')})
         values (${def.columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        def.columns.map((column) => data[column]),
      );
      return clone(row);
    },
    async listAccountReconciliations({ householdId, accountId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.account_reconciliations
         where workspace_id = $1 and account_id = $2
         order by reported_as_of desc, created_at desc, id`,
        [workspaceIdFromHousehold(householdId), accountId],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async getAccountReconciliationById({ householdId, accountId, reconciliationId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.account_reconciliations
         where workspace_id = $1 and account_id = $2 and id = $3 limit 1`,
        [workspaceIdFromHousehold(householdId), accountId, reconciliationId],
      );
      return withIdentity(result.rows[0]);
    },
    async updateAccountReconciliation({ householdId, accountId, reconciliationId, patch }) {
      const existing = await this.getAccountReconciliationById({ householdId, accountId, reconciliationId });
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: isoNow() };
      const def = TABLES.find((entry) => entry.table === 'account_reconciliations');
      const data = def.toRow(updated);
      const columns = def.columns.filter((column) => column !== 'id');
      await client.query(
        `update ${POSTGRES_SCHEMA}.account_reconciliations
         set ${columns.map((column, index) => `${column} = $${index + 4}`).join(', ')}
         where workspace_id = $1 and account_id = $2 and id = $3`,
        [workspaceIdFromHousehold(householdId), accountId, reconciliationId, ...columns.map((column) => data[column])],
      );
      return clone(updated);
    },
    async insertTransaction(payload) {
      const now = isoNow();
      const row = { id: payload.id ?? uuid(), createdAt: now, updatedAt: now, ...payload, workspaceId: payload.workspaceId ?? payload.householdId, householdId: payload.householdId ?? payload.workspaceId };
      const def = TABLES.find((entry) => entry.table === 'transactions');
      const data = def.toRow(row);
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.transactions (${def.columns.join(', ')})
         values (${def.columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        def.columns.map((column) => data[column]),
      );
      return clone(row);
    },
    async listTransactions({ householdId, from, to, accountId = null, categoryId = null, categoryIds = null, direction = null, reviewed = null, cursor = null, limit = 50 }) {
      const params = [workspaceIdFromHousehold(householdId), from, to];
      const filters = ['workspace_id = $1', 'transaction_date >= $2', 'transaction_date <= $3'];
      if (accountId) {
        params.push(accountId);
        filters.push(`account_id = $${params.length}`);
      }
      if (categoryId) {
        params.push(categoryId);
        filters.push(`category_id = $${params.length}`);
      }
      if (Array.isArray(categoryIds) && categoryIds.length > 0) {
        params.push(categoryIds);
        filters.push(`category_id = any($${params.length}::uuid[])`);
      }
      if (direction) {
        params.push(direction);
        filters.push(`direction = $${params.length}`);
      }
      if (reviewed === false) {
        filters.push('reviewed_at IS NULL');
      } else if (reviewed === true) {
        filters.push('reviewed_at IS NOT NULL');
      }
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.transactions
         where ${filters.join(' and ')}
         order by transaction_date, id`,
        params,
      );
      return paginateRows(result.rows.map(withIdentity).filter(Boolean), { cursor, limit });
    },
    async getTransactionById({ householdId, transactionId }) {
      return selectRawByWorkspaceId(client, 'transactions', { householdId, id: transactionId });
    },
    async updateTransaction({ householdId, transactionId, patch }) {
      return updateRawByWorkspaceId(client, 'transactions', { householdId, id: transactionId, patch });
    },
    async markTransactionReviewed({ householdId, transactionId, reviewedAt, reviewedBy }) {
      return updateRawByWorkspaceId(client, 'transactions', {
        householdId,
        id: transactionId,
        patch: { reviewedAt, reviewedBy },
        columns: ['reviewed_at', 'reviewed_by', 'updated_at', 'raw_json'],
      });
    },
    async markTransactionUnreviewed({ householdId, transactionId }) {
      return updateRawByWorkspaceId(client, 'transactions', {
        householdId,
        id: transactionId,
        patch: { reviewedAt: null, reviewedBy: null },
        columns: ['reviewed_at', 'reviewed_by', 'updated_at', 'raw_json'],
      });
    },
    async bulkMarkTransactionsReviewed({ householdId, transactionIds, reviewedAt, reviewedBy }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();
      const patch = { reviewedAt, reviewedBy: reviewedBy ?? null, updatedAt: now };
      await client.query(
        `update ${POSTGRES_SCHEMA}.transactions
         set reviewed_at = $3,
             reviewed_by = $4,
             updated_at = $5,
             raw_json = raw_json || $6::jsonb
         where workspace_id = $1 and id = any($2::uuid[])`,
        [wsId, transactionIds, reviewedAt, reviewedBy ?? null, now, JSON.stringify(patch)],
      );
    },
    async deleteTransaction({ householdId, transactionId }) {
      await client.query(
        `delete from ${POSTGRES_SCHEMA}.transactions where workspace_id = $1 and id = $2`,
        [workspaceIdFromHousehold(householdId), transactionId],
      );
    },
    async insertTransactionSplit({ householdId, transactionId, amount, categoryId, description }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();
      const id = uuid();
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.transaction_splits
         (id, workspace_id, transaction_id, amount, category_id, description, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, wsId, transactionId, amount, categoryId ?? null, description ?? '', now, now],
      );
      return { id, workspaceId: wsId, transactionId, amount, categoryId: categoryId ?? null, description: description ?? '', createdAt: now, updatedAt: now };
    },
    async listTransactionSplits({ householdId, transactionId = null }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const params = [wsId];
      const filters = ['workspace_id = $1'];
      if (transactionId) {
        params.push(transactionId);
        filters.push(`transaction_id = $${params.length}`);
      }
      const result = await client.query(
        `select id, workspace_id, transaction_id, amount, category_id, description, created_at, updated_at
         from ${POSTGRES_SCHEMA}.transaction_splits
         where ${filters.join(' and ')}
         order by created_at, id`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        transactionId: row.transaction_id,
        amount: row.amount,
        categoryId: row.category_id,
        description: row.description,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    async deleteTransactionSplits({ householdId, transactionId }) {
      await client.query(
        `delete from ${POSTGRES_SCHEMA}.transaction_splits where workspace_id = $1 and transaction_id = $2`,
        [workspaceIdFromHousehold(householdId), transactionId],
      );
    },
    async deleteDebtPaymentByTransactionId({ householdId, transactionId }) {
      await client.query(
        `delete from ${POSTGRES_SCHEMA}.debt_payments where workspace_id = $1 and transaction_id = $2`,
        [workspaceIdFromHousehold(householdId), transactionId],
      );
    },
    async insertDebtPayment(payload) {
      const row = { id: payload.id ?? uuid(), createdAt: isoNow(), ...payload, workspaceId: payload.workspaceId ?? payload.householdId, householdId: payload.householdId ?? payload.workspaceId };
      const def = TABLES.find((entry) => entry.table === 'debt_payments');
      const data = def.toRow(row);
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.debt_payments (${def.columns.join(', ')})
         values (${def.columns.map((_, index) => `$${index + 1}`).join(', ')})
         on conflict do nothing`,
        def.columns.map((column) => data[column]),
      );
      return clone(row);
    },

    // --- Month Lifecycle (Wave C) ---

    async insertMonthClose(payload) {
      const wsId = workspaceIdFromHousehold(payload.householdId ?? payload.workspaceId);
      const id = payload.id ?? uuid();
      const now = isoNow();
      const row = {
        id,
        workspace_id: wsId,
        period: payload.period,
        version: payload.version ?? 1,
        status: payload.status ?? 'CLOSED',
        closed_at: payload.closedAt ?? now,
        closed_by: payload.closedBy ?? null,
        reopened_at: payload.reopenedAt ?? null,
        reopened_by: payload.reopenedBy ?? null,
        reopen_reason: payload.reopenReason ?? null,
        created_at: now,
        updated_at: now,
        raw_json: {
          ...payload,
          id,
          workspaceId: wsId,
          householdId: wsId,
          createdAt: now,
          updatedAt: now,
        },
      };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.monthly_closes
         (id, workspace_id, period, version, status, closed_at, closed_by,
          reopened_at, reopened_by, reopen_reason, created_at, updated_at, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [row.id, row.workspace_id, row.period, row.version, row.status,
         row.closed_at, row.closed_by, row.reopened_at, row.reopened_by,
         row.reopen_reason, row.created_at, row.updated_at, row.raw_json],
      );
      return clone(row.raw_json);
    },

    async listMonthCloses({ householdId, period }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.monthly_closes
         where workspace_id = $1 and period = $2
         order by version asc, created_at asc`,
        [wsId, period],
      );
      return result.rows.map((r) => r.raw_json).filter(Boolean);
    },

    async getMonthCloseById({ householdId, closeId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.monthly_closes
         where workspace_id = $1 and id = $2 limit 1`,
        [wsId, closeId],
      );
      return result.rows[0]?.raw_json ?? null;
    },

    async updateMonthClose({ householdId, closeId, patch }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.monthly_closes
         where workspace_id = $1 and id = $2 limit 1`,
        [wsId, closeId],
      );
      const existing = result.rows[0]?.raw_json ?? null;
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: isoNow() };
      const columns = ['status', 'reopened_at', 'reopened_by', 'reopen_reason', 'updated_at', 'raw_json'];
      await client.query(
        `update ${POSTGRES_SCHEMA}.monthly_closes
         set status = $3, reopened_at = $4, reopened_by = $5, reopen_reason = $6, updated_at = $7, raw_json = $8
         where workspace_id = $1 and id = $2`,
        [wsId, closeId,
         updated.status ?? existing.status,
         updated.reopenedAt ?? null,
         updated.reopenedBy ?? null,
         updated.reopenReason ?? null,
         updated.updatedAt,
         updated],
      );
      return clone(updated);
    },

    // --- Auth / user-lifecycle domain (Branch D Phase 1) ---

    async getUserById({ userId }) {
      const result = await client.query(
        `select id, raw_json from ${POSTGRES_SCHEMA}.app_users where id = $1 limit 1`,
        [userId],
      );
      return rowFromJson(result.rows[0]);
    },

    async createUser({ id = null, email, passwordHash = null, externalAuthProvider = null, externalAuthUserId = null }) {
      const normalizedEmail = String(email ?? '').trim().toLowerCase();
      if (!normalizedEmail) throw new Error('EMAIL_REQUIRED');
      const existing = await client.query(
        `select id from ${POSTGRES_SCHEMA}.app_users where lower(email) = lower($1) limit 1`,
        [normalizedEmail],
      );
      if (existing.rows.length > 0) throw new Error('EMAIL_TAKEN');
      const now = isoNow();
      const row = { id: id ?? uuid(), email: normalizedEmail, passwordHash, externalAuthProvider, externalAuthUserId, createdAt: now, updatedAt: now };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.app_users (id, email, password_hash, created_at, updated_at, raw_json)
         values ($1, $2, $3, $4, $5, $6)`,
        [row.id, row.email, row.passwordHash, row.createdAt, row.updatedAt, row],
      );
      return clone(row);
    },

    async createWorkspaceRecord({ id = null, ownerUserId, name, type = 'household', defaultCurrency = 'CAD', timezone = 'America/Toronto', country = 'CA' }) {
      const now = isoNow();
      const workspaceId = id ?? uuid();
      const workspace = {
        id: workspaceId,
        ownerUserId,
        name: name ?? 'My Household',
        type,
        defaultCurrency,
        timezone,
        country,
        activeMonth: '2026-03-01',
        periodStartDay: 1,
        savingsFloor: '0.00',
        savingsFloorEnabled: false,
        monthlyEssentialsBaseline: '2000.00',
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.workspaces (id, name, type, owner_user_id, default_currency, timezone, country, created_at, updated_at, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [workspaceId, workspace.name, workspace.type, ownerUserId, defaultCurrency, timezone, country, now, now, workspace],
      );
      return clone(workspace);
    },

    async initializeWorkspaceDefaults({ workspace }) {
      const now = isoNow();
      const workspaceId = workspace.id;
      const timezone = workspace.timezone ?? 'America/Toronto';
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.households
         (id, workspace_id, owner_user_id, name, timezone, active_month, period_start_day, savings_floor, savings_floor_enabled, monthly_essentials_baseline, pdf_import_quota_tier, pdf_import_quota_expires_at, created_at, updated_at, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [workspaceId, workspaceId, workspace.ownerUserId, workspace.name, timezone, workspace.activeMonth, workspace.periodStartDay, workspace.savingsFloor, workspace.savingsFloorEnabled, workspace.monthlyEssentialsBaseline, 'free', null, now, now, workspace],
      );
      const snapshotId = uuid();
      const effectiveFrom = '2026-01-01';
      const allocCats = [
        { slug: 'savings', label: 'Savings', sortOrder: 1, allocationPercent: '0.1000', isSystem: true, isBuffer: false },
        { slug: 'fixed_bills', label: 'Fixed Bills', sortOrder: 2, allocationPercent: '0.3000', isSystem: true, isBuffer: false },
        { slug: 'personal_spending', label: 'Personal Spending', sortOrder: 3, allocationPercent: '0.1500', isSystem: true, isBuffer: false },
        { slug: 'investment', label: 'Investment', sortOrder: 4, allocationPercent: '0.1000', isSystem: false, isBuffer: false },
        { slug: 'debt_payoff', label: 'Debt Payoff', sortOrder: 5, allocationPercent: '0.1000', isSystem: false, isBuffer: false },
        { slug: 'partnership', label: 'Partnership', sortOrder: 6, allocationPercent: '0.1500', isSystem: false, isBuffer: false },
        { slug: 'buffer', label: 'Buffer', sortOrder: 9, allocationPercent: '0.1000', isSystem: true, isBuffer: true },
      ];
      for (const cat of allocCats) {
        const row = { id: uuid(), workspaceId, householdId: workspaceId, snapshotId, effectiveFrom, supersededAt: null, isActive: true, createdAt: now, updatedAt: now, ...cat };
        await client.query(
          `insert into ${POSTGRES_SCHEMA}.allocation_categories
           (id, workspace_id, snapshot_id, slug, label, sort_order, allocation_percent, is_system, is_active, is_buffer, effective_from, superseded_at, created_at, updated_at, raw_json)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [row.id, workspaceId, snapshotId, cat.slug, cat.label, cat.sortOrder, cat.allocationPercent, cat.isSystem, true, cat.isBuffer, effectiveFrom, null, now, now, row],
        );
      }
      const surplusRules = [
        { slug: 'emergency_fund', label: 'Savings', splitPercent: '0.4000', sortOrder: 1, destinationBucketSlug: 'savings' },
        { slug: 'extra_debt_payoff', label: 'Debt Payoff', splitPercent: '0.4000', sortOrder: 2, destinationBucketSlug: 'debt_payoff' },
        { slug: 'investment', label: 'Investment', splitPercent: '0.2000', sortOrder: 3, destinationBucketSlug: 'investment' },
      ];
      for (const rule of surplusRules) {
        const row = { id: uuid(), workspaceId, householdId: workspaceId, isActive: true, destinationType: 'bucket', destinationGoalId: null, destinationDebtId: null, createdAt: now, updatedAt: now, ...rule };
        await client.query(
          `insert into ${POSTGRES_SCHEMA}.surplus_split_rules
           (id, workspace_id, slug, label, split_percent, sort_order, is_active, destination_type, destination_bucket_slug, destination_goal_id, destination_debt_id, created_at, updated_at, raw_json)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [row.id, workspaceId, rule.slug, rule.label, rule.splitPercent, rule.sortOrder, true, 'bucket', rule.destinationBucketSlug, null, null, now, now, row],
        );
      }
      return clone(workspace);
    },

    async createWorkspace({ ownerUserId, name, type = 'household', defaultCurrency = 'CAD', timezone = 'America/Toronto', country = 'CA' }) {
      const workspace = await this.createWorkspaceRecord({ ownerUserId, name, type, defaultCurrency, timezone, country });
      await this.initializeWorkspaceDefaults({ workspace });
      return workspace;
    },

    async createHousehold({ ownerUserId, name, type = 'household', defaultCurrency = 'CAD', timezone = 'America/Toronto', country = 'CA' }) {
      return this.createWorkspace({ ownerUserId, name, type, defaultCurrency, timezone, country });
    },

    async createUserHousehold({ userId, householdId, role = 'member', status = 'active', invitedBy = null }) {
      return this.createWorkspaceMember({ workspaceId: householdId, userId, role, status, invitedBy });
    },

    async listHouseholdsForUser({ userId }) {
      return this.listWorkspacesForUser({ userId });
    },

    // --- Financial domain repositories (Branch D Phase 2+) ---
    ...buildAllocationCategoriesRepository(client, POSTGRES_SCHEMA),
    ...buildIncomeRepository(client, POSTGRES_SCHEMA),
    ...buildDebtsRepository(client, POSTGRES_SCHEMA),
    ...buildGoalsRepository(client, POSTGRES_SCHEMA),
    ...buildFixedBillsRepository(client, POSTGRES_SCHEMA),
    ...buildImportsRepository(client, POSTGRES_SCHEMA),
    ...buildHouseholdRepository(client, POSTGRES_SCHEMA),
    ...buildInvitationsRepository(client, POSTGRES_SCHEMA),
    ...buildWorkspaceActivityRepository(client, POSTGRES_SCHEMA),
    async listImportBatches({ householdId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.import_batches
         where workspace_id = $1
         order by created_at desc, id desc`,
        [workspaceIdFromHousehold(householdId)],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async listImportedRowsForBatches({ householdId, batchIds }) {
      if (!Array.isArray(batchIds) || batchIds.length === 0) return [];
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.imported_transaction_rows
         where workspace_id = $1 and batch_id = any($2::uuid[])
         order by created_at, id`,
        [workspaceIdFromHousehold(householdId), batchIds],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async listTransactionsByImportBatchIds({ householdId, batchIds }) {
      if (!Array.isArray(batchIds) || batchIds.length === 0) return [];
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.transactions
         where workspace_id = $1 and import_batch_id = any($2::uuid[])
         order by transaction_date, id`,
        [workspaceIdFromHousehold(householdId), batchIds],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async listAccountReconciliationsForAccounts({ householdId, accountIds }) {
      if (!Array.isArray(accountIds) || accountIds.length === 0) return [];
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.account_reconciliations
         where workspace_id = $1 and account_id = any($2::uuid[])
         order by reported_as_of desc, created_at desc, id`,
        [workspaceIdFromHousehold(householdId), accountIds],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async listImportedTransactions({ householdId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.imported_transactions
         where workspace_id = $1
         order by date, id`,
        [workspaceIdFromHousehold(householdId)],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async listImportedRows({ householdId, batchId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.imported_transaction_rows
         where workspace_id = $1 and batch_id = $2
         order by created_at, id`,
        [workspaceIdFromHousehold(householdId), batchId],
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },

    async listUpcomingExpenses({ householdId, status = null }) {
      const params = [workspaceIdFromHousehold(householdId)];
      const filters = ['workspace_id = $1'];
      if (status) {
        params.push(status);
        filters.push(`status = $${params.length}`);
      }
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.upcoming_expenses
         where ${filters.join(' and ')}
         order by expected_date, id`,
        params,
      );
      return result.rows.map(withIdentity).filter(Boolean);
    },
    async insertUpcomingExpense(payload) {
      const now = isoNow();
      const row = {
        id: payload.id ?? uuid(),
        createdAt: now,
        updatedAt: now,
        ...payload,
        workspaceId: payload.workspaceId ?? payload.householdId,
        householdId: payload.householdId ?? payload.workspaceId,
      };
      const def = TABLES.find((entry) => entry.table === 'upcoming_expenses');
      const data = def.toRow(row);
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.upcoming_expenses (${def.columns.join(', ')})
         values (${def.columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        def.columns.map((column) => data[column]),
      );
      return clone(row);
    },
    async getUpcomingExpenseById({ householdId, expenseId }) {
      const result = await client.query(
        `select id, workspace_id, raw_json from ${POSTGRES_SCHEMA}.upcoming_expenses
         where workspace_id = $1 and id = $2
         limit 1`,
        [workspaceIdFromHousehold(householdId), expenseId],
      );
      return withIdentity(result.rows[0]);
    },
    async updateUpcomingExpense({ householdId, expenseId, patch }) {
      const existing = await this.getUpcomingExpenseById({ householdId, expenseId });
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: isoNow() };
      const def = TABLES.find((entry) => entry.table === 'upcoming_expenses');
      const data = def.toRow(updated);
      const columns = def.columns.filter((column) => column !== 'id');
      await client.query(
        `update ${POSTGRES_SCHEMA}.upcoming_expenses
         set ${columns.map((column, index) => `${column} = $${index + 3}`).join(', ')}
         where workspace_id = $1 and id = $2`,
        [workspaceIdFromHousehold(householdId), expenseId, ...columns.map((column) => data[column])],
      );
      return clone(updated);
    },
    async deleteUpcomingExpense({ householdId, expenseId }) {
      await client.query(
        `delete from ${POSTGRES_SCHEMA}.upcoming_expenses
         where workspace_id = $1 and id = $2`,
        [workspaceIdFromHousehold(householdId), expenseId],
      );
      return true;
    },
    async getAccountFreshnessContext({ householdId }) {
      const workspaceId = workspaceIdFromHousehold(householdId);

      // Latest import batch per account
      const importResult = await client.query(
        `select distinct on (account_id) account_id, created_at as latest_import_at
         from ${POSTGRES_SCHEMA}.import_batches
         where workspace_id = $1
         order by account_id, created_at desc`,
        [workspaceId],
      );
      const importBatches = importResult.rows.map((row) => ({
        accountId: row.account_id,
        latestImportAt: row.latest_import_at,
      }));

      // Latest resolved reconciliation per account
      const reconResult = await client.query(
        `select distinct on (account_id) account_id, resolved_at
         from ${POSTGRES_SCHEMA}.account_reconciliations
         where workspace_id = $1 and status = 'resolved'
         order by account_id, resolved_at desc`,
        [workspaceId],
      );
      const acceptedReconciliations = reconResult.rows.map((row) => ({
        accountId: row.account_id,
        reconciledAt: row.resolved_at,
      }));

      // Count unreviewedimported rows
      const unreviewedResult = await client.query(
        `select count(*) as count
         from ${POSTGRES_SCHEMA}.imported_transaction_rows
         where workspace_id = $1 and status = 'pending_review'`,
        [workspaceId],
      );
      const unreviewedImportCount = parseInt(unreviewedResult.rows[0]?.count ?? '0', 10);

      return {
        importBatches,
        acceptedReconciliations,
        unreviewedImportCount,
      };
    },

    // ── Phase 2B: monthly lifecycle race fix ─────────────────────────────────
    // Atomically transitions a monthly review to 'reviewing', conditional on no
    // CLOSED month-close record for the same period. The NOT EXISTS subquery is
    // evaluated at statement execution time under READ COMMITTED isolation, so
    // it sees all committed data — including a concurrent closeMonth that
    // committed after the caller's read. Correct without the hybrid adapter.
    // Returns { blocked: true } if a CLOSED record exists.
    // Returns { blocked: false, review } on success.
    async transitionMonthlyReviewToReviewing({ householdId, period, insertPayload }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();

      const updateResult = await client.query(
        `update ${POSTGRES_SCHEMA}.monthly_reviews
         set status = 'reviewing',
             updated_at = $3,
             raw_json = raw_json || $4::jsonb
         where workspace_id = $1
           and review_month = $2
           and not exists (
             select 1 from ${POSTGRES_SCHEMA}.monthly_closes
             where workspace_id = $1 and period = $2 and status = 'CLOSED'
           )
         returning raw_json`,
        [wsId, period, now, JSON.stringify({ status: 'reviewing', updatedAt: now })],
      );
      if (updateResult.rows.length > 0) {
        return { blocked: false, review: updateResult.rows[0].raw_json };
      }

      const closeCheck = await client.query(
        `select 1 from ${POSTGRES_SCHEMA}.monthly_closes
         where workspace_id = $1 and period = $2 and status = 'CLOSED'
         limit 1`,
        [wsId, period],
      );
      if (closeCheck.rows.length > 0) return { blocked: true };

      const id = uuid();
      const base = {
        id,
        householdId: wsId,
        workspaceId: wsId,
        reviewMonth: period,
        status: 'reviewing',
        netSurplus: insertPayload?.netSurplus ?? '0.00',
        splitApplied: insertPayload?.splitApplied ?? false,
        distributions: insertPayload?.distributions ?? {},
        alertStatus: insertPayload?.alertStatus ?? 'ok',
        notes: insertPayload?.notes ?? null,
        createdAt: now,
        updatedAt: now,
      };
      const insertResult = await client.query(
        `insert into ${POSTGRES_SCHEMA}.monthly_reviews
         (id, workspace_id, review_month, status, net_surplus, created_at, updated_at, raw_json)
         select $1, $2, $3, 'reviewing', $4, $5, $6, $7::jsonb
         where not exists (
           select 1 from ${POSTGRES_SCHEMA}.monthly_closes
           where workspace_id = $2 and period = $3 and status = 'CLOSED'
         )
         returning raw_json`,
        [id, wsId, period, base.netSurplus ?? null, now, now, JSON.stringify(base)],
      );
      if (insertResult.rows.length === 0) return { blocked: true };
      return { blocked: false, review: insertResult.rows[0].raw_json };
    },

    // ── Phase 2C: monthly review P0 migrations ───────────────────────────────

    async getMonthlyReviewByMonth({ householdId, reviewMonth }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.monthly_reviews
         where workspace_id = $1 and review_month = $2
         limit 1`,
        [wsId, reviewMonth],
      );
      return result.rows[0]?.raw_json ?? null;
    },

    async getMonthlyReviewById({ householdId, reviewId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.monthly_reviews
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, reviewId],
      );
      return result.rows[0]?.raw_json ?? null;
    },

    async listMonthlyReviews({ householdId, from, to } = {}) {
      const wsId = workspaceIdFromHousehold(householdId);
      const params = [wsId];
      const filters = ['workspace_id = $1'];
      if (from != null) { params.push(from); filters.push(`review_month >= $${params.length}`); }
      if (to != null) { params.push(to); filters.push(`review_month <= $${params.length}`); }
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.monthly_reviews
         where ${filters.join(' and ')}
         order by review_month asc`,
        params,
      );
      return result.rows.map((r) => r.raw_json).filter(Boolean);
    },

    async insertMonthlyReview(payload) {
      const wsId = workspaceIdFromHousehold(payload.householdId ?? payload.workspaceId);
      const id = payload.id ?? uuid();
      const now = isoNow();
      const row = {
        id,
        householdId: wsId,
        workspaceId: wsId,
        ...payload,
        status: payload.status ?? 'draft',
        netSurplus: payload.netSurplus ?? '0.00',
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.monthly_reviews
         (id, workspace_id, review_month, status, net_surplus, created_at, updated_at, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, wsId, row.reviewMonth, row.status, row.netSurplus ?? null, now, now, row],
      );
      return clone(row);
    },

    async updateMonthlyReview({ householdId, reviewId, patch }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const existing = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.monthly_reviews
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, reviewId],
      );
      const row = existing.rows[0]?.raw_json ?? null;
      if (!row) return null;
      const updated = { ...row, ...patch, updatedAt: isoNow() };
      await client.query(
        `update ${POSTGRES_SCHEMA}.monthly_reviews
         set status = $3, net_surplus = $4, updated_at = $5, raw_json = $6
         where workspace_id = $1 and id = $2`,
        [wsId, reviewId, updated.status ?? row.status, updated.netSurplus ?? null, updated.updatedAt, updated],
      );
      return clone(updated);
    },

    async deleteMonthlyReview({ householdId, reviewId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      await client.query(
        `delete from ${POSTGRES_SCHEMA}.monthly_reviews
         where workspace_id = $1 and id = $2`,
        [wsId, reviewId],
      );
    },

    // ── Phase 2D: import P0 mutations ────────────────────────────────────────

    async getImportBatch({ householdId, batchId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.import_batches
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, batchId],
      );
      return result.rows[0]?.raw_json ?? null;
    },

    // expectedStatus: when provided, the UPDATE is a conditional write.
    // Returns null if the current status doesn't match (F2 guard).
    async updateImportBatch({ householdId, batchId, status, rowCount, expectedStatus }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();
      const existing = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.import_batches
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, batchId],
      );
      const row = existing.rows[0]?.raw_json ?? null;
      if (!row) return null;
      const updated = { ...row, status: status ?? row.status, rowCount: rowCount ?? row.rowCount, updatedAt: now };
      const params = [wsId, batchId, updated.status, updated.rowCount ?? 0, now, updated];
      let sql;
      if (expectedStatus !== undefined) {
        params.push(expectedStatus);
        sql = `update ${POSTGRES_SCHEMA}.import_batches
               set status = $3, row_count = $4, updated_at = $5, raw_json = $6
               where workspace_id = $1 and id = $2 and status = $7`;
      } else {
        sql = `update ${POSTGRES_SCHEMA}.import_batches
               set status = $3, row_count = $4, updated_at = $5, raw_json = $6
               where workspace_id = $1 and id = $2`;
      }
      const res = await client.query(sql, params);
      if (expectedStatus !== undefined && res.rowCount === 0) return null;
      return clone(updated);
    },

    async getImportedRow({ householdId, rowId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.imported_transaction_rows
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, rowId],
      );
      return result.rows[0]?.raw_json ?? null;
    },

    async updateImportedRow({ householdId, rowId, patch }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();
      const existing = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.imported_transaction_rows
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, rowId],
      );
      const row = existing.rows[0]?.raw_json ?? null;
      if (!row) return null;
      const updated = { ...row, ...patch };
      await client.query(
        `update ${POSTGRES_SCHEMA}.imported_transaction_rows
         set status = $3, raw_json = $4, updated_at = $5
         where workspace_id = $1 and id = $2`,
        [wsId, rowId, updated.status ?? row.status, updated, now],
      );
      return clone(updated);
    },

    async updateImportedTransaction({ householdId, importedTransactionId, patch }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();
      const existing = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.imported_transactions
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, importedTransactionId],
      );
      const row = existing.rows[0]?.raw_json ?? null;
      if (!row) return null;
      const updated = { ...row, ...patch, updatedAt: now };
      await client.query(
        `update ${POSTGRES_SCHEMA}.imported_transactions
         set status = $3, classification_type = $4, linked_transaction_id = $5, raw_json = $6, updated_at = $7
         where workspace_id = $1 and id = $2`,
        [wsId, importedTransactionId,
         updated.status ?? null,
         updated.classificationType ?? null,
         updated.linkedTransactionId ?? null,
         updated,
         now],
      );
      return clone(updated);
    },

    async countUnreviewedImportedRows({ householdId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select count(*) as count
         from ${POSTGRES_SCHEMA}.imported_transaction_rows
         where workspace_id = $1 and status = 'pending_review'`,
        [wsId],
      );
      return parseInt(result.rows[0]?.count ?? '0', 10);
    },

    // ── Phase 2E: active P0 infrastructure implementations ───────────────────

    async getEmailPreferences({ householdId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.email_preferences
         where workspace_id = $1
         limit 1`,
        [wsId],
      );
      return result.rows[0]?.raw_json ?? null;
    },

    async upsertEmailPreferences({ householdId, patch }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();
      const existing = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.email_preferences
         where workspace_id = $1
         limit 1`,
        [wsId],
      );
      const current = existing.rows[0]?.raw_json ?? {
        id: uuid(),
        householdId: wsId,
        workspaceId: wsId,
        remindersEnabled: true,
        preferredDay: 'monday',
        preferredHour: 9,
        timezone: 'America/Toronto',
        contactEmail: null,
        optedInWeeklySummary: true,
        optedInPendingImports: true,
        optedInBudgetAlerts: true,
        lastReminderSentAt: null,
        createdAt: now,
      };
      const updated = { ...current, ...patch, updatedAt: now };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.email_preferences
         (id, workspace_id, reminders_enabled, preferred_day, preferred_hour, timezone,
          contact_email, created_at, updated_at, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (workspace_id) do update
           set reminders_enabled = excluded.reminders_enabled,
               preferred_day     = excluded.preferred_day,
               preferred_hour    = excluded.preferred_hour,
               timezone          = excluded.timezone,
               contact_email     = excluded.contact_email,
               updated_at        = excluded.updated_at,
               raw_json          = excluded.raw_json`,
        [
          updated.id ?? uuid(),
          wsId,
          updated.remindersEnabled !== false,
          updated.preferredDay ?? 'monday',
          updated.preferredHour ?? 9,
          updated.timezone ?? 'America/Toronto',
          updated.contactEmail ?? null,
          updated.createdAt ?? now,
          now,
          updated,
        ],
      );
      return clone(updated);
    },

    async logEmailSend({ householdId, reminderType, status, resendMessageId, errorMessage }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const id = uuid();
      const now = isoNow();
      const row = {
        id,
        householdId: wsId,
        workspaceId: wsId,
        reminderType,
        status: status ?? 'sent',
        sentAt: now,
        createdAt: now,
        resendMessageId: resendMessageId ?? null,
        errorMessage: errorMessage ?? null,
      };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.email_send_log
         (id, workspace_id, reminder_type, status, sent_at, created_at, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, wsId, reminderType, row.status, now, now, row],
      );
    },

    // listAllEmailPreferences: DEFERRED (cross-workspace scan requires BYPASSRLS
    // or per-workspace iteration with security context set per row).
    // Under current RLS, calling this without raf.workspace_id set returns 0 rows
    // — that is the pre-existing defect in runWeeklyReminders. Not Phase 2 scope.
    async listAllEmailPreferences() {
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.email_preferences
         order by created_at asc`,
      );
      return result.rows.map((r) => r.raw_json).filter(Boolean);
    },

    async createRemiConversation({ householdId, userId, title }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const id = uuid();
      const now = isoNow();
      const row = {
        id,
        householdId: wsId,
        workspaceId: wsId,
        userId,
        title: title ?? 'New conversation',
        createdAt: now,
        archivedAt: null,
      };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.remi_conversations
         (id, workspace_id, user_id, title, created_at, raw_json)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, wsId, userId, row.title, now, row],
      );
      return clone(row);
    },

    async getRemiConversation({ householdId, conversationId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.remi_conversations
         where workspace_id = $1 and id = $2
         limit 1`,
        [wsId, conversationId],
      );
      return result.rows[0]?.raw_json ?? null;
    },

    async listRemiConversations({ householdId, userId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.remi_conversations
         where workspace_id = $1 and user_id = $2 and archived_at is null
         order by created_at desc`,
        [wsId, userId],
      );
      return result.rows.map((r) => r.raw_json).filter(Boolean);
    },

    async listRemiMessages({ householdId, conversationId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const result = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.remi_messages
         where workspace_id = $1 and conversation_id = $2
         order by created_at asc`,
        [wsId, conversationId],
      );
      return result.rows.map((r) => r.raw_json).filter(Boolean);
    },

    async appendRemiMessage({ householdId, conversationId, role, content, tokensUsed }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const id = uuid();
      const now = isoNow();
      const row = {
        id,
        householdId: wsId,
        workspaceId: wsId,
        conversationId,
        role,
        content,
        tokensUsed: tokensUsed ?? 0,
        createdAt: now,
      };
      await client.query(
        `insert into ${POSTGRES_SCHEMA}.remi_messages
         (id, workspace_id, conversation_id, role, content, tokens_used, created_at, raw_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, wsId, conversationId, role, content, row.tokensUsed, now, row],
      );
      return clone(row);
    },

    // Free tier: 3 AI parses per calendar month, resets on the 1st.
    // Paid tier: unlimited (canImport: true, remaining: null).
    async getPdfImportQuotaStatus({ householdId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const hhResult = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.households
         where workspace_id = $1
         limit 1`,
        [wsId],
      );
      const household = hhResult.rows[0]?.raw_json ?? null;
      if (!household) return { tier: 'free', remaining: 0, canImport: false, reason: 'household_not_found' };

      const tier = household.pdfImportQuotaTier ?? 'free';
      const expiresAt = household.pdfImportQuotaExpiresAt ?? null;
      const isPaidActive = tier === 'paid' && (!expiresAt || new Date(expiresAt) > new Date());

      if (isPaidActive) return { tier: 'paid', remaining: null, canImport: true, reason: null };
      if (tier === 'paid' && expiresAt && new Date(expiresAt) <= new Date()) {
        return { tier: 'paid', remaining: 0, canImport: false, reason: 'subscription_expired' };
      }

      const yearMonth = new Date().toISOString().slice(0, 7);
      const quotaResult = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.pdf_import_quotas
         where workspace_id = $1 and year_month = $2
         limit 1`,
        [wsId, yearMonth],
      );
      const usedCount = quotaResult.rows[0]?.raw_json?.count ?? 0;
      const FREE_LIMIT = 3;
      const remaining = Math.max(0, FREE_LIMIT - usedCount);
      return {
        tier: 'free',
        remaining,
        canImport: remaining > 0,
        reason: remaining > 0 ? 'under_limit' : 'quota_exceeded',
      };
    },

    async updateHouseholdPdfQuotaTier({ householdId, tier, expiresAt }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const now = isoNow();
      const hhResult = await client.query(
        `select raw_json from ${POSTGRES_SCHEMA}.households
         where workspace_id = $1
         limit 1`,
        [wsId],
      );
      const existing = hhResult.rows[0]?.raw_json ?? null;
      if (!existing) return null;
      const updated = {
        ...existing,
        pdfImportQuotaTier: tier ?? existing.pdfImportQuotaTier,
        pdfImportQuotaExpiresAt: 'expiresAt' in { tier, expiresAt }
          ? expiresAt
          : existing.pdfImportQuotaExpiresAt,
        updatedAt: now,
      };
      await client.query(
        `update ${POSTGRES_SCHEMA}.households
         set pdf_import_quota_tier = $2, pdf_import_quota_expires_at = $3, updated_at = $4, raw_json = $5
         where workspace_id = $1`,
        [wsId, updated.pdfImportQuotaTier, updated.pdfImportQuotaExpiresAt ?? null, now, updated],
      );
      return clone(updated);
    },

    async incrementPdfImportQuota({ householdId }) {
      const wsId = workspaceIdFromHousehold(householdId);
      const yearMonth = new Date().toISOString().slice(0, 7);
      const now = isoNow();
      const initialJson = { workspaceId: wsId, yearMonth, count: 1, createdAt: now };
      const result = await client.query(
        `insert into ${POSTGRES_SCHEMA}.pdf_import_quotas
         (workspace_id, year_month, count, created_at, raw_json)
         values ($1, $2, 1, $3, $4)
         on conflict (workspace_id, year_month) do update
           set count      = ${POSTGRES_SCHEMA}.pdf_import_quotas.count + 1,
               raw_json   = ${POSTGRES_SCHEMA}.pdf_import_quotas.raw_json
                            || jsonb_build_object('count', ${POSTGRES_SCHEMA}.pdf_import_quotas.count + 1)
         returning count`,
        [wsId, yearMonth, now, initialJson],
      );
      const newCount = result.rows[0]?.count ?? 1;
      return { workspaceId: wsId, yearMonth, count: newCount };
    },
  };
}

function createHybridTransaction({ directTx, getLegacyTx }) {
  return new Proxy(directTx, {
    get(target, property, receiver) {
      if (property === 'then') {
        return undefined;
      }
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      return async (...args) => {
        const legacyTx = await getLegacyTx();
        const value = legacyTx[property];
        if (typeof value !== 'function') {
          return value;
        }
        return value.apply(legacyTx, args);
      };
    },
  });
}

export function createPostgresDb({ connectionString, ssl = true } = {}) {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error('Postgres connectionString is required.');
  }

  const pool = new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: process.env.NODE_ENV === 'production' } : false,
  });

  return {
    defaultHouseholdId: null,
    state: {},

    async transaction(callback, securityContext = {}) {
      const client = await pool.connect();
      let memoryDb = null;
      let snapshot = null;
      try {
        await client.query('begin');
        if (securityContext.userId) {
          await client.query("select set_config('raf.user_id', $1, true)", [securityContext.userId]);
        }
        if (securityContext.workspaceId ?? securityContext.householdId) {
          await client.query("select set_config('raf.workspace_id', $1, true)", [securityContext.workspaceId ?? securityContext.householdId]);
        }
        const directTx = buildDirectTransaction(client);
        const getLegacyTx = async () => {
          if (!memoryDb) {
            await client.query("select pg_advisory_xact_lock(hashtext('raf.postgres_compatibility_adapter'))");
            memoryDb = createInMemoryDb();
            snapshot = await loadState(client);
            overlayState(memoryDb.state, snapshot);
          }
          return memoryDb.transaction((tx) => tx);
        };
        const result = await callback(createHybridTransaction({ directTx, getLegacyTx }));
        if (memoryDb) {
          for (const def of TABLES) {
            await flushTableDiff(client, def, snapshot[def.stateKey] ?? [], memoryDb.state[def.stateKey] ?? []);
          }
        }
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async ping() {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

export const __postgresPersistence = {
  TABLES,
  POSTGRES_SCHEMA,
  diffRows,
  toSnake,
};
