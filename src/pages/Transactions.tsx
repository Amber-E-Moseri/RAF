import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { getAllocationCategories } from "../api/allocationCategoriesApi";
import { ApiError } from "../api/client";
import { getDebts } from "../api/debtsApi";
import { getFixedBills } from "../api/fixedBillsApi";
import { getGoals } from "../api/goalsApi";
import {
  classifyImportedTransaction,
  deleteImportReviewRule,
  getImportedTransactions,
  updateImportReviewRule,
  importBankStatement,
  unprocessImportedTransaction,
  unignoreImportedTransaction,
} from "../api/importsApi";
import { createTransaction, deleteTransaction, getTransactions, updateTransaction } from "../api/transactionsApi";
import {
  buildImportRuleDraft,
  ImportRuleEditor,
  mapRuleDraftToPayload,
} from "../components/imports/ImportRuleEditor";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingSpinner } from "../components/feedback/LoadingSpinner";
import { LoadingState } from "../components/feedback/LoadingState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { PageShell } from "../components/layout/PageShell";
import { usePeriod } from "../components/layout/PeriodProvider";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { MoneyInput } from "../components/ui/MoneyInput";
import { Table } from "../components/ui/Table";
import { SplitTransactionEditor } from "../components/transactions/SplitTransactionEditor";
import { useAsyncData } from "../hooks/useAsyncData";
import { DEFAULT_PAGE_SIZE } from "../lib/constants";
import { formatIsoDate } from "../lib/format";
import { Money } from "../components/ui/Money";
import { defaultReviewDateForMonth, getMonthKeyFromDate } from "../lib/period";
import {
  normalizeMoneyInput,
  validateIsoDate,
  validatePositiveMoney,
  validateRequiredText,
} from "../lib/validation";
import type {
  AllocationCategory,
  Debt,
  FixedBill,
  Goal,
  ImportedTransaction,
  ImportClassificationPayload,
  ImportReviewRule,
  ImportReviewSuggestion,
  Transaction,
  TransactionListResponse,
} from "../lib/types";

type ImportStatus = "idle" | "uploading" | "parsing" | "success" | "error" | "warning";

interface TransactionsViewModel {
  transactions: TransactionListResponse;
  debts: Debt[];
  categories: AllocationCategory[];
  fixedBills: FixedBill[];
  goals: Goal[];
  imports: ImportedTransaction[];
}

interface ImportReviewDraft {
  classificationType: ImportClassificationPayload["classification_type"];
  categoryId: string;
  debtId: string;
  fixedBillId: string;
  goalId: string;
  reviewNote: string;
  saveRuleMode: "none" | "suggestion" | "reusable_rule";
  autoApplyRule: boolean;
}

interface TransactionEditState {
  id: string;
  transactionDate: string;
  description: string;
  merchant: string;
  amount: string;
  direction: "debit" | "credit";
  categoryId: string;
  linkedDebtId: string;
  linkedGoalId: string;
}

interface TransactionTableRow {
  id: string;
  transactionDate: string;
  description: string;
  merchant: string | null;
  amount: string;
  direction: "debit" | "credit";
  categoryId: string | null;
  linkedDebtId: string | null;
  linkedGoalId: string | null;
  source?: string | null;
  importedClassificationType?: string | null;
  isImportOnly?: boolean;
}

type SortKey = "transactionDate" | "description" | "category" | "amount" | "direction";
type SortDirection = "asc" | "desc";

function directionTone(direction: "debit" | "credit") {
  return direction === "credit" ? "success" : "warning";
}

function amountClassName(direction: "debit" | "credit") {
  return direction === "credit" ? "text-emerald-700" : "text-rose-700";
}

function categoryTone(label: string) {
  const tones: Array<"neutral" | "success" | "warning" | "danger"> = ["neutral", "success", "warning", "danger"];
  const hash = [...label].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return tones[hash % tones.length];
}

function importedStatusTone(item: ImportedTransaction) {
  if (item.status === "unreviewed") {
    return "warning";
  }

  if (item.status === "ignored") {
    return "neutral";
  }

  return "success";
}

function importedStatusLabel(item: ImportedTransaction) {
  if (item.status === "unreviewed") {
    return "Pending";
  }
  if (item.status === "ignored" || item.classification_type === "ignore") {
    return "Ignored";
  }
  return "Processed";
}

function importStateNote(item: ImportedTransaction, draft: ImportReviewDraft) {
  if (item.status === "unreviewed") {
    if (requiresCategorySelection(draft.classificationType) && !draft.categoryId) {
      return "Needs category";
    }

    return "Ready to review";
  }

  if (item.status === "ignored") {
    return "Restore this item before editing.";
  }

  return "Reviewed in Transactions";
}

function looksLikeSavingsTransfer(item: ImportedTransaction) {
  const description = `${item.description} ${item.raw_description ?? ""}`.toLowerCase();
  return Number(item.amount) < 0
    && /(internal transfer|transfer|savings|move)/i.test(description);
}

function sortIndicator(active: boolean, direction: SortDirection) {
  if (!active) {
    return "Sort";
  }

  return direction === "asc" ? "Asc" : "Desc";
}

function mapTransactionToEditState(transaction: Transaction): TransactionEditState {
  return {
    id: transaction.id,
    transactionDate: transaction.transactionDate,
    description: transaction.description,
    merchant: transaction.merchant ?? "",
    amount: transaction.amount,
    direction: transaction.direction,
    categoryId: transaction.categoryId ?? "",
    linkedDebtId: transaction.linkedDebtId ?? "",
    linkedGoalId: transaction.linkedGoalId ?? "",
  };
}

function compareValues(left: string | number, right: string | number, direction: SortDirection) {
  const normalized = typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right));

  return direction === "asc" ? normalized : -normalized;
}

function buildDraftFromImportedRow(item: ImportedTransaction): ImportReviewDraft {
  const appliedSuggestion = item.suggestion?.auto_apply ? item.suggestion : null;
  const fallbackClassificationType = (item.classification_type as ImportClassificationPayload["classification_type"] | null)
    ?? (Number(item.amount) > 0 ? "income" : "transaction");

  return {
    classificationType: (appliedSuggestion?.classification_type as ImportClassificationPayload["classification_type"]) ?? fallbackClassificationType,
    categoryId: appliedSuggestion?.category_id ?? "",
    debtId: appliedSuggestion?.linked_debt_id ?? item.linked_debt_id ?? "",
    fixedBillId: appliedSuggestion?.linked_fixed_bill_id ?? item.linked_fixed_bill_id ?? "",
    goalId: appliedSuggestion?.linked_goal_id ?? item.linked_goal_id ?? "",
    reviewNote: "",
    saveRuleMode: appliedSuggestion?.rule_type ?? "none",
    autoApplyRule: appliedSuggestion?.auto_apply ?? false,
  };
}

function requiresCategorySelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "transaction";
}

function requiresDebtSelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "debt_payment";
}

function requiresFixedBillSelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "fixed_bill_payment";
}

function requiresGoalSelection(classificationType: ImportClassificationPayload["classification_type"]) {
  return classificationType === "goal_funding";
}

function primaryReviewLabel(classificationType: ImportClassificationPayload["classification_type"]) {
  if (classificationType === "ignore") {
    return "Ignore";
  }
  return "Approve";
}

function importRowStatus(item: ImportedTransaction, draft: ImportReviewDraft) {
  return {
    label: importedStatusLabel(item),
    tone: importedStatusTone(item),
  } as const;
}

function canReviewImportedTransaction(item: ImportedTransaction) {
  return item.status === "unreviewed";
}

function userFacingReviewError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("already been reviewed")) {
    return "This transaction is no longer available for review.";
  }
  if (normalized.includes("only processed imported transactions can be unprocessed")) {
    return "Only processed transactions can be moved back to pending review.";
  }
  if (normalized.includes("only ignored imported transactions can be reopened")) {
    return "Only ignored items can be restored to the review queue.";
  }
  if (normalized.includes("not found")) {
    return "This transaction is no longer available for review.";
  }
  if (normalized.includes("route not found")) {
    return "This action is temporarily unavailable. Refresh the app and try again.";
  }

  return message;
}

export function Transactions() {
  const { activeMonth, activeMonthLabel, activeRange, isCurrentMonth } = usePeriod();
  const { from: initialFrom, to: initialTo } = activeRange;
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryFilterFromUrl = searchParams.get("categoryId") ?? "";
  const categorySlugFilterFromUrl = searchParams.get("categorySlug") ?? "";
  const focusLabelFromUrl = searchParams.get("focusLabel") ?? "";
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialTo);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(categorySlugFilterFromUrl ? "" : categoryFilterFromUrl);
  const [sortKey, setSortKey] = useState<SortKey>("transactionDate");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [quickFilter, setQuickFilter] = useState<"all" | "spend" | "income" | "transfer" | "debt">("all");
  const [form, setForm] = useState({
    transactionDate: initialTo,
    description: "",
    merchant: "",
    amount: "",
    direction: "debit" as "debit" | "credit",
    categoryId: "",
    linkedDebtId: "",
    linkedGoalId: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCreateTransactionForm, setShowCreateTransactionForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<TransactionEditState | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isDeletingTransaction, setIsDeletingTransaction] = useState<string | null>(null);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportsExpanded, setIsImportsExpanded] = useState(false);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ImportReviewDraft>>({});
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);
  const [reviewPendingIds, setReviewPendingIds] = useState<string[]>([]);
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);
  const [importsView, setImportsView] = useState<"needs_review" | "ignored" | "processed">("needs_review");
  const [importPanelModes, setImportPanelModes] = useState<Record<string, "review" | "details">>({});
  const [bulkBucketId, setBulkBucketId] = useState("");
  const [bulkRuleMode, setBulkRuleMode] = useState<"none" | "suggestion" | "reusable_rule">("none");
  const [isBulkReviewing, setIsBulkReviewing] = useState(false);
  const [openImportMenuId, setOpenImportMenuId] = useState<string | null>(null);
  const [openAdvancedMenuId, setOpenAdvancedMenuId] = useState<string | null>(null);
  const [dismissedRuleEffects, setDismissedRuleEffects] = useState<Record<string, boolean>>({});
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, ReturnType<typeof buildImportRuleDraft>>>({});
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);
  const cursor = cursorHistory[cursorHistory.length - 1];

  useEffect(() => {
    setFromDate(activeRange.from);
    setToDate(activeRange.to);
    setCursorHistory([null]);
    setForm((current) => ({
      ...current,
      transactionDate: defaultReviewDateForMonth(activeMonth),
    }));
  }, [activeMonth, activeRange.from, activeRange.to]);

  useEffect(() => {
    setSelectedImportIds([]);
    setImportPanelModes({});
    setBulkBucketId("");
    setBulkRuleMode("none");
    setImportsView("needs_review");
    setOpenImportMenuId(null);
  }, [activeMonth]);

  useEffect(() => {
    setCategoryFilter(categorySlugFilterFromUrl ? "" : categoryFilterFromUrl);
    setCursorHistory([null]);
  }, [categoryFilterFromUrl, categorySlugFilterFromUrl]);

  useEffect(() => {
    if (location.hash !== "#transactions-table") {
      return;
    }

    const target = document.getElementById("transactions-table");
    if (!target) {
      return;
    }

    window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [categoryFilterFromUrl, location.hash]);

  const { data, error, isLoading, reload } = useAsyncData<TransactionsViewModel>(async () => {
    const [transactions, debts, imports, fixedBills, goals] = await Promise.all([
      getTransactions({
        from: fromDate,
        to: toDate,
        categoryId: categoryFilter || undefined,
        categorySlug: !categoryFilter && categorySlugFilterFromUrl ? categorySlugFilterFromUrl : undefined,
        cursor: cursor ?? undefined,
        limit: DEFAULT_PAGE_SIZE,
      }),
      getDebts(),
      getImportedTransactions(),
      getFixedBills(),
      getGoals(),
    ]);

    let categories: AllocationCategory[] = [];

    try {
      categories = await getAllocationCategories();
    } catch (loadError) {
      if (!(loadError instanceof ApiError) || loadError.status !== 404) {
        throw loadError;
      }
    }

    return {
      transactions,
      debts: debts.items,
      categories,
      fixedBills: fixedBills.items,
      goals: goals.items.filter((goal) => goal.active !== false),
      imports: imports.items,
    };
  }, [categoryFilter, categorySlugFilterFromUrl, cursor, fromDate, toDate]);

  const debtLookup = new Map(data?.debts.map((debt) => [debt.id, debt.name]) ?? []);
  const categoryLookup = new Map(data?.categories.map((category) => [category.id, category.label]) ?? []);
  const categorySlugLookup = new Map(data?.categories.map((category) => [category.id, category.slug]) ?? []);
  const categoryLabelBySlug = new Map(data?.categories.map((category) => [category.slug, category.label]) ?? []);
  const fixedBillLookup = new Map(data?.fixedBills.map((bill) => [bill.id, bill.name]) ?? []);
  const goalLookup = new Map(data?.goals.map((goal) => [goal.id, goal.name]) ?? []);
  const dashboardFocusedBucketLabel = focusLabelFromUrl || (categorySlugFilterFromUrl ? categoryLabelBySlug.get(categorySlugFilterFromUrl) ?? categorySlugFilterFromUrl : "");
  const goalsForSelectedBucket = useMemo(
    () => (data?.goals ?? []).filter((goal) => !form.categoryId || goal.bucket_id === form.categoryId),
    [data?.goals, form.categoryId],
  );
  const goalsForEditedBucket = useMemo(
    () => (data?.goals ?? []).filter((goal) => !editingTransaction?.categoryId || goal.bucket_id === editingTransaction.categoryId),
    [data?.goals, editingTransaction?.categoryId],
  );

  const visibleTransactions = useMemo(() => {
    const importOnlyRows: TransactionTableRow[] = (data?.imports ?? [])
      .filter((item) => item.status !== "unreviewed")
      .filter((item) => !item.linked_transaction_id)
      .map((item) => ({
        id: `import:${item.id}`,
        transactionDate: item.date,
        description: item.description,
        merchant: item.raw_description ?? null,
        amount: String(Math.abs(Number(item.amount ?? "0"))),
        direction: Number(item.amount) >= 0 ? "credit" : "debit",
        categoryId: item.classification_type === "transaction" ? null : null,
        linkedDebtId: item.linked_debt_id ?? null,
        linkedGoalId: item.linked_goal_id ?? null,
        source: "import",
        importedClassificationType: item.classification_type,
        isImportOnly: true,
      }));

    const combinedRows: TransactionTableRow[] = [
      ...((data?.transactions.items ?? []) as TransactionTableRow[]),
      ...importOnlyRows,
    ];

    const filtered = combinedRows.filter((transaction) => {
      const matchesBucketFilter = !categoryFilter && !categorySlugFilterFromUrl
        ? true
        : categoryFilter
          ? transaction.categoryId === categoryFilter
          : transaction.categoryId
            ? categorySlugLookup.get(transaction.categoryId) === categorySlugFilterFromUrl
            : false;

      if (!matchesBucketFilter) {
        return false;
      }

      const normalizedSearch = searchTerm.trim().toLowerCase();
      const matchesSearch = !normalizedSearch
        || transaction.description.toLowerCase().includes(normalizedSearch)
        || (transaction.merchant ?? "").toLowerCase().includes(normalizedSearch);

      if (!matchesSearch) {
        return false;
      }

      if (quickFilter === "spend") {
        return transaction.direction === "debit" && !transaction.linkedDebtId;
      }

      if (quickFilter === "income") {
        return transaction.direction === "credit";
      }

      if (quickFilter === "transfer") {
        const description = `${transaction.description} ${transaction.merchant ?? ""}`.toLowerCase();
        return /transfer|move|internal/i.test(description);
      }

      if (quickFilter === "debt") {
        return Boolean(transaction.linkedDebtId);
      }

      return true;
    });

      return [...filtered].sort((left, right) => {
      if (sortKey === "amount") {
        return compareValues(Number(left.amount), Number(right.amount), sortDirection);
      }

      if (sortKey === "category") {
        const leftCategory = left.categoryId ? categoryLookup.get(left.categoryId) ?? left.categoryId : "";
        const rightCategory = right.categoryId ? categoryLookup.get(right.categoryId) ?? right.categoryId : "";
        return compareValues(leftCategory, rightCategory, sortDirection);
      }

      return compareValues(left[sortKey], right[sortKey], sortDirection);
    });
  }, [categoryFilter, categoryLookup, categorySlugFilterFromUrl, categorySlugLookup, data?.imports, data?.transactions.items, searchTerm, sortDirection, sortKey]);

  const importsSummary = useMemo(() => {
    const imports = (data?.imports ?? []).filter((item) => getMonthKeyFromDate(item.date) === activeMonth);
    const unreviewed = imports.filter((item) => item.status === "unreviewed").length;
    const dates = imports.map((item) => item.date).filter(Boolean).sort();

    return {
      total: imports.length,
      unreviewed,
      earliestDate: dates[0] ?? null,
      latestDate: dates.at(-1) ?? null,
    };
  }, [activeMonth, data?.imports]);

  const visibleImports = useMemo(
    () => (data?.imports ?? []).filter((item) => getMonthKeyFromDate(item.date) === activeMonth),
    [activeMonth, data?.imports],
  );

  const needsReviewImports = useMemo(
    () => visibleImports.filter((item) => item.status === "unreviewed"),
    [visibleImports],
  );

  const ignoredImports = useMemo(
    () => visibleImports.filter((item) => item.status === "ignored"),
    [visibleImports],
  );

  const processedImports = useMemo(
    () => visibleImports.filter((item) => item.status !== "unreviewed" && item.status !== "ignored"),
    [visibleImports],
  );

  const importsInView = importsView === "needs_review"
    ? needsReviewImports
    : importsView === "ignored"
      ? ignoredImports
      : processedImports;

  const selectedNeedsReviewItems = useMemo(
    () => needsReviewImports.filter((item) => selectedImportIds.includes(item.id)),
    [needsReviewImports, selectedImportIds],
  );

  const hasSelectedNeedsReview = selectedNeedsReviewItems.length > 0;

  useEffect(() => {
    const validIds = new Set(needsReviewImports.map((item) => item.id));
    setSelectedImportIds((current) => current.filter((id) => validIds.has(id)));
  }, [needsReviewImports]);

  function updateCategoryFilter(nextCategoryId: string) {
    setCategoryFilter(nextCategoryId);
    setCursorHistory([null]);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (nextCategoryId) {
        next.set("categoryId", nextCategoryId);
        next.delete("categorySlug");
      } else {
        next.delete("categoryId");
        next.delete("categorySlug");
      }
      next.delete("focusLabel");
      return next;
    }, { replace: true });
  }

  function clearDashboardBucketFocus() {
    setCursorHistory([null]);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("categoryId");
      next.delete("categorySlug");
      next.delete("focusLabel");
      return next;
    }, { replace: true });
  }

  function getReviewDraft(item: ImportedTransaction) {
    return reviewDrafts[item.id] ?? buildDraftFromImportedRow(item);
  }

  function updateReviewDraft(item: ImportedTransaction, patch: Partial<ImportReviewDraft>) {
    setReviewDrafts((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? buildDraftFromImportedRow(item)),
        ...patch,
      },
    }));
  }

  function toggleImportSelection(importId: string) {
    setSelectedImportIds((current) => (
      current.includes(importId)
        ? current.filter((id) => id !== importId)
        : [...current, importId]
    ));
  }

  function toggleSelectAllImports() {
    if (!needsReviewImports.length) {
      return;
    }

    setSelectedImportIds((current) => (
      current.length === needsReviewImports.length
        ? []
        : needsReviewImports.map((item) => item.id)
    ));
  }

  function openImportPanel(importId: string, mode: "review" | "details") {
    setImportPanelModes((current) => {
      if (current[importId] === mode) {
        const next = { ...current };
        delete next[importId];
        return next;
      }

      return {
        ...current,
        [importId]: mode,
      };
    });
  }

  function closeImportPanel(importId: string) {
    setImportPanelModes((current) => {
      const next = { ...current };
      delete next[importId];
      return next;
    });
  }

  function toggleImportMenu(importId: string) {
    setOpenImportMenuId((current) => current === importId ? null : importId);
  }

  function toggleAdvancedMenu(importId: string) {
    setOpenAdvancedMenuId((current) => current === importId ? null : importId);
  }

  function applySuggestion(item: ImportedTransaction) {
    if (!item.suggestion) {
      return;
    }

    setDismissedRuleEffects((current) => ({
      ...current,
      [item.id]: false,
    }));
    setReviewDrafts((current) => ({
      ...current,
      [item.id]: {
        classificationType: item.suggestion?.classification_type as ImportClassificationPayload["classification_type"],
        categoryId: item.suggestion?.category_id ?? "",
        debtId: item.suggestion?.linked_debt_id ?? "",
        fixedBillId: item.suggestion?.linked_fixed_bill_id ?? "",
        goalId: item.suggestion?.linked_goal_id ?? "",
        reviewNote: "",
        saveRuleMode: item.suggestion?.rule_type ?? "none",
        autoApplyRule: item.suggestion?.auto_apply ?? false,
      },
    }));
  }

  function resetRuleEffect(item: ImportedTransaction) {
    setDismissedRuleEffects((current) => ({
      ...current,
      [item.id]: true,
    }));
    setReviewDrafts((current) => ({
      ...current,
      [item.id]: {
        classificationType: "transaction",
        categoryId: "",
        debtId: "",
        fixedBillId: "",
        goalId: "",
        reviewNote: "",
        saveRuleMode: "none",
        autoApplyRule: false,
      },
    }));
  }

  function resetImportReviewDerivedState() {
    setReviewDrafts({});
    setDismissedRuleEffects({});
    setEditingRuleId(null);
  }

  function getRuleDraft(rule: ImportReviewRule | ImportReviewSuggestion) {
    return ruleDrafts[rule.id] ?? buildImportRuleDraft(rule);
  }

  function updateRuleDraft(rule: ImportReviewRule | ImportReviewSuggestion, patch: Partial<ReturnType<typeof buildImportRuleDraft>>) {
    setRuleDrafts((current) => ({
      ...current,
      [rule.id]: {
        ...(current[rule.id] ?? buildImportRuleDraft(rule)),
        ...patch,
      },
    }));
  }

  function getBucketLabel(item: ImportedTransaction) {
    const draft = getReviewDraft(item);
    const bucketId = draft.categoryId || item.suggestion?.category_id || "";

    if (bucketId) {
      return categoryLookup.get(bucketId) ?? bucketId;
    }

    if (draft.classificationType === "debt_payment") {
      return "Debt payoff";
    }

    if (draft.classificationType === "income") {
      return "Auto-allocated";
    }

    if (draft.classificationType === "fixed_bill_payment") {
      return "Via fixed bill";
    }

    if (draft.classificationType === "goal_funding") {
      return "Via goal";
    }

    if (item.classification_type === "duplicate") {
      return "Duplicate";
    }

    if (item.classification_type === "transfer") {
      return "Transfer";
    }

    if (item.classification_type === "ignore" || item.status === "ignored") {
      return "Ignored";
    }

    if (item.classification_type === "transaction") {
      return "Approved";
    }

    return "Select a category";
  }

  function getLinkedLabel(item: ImportedTransaction) {
    const draft = getReviewDraft(item);

    if (draft.classificationType === "debt_payment") {
      return draft.debtId ? debtLookup.get(draft.debtId) ?? draft.debtId : "Select debt";
    }

    if (draft.classificationType === "income") {
      return "Income deposit";
    }

    if (draft.classificationType === "fixed_bill_payment") {
      return draft.fixedBillId ? fixedBillLookup.get(draft.fixedBillId) ?? draft.fixedBillId : "Select fixed bill";
    }

    if (draft.classificationType === "goal_funding") {
      return draft.goalId ? goalLookup.get(draft.goalId) ?? draft.goalId : "Select goal";
    }

    if (item.classification_type === "debt_payment" && item.linked_debt_id) {
      return debtLookup.get(item.linked_debt_id) ?? item.linked_debt_id;
    }

    if (item.classification_type === "income" && item.linked_income_entry_id) {
      return "Income deposit";
    }

    if (item.classification_type === "fixed_bill_payment" && item.linked_fixed_bill_id) {
      return fixedBillLookup.get(item.linked_fixed_bill_id) ?? item.linked_fixed_bill_id;
    }

    if (item.classification_type === "goal_funding" && item.linked_goal_id) {
      return goalLookup.get(item.linked_goal_id) ?? item.linked_goal_id;
    }

    return "None";
  }

  function setSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }

    setSortKey(nextKey);
    setSortDirection("asc");
  }

  function sortableHeader(label: string, key: SortKey): ReactNode {
    const active = sortKey === key;

    return (
      <button
        type="button"
        className={`inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${active ? "text-raf-ink" : "text-stone-500"}`}
        onClick={() => setSort(key)}
      >
        <span>{label}</span>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] normal-case">{sortIndicator(active, sortDirection)}</span>
      </button>
    );
  }

  function validateForm() {
    const nextErrors: Record<string, string | null> = {
      transactionDate: validateIsoDate(form.transactionDate, "Transaction date"),
      description: validateRequiredText(form.description, "Description"),
      amount: validatePositiveMoney(form.amount, "Amount"),
      linkedDebtId: null,
      linkedGoalId: null,
    };

    if (form.linkedDebtId && form.direction !== "debit") {
      nextErrors.linkedDebtId = "Linked debt requires a debit transaction";
    }

    if (form.linkedGoalId && !form.categoryId) {
      nextErrors.linkedGoalId = "Linked goal requires a category";
    }

    setFieldErrors(nextErrors);
    return !Object.values(nextErrors).some(Boolean);
  }

  async function handleCreateTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateForm()) {
      setSubmitError(null);
      setSubmitSuccess(null);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await createTransaction({
        transactionDate: form.transactionDate,
        description: form.description.trim(),
        merchant: form.merchant.trim() || null,
        amount: normalizeMoneyInput(form.amount) ?? form.amount,
        direction: form.direction,
        categoryId: form.categoryId || null,
        linkedDebtId: form.linkedDebtId || null,
        linkedGoalId: form.linkedGoalId || null,
      });

      setSubmitSuccess("Transaction created.");
      setShowCreateTransactionForm(false);
      setForm({
        transactionDate: defaultReviewDateForMonth(activeMonth),
        description: "",
        merchant: "",
        amount: "",
        direction: "debit",
        categoryId: "",
        linkedDebtId: "",
        linkedGoalId: "",
      });
      setFieldErrors({});
      await reload();
    } catch (requestError) {
      setSubmitSuccess(null);
      setSubmitError(requestError instanceof Error ? requestError.message : "Transaction could not be created.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveEditedTransaction() {
    if (!editingTransaction) {
      return;
    }

    setIsSavingEdit(true);
    setSubmitError(null);
    setSubmitSuccess(null);

    try {
      await updateTransaction(editingTransaction.id, {
        transactionDate: editingTransaction.transactionDate,
        description: editingTransaction.description.trim(),
        merchant: editingTransaction.merchant.trim() || null,
        amount: normalizeMoneyInput(editingTransaction.amount) ?? editingTransaction.amount,
        direction: editingTransaction.direction,
        categoryId: editingTransaction.categoryId || null,
        linkedDebtId: editingTransaction.linkedDebtId || null,
        linkedGoalId: editingTransaction.linkedGoalId || null,
      });
      setSubmitSuccess("Transaction updated.");
      setEditingTransaction(null);
      await reload();
    } catch (requestError) {
      setSubmitError(requestError instanceof Error ? requestError.message : "Transaction could not be updated.");
    } finally {
      setIsSavingEdit(false);
    }
  }

  async function handleDeleteTransaction(transaction: Transaction) {
    setIsDeletingTransaction(transaction.id);
    setSubmitError(null);
    setSubmitSuccess(null);

    try {
      await deleteTransaction(transaction.id);
      setSubmitSuccess("Transaction deleted.");
      await reload();
    } catch (requestError) {
      setSubmitError(requestError instanceof Error ? requestError.message : "Transaction could not be deleted.");
    } finally {
      setIsDeletingTransaction(null);
    }
  }

  async function handleImportUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedImportFile) {
      setImportError("Select a PDF statement before uploading.");
      setImportSuccess(null);
      return;
    }

    if (selectedImportFile.type !== "application/pdf" && !selectedImportFile.name.toLowerCase().endsWith(".pdf")) {
      setImportError("Only PDF bank statements are supported.");
      setImportSuccess(null);
      return;
    }

    if (!isCurrentMonth) {
      const shouldContinue = window.confirm(
        `You are viewing ${activeMonthLabel}. This import will be tagged using the statement transaction dates, which may not match the month you are currently viewing. Continue?`,
      );
      if (!shouldContinue) {
        return;
      }
    }

    setIsImporting(true);
    setImportError(null);
    setImportSuccess(null);

    try {
      const result = await importBankStatement(selectedImportFile);
      setImportSuccess(`Imported ${result.extracted} row${result.extracted === 1 ? "" : "s"} for review.`);
      setIsImportsExpanded(true);
      await reload();
    } catch (requestError) {
      setImportError(requestError instanceof Error ? requestError.message : "Bank statement import failed.");
    } finally {
      setIsImporting(false);
      setSelectedImportFile(null);
      // Reset file input element to allow re-uploading the same file
      const fileInput = (event.currentTarget?.querySelector('input[type="file"]') as HTMLInputElement | null);
      if (fileInput) {
        fileInput.value = "";
      }
    }
  }

  function buildImportClassificationPayload(item: ImportedTransaction, draftOverride?: ImportReviewDraft) {
    const draft = draftOverride ?? getReviewDraft(item);
    if (requiresCategorySelection(draft.classificationType) && !draft.categoryId) {
      throw new Error("Select a category before approving this imported row.");
    }
    if (requiresDebtSelection(draft.classificationType) && !draft.debtId) {
      throw new Error("Select a debt before saving this imported row.");
    }
    if (requiresFixedBillSelection(draft.classificationType) && !draft.fixedBillId) {
      throw new Error("Select a fixed bill before saving this imported row.");
    }
    if (requiresGoalSelection(draft.classificationType) && !draft.goalId) {
      throw new Error("Select a goal before saving this imported row.");
    }

    const payload: ImportClassificationPayload = {
      classification_type: draft.classificationType,
      review_note: draft.reviewNote.trim() || null,
      remember_choice: draft.saveRuleMode !== "none",
      save_rule_mode: draft.saveRuleMode === "none" ? undefined : draft.saveRuleMode,
      auto_apply_rule: draft.saveRuleMode === "reusable_rule",
    };

    if (requiresCategorySelection(draft.classificationType)) {
      payload.category_id = draft.categoryId || null;
    }

    if (requiresDebtSelection(draft.classificationType)) {
      payload.debt_id = draft.debtId || null;
    }

    if (requiresFixedBillSelection(draft.classificationType)) {
      payload.fixed_bill_id = draft.fixedBillId || null;
    }

    if (requiresGoalSelection(draft.classificationType)) {
      payload.goal_id = draft.goalId || null;
    }

    return payload;
  }

  async function submitImportedReview(item: ImportedTransaction, payload: ImportClassificationPayload) {
    setReviewPendingIds((current) => [...current, item.id]);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await classifyImportedTransaction(item.id, payload);
    } catch (requestError) {
      throw requestError instanceof Error ? requestError : new Error("Imported row review failed.");
    } finally {
      setReviewPendingIds((current) => current.filter((id) => id !== item.id));
    }
  }

  async function handleReviewImportedRow(item: ImportedTransaction) {
    if (!canReviewImportedTransaction(item)) {
      setReviewError(item.status === "ignored"
        ? "This ignored item must be restored before editing."
        : "This transaction is no longer available for review.");
      setReviewSuccess(null);
      return;
    }

    try {
      const payload = buildImportClassificationPayload(item);
      await submitImportedReview(item, payload);
      setReviewSuccess("Imported row approved.");
      await reload();
    } catch (requestError) {
      setReviewError(userFacingReviewError(requestError instanceof Error ? requestError.message : "Imported row review failed."));
      setReviewSuccess(null);
    }
  }

  async function handleIgnoreImportedRow(item: ImportedTransaction) {
    if (!canReviewImportedTransaction(item)) {
      setReviewError(item.status === "ignored"
        ? "This transaction is already ignored."
        : "This transaction is no longer available for review.");
      setReviewSuccess(null);
      return;
    }

    const currentDraft = getReviewDraft(item);

    setReviewDrafts((current) => ({
      ...current,
      [item.id]: {
        ...currentDraft,
        classificationType: "ignore",
      },
    }));

    try {
      await submitImportedReview(item, {
        classification_type: "ignore",
        review_note: currentDraft.reviewNote.trim() || null,
        remember_choice: currentDraft.saveRuleMode !== "none",
        save_rule_mode: currentDraft.saveRuleMode === "none" ? undefined : currentDraft.saveRuleMode,
        auto_apply_rule: currentDraft.saveRuleMode === "reusable_rule",
      });
      setReviewSuccess("Imported row ignored.");
      setOpenImportMenuId(null);
      await reload();
    } catch (requestError) {
      setReviewError(userFacingReviewError(requestError instanceof Error ? requestError.message : "Ignore action failed."));
      setReviewSuccess(null);
    }
  }

  function handleBulkApplyRememberedRule() {
    const itemsWithSuggestions = selectedNeedsReviewItems.filter((item) => item.suggestion);
    if (!itemsWithSuggestions.length) {
      setReviewError("No remembered rules are available for the selected rows.");
      setReviewSuccess(null);
      return;
    }

    itemsWithSuggestions.forEach((item) => applySuggestion(item));
    setReviewSuccess(`Applied remembered suggestions to ${itemsWithSuggestions.length} selected row${itemsWithSuggestions.length === 1 ? "" : "s"}.`);
    setReviewError(null);
  }

  async function handleBulkReview(action: "approve" | "ignore") {
    if (!selectedNeedsReviewItems.length) {
      return;
    }

    setIsBulkReviewing(true);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      for (const item of selectedNeedsReviewItems) {
        const currentDraft = getReviewDraft(item);
        const effectiveDraft: ImportReviewDraft = {
          ...currentDraft,
          categoryId: currentDraft.categoryId || bulkBucketId || "",
          saveRuleMode: bulkRuleMode,
          autoApplyRule: bulkRuleMode === "reusable_rule",
        };
        const payload = action === "ignore"
          ? {
            classification_type: "ignore" as const,
            review_note: effectiveDraft.reviewNote.trim() || null,
            remember_choice: effectiveDraft.saveRuleMode !== "none",
            save_rule_mode: effectiveDraft.saveRuleMode === "none" ? undefined : effectiveDraft.saveRuleMode,
            auto_apply_rule: effectiveDraft.saveRuleMode === "reusable_rule",
          }
          : buildImportClassificationPayload(item, effectiveDraft);

        if (action === "approve" && effectiveDraft.categoryId && effectiveDraft.categoryId !== currentDraft.categoryId) {
          updateReviewDraft(item, { categoryId: effectiveDraft.categoryId });
        }

        await submitImportedReview(item, payload);
      }

      setSelectedImportIds([]);
      setReviewSuccess(`${action === "approve" ? "Approved" : "Ignored"} ${selectedNeedsReviewItems.length} imported row${selectedNeedsReviewItems.length === 1 ? "" : "s"}.`);
      await reload();
    } catch (requestError) {
      setReviewError(userFacingReviewError(requestError instanceof Error ? requestError.message : "Bulk review failed."));
    } finally {
      setIsBulkReviewing(false);
    }
  }

  async function handleUnignoreImportedRow(item: ImportedTransaction) {
    setReviewPendingIds((current) => [...current, item.id]);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await unignoreImportedTransaction(item.id);
      setImportsView("needs_review");
      closeImportPanel(item.id);
      setOpenImportMenuId(null);
      setOpenAdvancedMenuId(null);
      setReviewSuccess("Ignored transaction moved back to the review queue.");
      await reload();
    } catch (requestError) {
      setReviewError(userFacingReviewError(requestError instanceof Error ? requestError.message : "Could not reopen ignored transaction."));
    } finally {
      setReviewPendingIds((current) => current.filter((id) => id !== item.id));
    }
  }

  async function handleUnprocessImportedRow(item: ImportedTransaction) {
    setReviewPendingIds((current) => [...current, item.id]);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await unprocessImportedTransaction(item.id);
      setImportsView("needs_review");
      closeImportPanel(item.id);
      setOpenImportMenuId(null);
      setOpenAdvancedMenuId(null);
      setReviewSuccess("Processed transaction moved back to pending review.");
      await reload();
    } catch (requestError) {
      setReviewError(userFacingReviewError(requestError instanceof Error ? requestError.message : "Could not unprocess transaction."));
    } finally {
      setReviewPendingIds((current) => current.filter((id) => id !== item.id));
    }
  }

  async function handleSaveRuleEdits(rule: ImportReviewRule | ImportReviewSuggestion) {
    const draft = getRuleDraft(rule);
    setPendingRuleId(rule.id);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await updateImportReviewRule(rule.id, mapRuleDraftToPayload(draft));
      resetImportReviewDerivedState();
      setEditingRuleId(null);
      setReviewSuccess("Import rule updated.");
      await reload();
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : "Import rule update failed.");
    } finally {
      setPendingRuleId(null);
    }
  }

  async function handleDeleteRule(rule: ImportReviewRule | ImportReviewSuggestion) {
    setPendingRuleId(rule.id);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await deleteImportReviewRule(rule.id);
      resetImportReviewDerivedState();
      setEditingRuleId((current) => current === rule.id ? null : current);
      setOpenAdvancedMenuId(null);
      setReviewSuccess("Import rule deleted.");
      await reload();
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : "Import rule delete failed.");
    } finally {
      setPendingRuleId(null);
    }
  }

  async function handleRuleModeUpdate(rule: ImportReviewRule | ImportReviewSuggestion, nextMode: "suggestion" | "reusable_rule", autoApply: boolean) {
    setPendingRuleId(rule.id);
    setReviewError(null);
    setReviewSuccess(null);

    try {
      await updateImportReviewRule(rule.id, {
        rule_type: nextMode,
        auto_apply: nextMode === "reusable_rule" ? autoApply : false,
      });
      resetImportReviewDerivedState();
      setReviewSuccess(nextMode === "suggestion" ? "Rule converted to suggestion only." : autoApply ? "Auto-apply enabled." : "Auto-apply disabled.");
      setOpenAdvancedMenuId(null);
      await reload();
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : "Import rule update failed.");
    } finally {
      setPendingRuleId(null);
    }
  }

  function applyQuickFilter(nextFilter: "all" | "spend" | "income" | "transfer" | "debt") {
    setQuickFilter(nextFilter);
  }

  return (
    <PageShell
      eyebrow="Ledger"
      title="Transactions"
      description={`${activeMonthLabel} transactions, imports, and review flow.`}
      actions={
        <div className="flex gap-2">
          {data?.transactions.items.length ? (
            <Button
              type="button"
              onClick={() => setShowCreateTransactionForm((current) => !current)}
            >
              {showCreateTransactionForm ? "Hide Add Transaction" : "Add Transaction"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={cursorHistory.length <= 1 || isLoading}
            onClick={() => setCursorHistory((history) => history.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            type="button"
            disabled={isLoading || !data?.transactions.nextCursor}
            onClick={() => {
              if (data?.transactions.nextCursor) {
                setCursorHistory((history) => [...history, data.transactions.nextCursor]);
              }
            }}
          >
            Next
          </Button>
        </div>
      }
    >
      {(showCreateTransactionForm || (!isLoading && !error && data && data.transactions.items.length === 0)) ? (
      <section className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
        <Card title="Create Transaction" subtitle="Record spending, income, transfers, and linked payments.">
          <form className="space-y-4" onSubmit={handleCreateTransaction}>
            <Input
              label="Transaction date"
              name="transactionDate"
              type="date"
              value={form.transactionDate}
              error={fieldErrors.transactionDate}
              onBlur={() => setFieldErrors((current) => ({ ...current, transactionDate: validateIsoDate(form.transactionDate, "Transaction date") }))}
              onChange={(event) => {
                setForm((current) => ({ ...current, transactionDate: event.target.value }));
                setFieldErrors((current) => ({ ...current, transactionDate: null }));
              }}
            />
            <Input
              label="Description"
              name="description"
              placeholder="Groceries"
              value={form.description}
              error={fieldErrors.description}
              onBlur={() => setFieldErrors((current) => ({ ...current, description: validateRequiredText(form.description, "Description") }))}
              onChange={(event) => {
                setForm((current) => ({ ...current, description: event.target.value }));
                setFieldErrors((current) => ({ ...current, description: null }));
              }}
            />
            <Input
              label="Merchant"
              name="merchant"
              placeholder="Optional"
              value={form.merchant}
              onChange={(event) => setForm((current) => ({ ...current, merchant: event.target.value }))}
            />
            <MoneyInput
              label="Amount"
              name="amount"
              value={form.amount}
              error={fieldErrors.amount}
              disabled={isSubmitting}
              placeholder="125.00"
              onBlur={() => setFieldErrors((current) => ({ ...current, amount: validatePositiveMoney(form.amount, "Amount") }))}
              onChange={(value) => {
                setForm((current) => ({ ...current, amount: value }));
                setFieldErrors((current) => ({ ...current, amount: null }));
              }}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-raf-ink">Direction</span>
                <select
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                  value={form.direction}
                  onChange={(event) => {
                    const nextDirection = event.target.value as "debit" | "credit";
                    setForm((current) => ({ ...current, direction: nextDirection }));
                    setFieldErrors((current) => ({
                      ...current,
                      linkedDebtId: current.linkedDebtId && nextDirection !== "debit" ? "Linked debt requires a debit transaction" : null,
                    }));
                  }}
                >
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-raf-ink">Linked debt</span>
                <select
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                  value={form.linkedDebtId}
                  onChange={(event) => {
                    const linkedDebtId = event.target.value;
                    setForm((current) => ({ ...current, linkedDebtId }));
                    setFieldErrors((current) => ({
                      ...current,
                      linkedDebtId: linkedDebtId && form.direction !== "debit" ? "Linked debt requires a debit transaction" : null,
                    }));
                  }}
                >
                  <option value="">None</option>
                  {(data?.debts ?? []).map((debt) => (
                    <option key={debt.id} value={debt.id}>{debt.name}</option>
                  ))}
                </select>
                {fieldErrors.linkedDebtId ? <span className="mt-2 block text-sm text-rose-600">{fieldErrors.linkedDebtId}</span> : null}
              </label>
            </div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-raf-ink">Category</span>
              <select
                className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                value={form.categoryId}
                onChange={(event) => {
                  const categoryId = event.target.value;
                  setForm((current) => ({
                    ...current,
                    categoryId,
                    linkedGoalId: current.linkedGoalId && data?.goals.some((goal) => goal.id === current.linkedGoalId && goal.bucket_id === categoryId)
                      ? current.linkedGoalId
                      : "",
                  }));
                  setFieldErrors((current) => ({ ...current, linkedGoalId: null }));
                }}
              >
                <option value=""></option>
                {(data?.categories ?? []).map((category) => (
                  <option key={category.id} value={category.id}>{category.label}</option>
                ))}
              </select>
            </label>
            {form.categoryId ? (
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-raf-ink">Linked goal</span>
                <select
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                  value={form.linkedGoalId}
                  onChange={(event) => {
                    const linkedGoalId = event.target.value;
                    setForm((current) => ({ ...current, linkedGoalId }));
                    setFieldErrors((current) => ({
                      ...current,
                      linkedGoalId: linkedGoalId && !form.categoryId ? "Linked goal requires a category" : null,
                    }));
                  }}
                >
                  <option value="">None</option>
                  {goalsForSelectedBucket.map((goal) => (
                    <option key={goal.id} value={goal.id}>{goal.name}</option>
                  ))}
                </select>
                {fieldErrors.linkedGoalId ? <span className="mt-2 block text-sm text-rose-600">{fieldErrors.linkedGoalId}</span> : null}
              </label>
            ) : null}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <LoadingSpinner inline size="sm" label="Saving transaction..." /> : "Create Transaction"}
              </Button>
            </div>
          </form>
        </Card>

        <div className="space-y-4">
          {submitError ? <ErrorState title="Failed to record transaction" message={submitError} /> : null}
          {submitSuccess ? <SuccessNotice title="Transaction saved" message={submitSuccess} /> : null}
          <Card title="Filter Ledger" subtitle="Date and category filters shape the current page.">
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                label="From date"
                name="fromDate"
                type="date"
                value={fromDate}
                onChange={(event) => {
                  setFromDate(event.target.value);
                  setCursorHistory([null]);
                }}
              />
              <Input
                label="To date"
                name="toDate"
                type="date"
                value={toDate}
                onChange={(event) => {
                  setToDate(event.target.value);
                  setCursorHistory([null]);
                }}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-[1.2fr,0.8fr]">
              <Input
                label="Search description"
                name="search"
                placeholder="Search current page"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-raf-ink">Filter by category</span>
                <select
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                  value={categoryFilter}
                  onChange={(event) => {
                    updateCategoryFilter(event.target.value);
                  }}
                >
                  <option value="">All categories</option>
                  {(data?.categories ?? []).map((category) => (
                    <option key={category.id} value={category.id}>{category.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </Card>
        </div>
      </section>
      ) : null}

      <Card
        title="Import Bank Statement"
        subtitle="Upload a PDF bank statement to create imported rows for review. Nothing becomes a completed RAF transaction until you approve it."
        actions={(
          <Button type="button" variant="secondary" disabled={isLoading || isImporting} onClick={() => void reload()}>
            Refresh imports
          </Button>
        )}
      >
        <form className="grid gap-4 lg:grid-cols-[1.2fr,0.8fr]" onSubmit={handleImportUpload}>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-raf-ink">Statement PDF</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                disabled={isImporting}
                className="block w-full rounded-2xl border border-dashed border-stone-300 bg-stone-50 px-4 py-4 text-sm text-stone-600 file:mr-4 file:rounded-full file:border-0 file:bg-raf-moss file:px-4 file:py-2.5 file:text-sm file:font-semibold file:text-white hover:file:bg-raf-ink disabled:cursor-not-allowed disabled:opacity-60"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setSelectedImportFile(file);
                  setImportError(null);
                  setImportSuccess(null);
                }}
              />
            </label>
            <div
              className="rounded-2xl border px-4 py-3 text-sm"
              style={{
                borderColor: "var(--border-color)",
                background: "var(--surface-plain)",
                color: "var(--text-muted)",
              }}
            >
              {selectedImportFile
                ? `Selected file: ${selectedImportFile.name}`
                : "Select a PDF file to prepare an import."}
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!selectedImportFile || isImporting}>
                {isImporting ? <LoadingSpinner inline size="sm" label="Uploading statement..." /> : "Upload PDF"}
              </Button>
            </div>
          </div>
          <div
            className="space-y-3 rounded-3xl border p-5"
            style={{
              borderColor: "var(--border-color)",
              background: "var(--surface-elevated)",
            }}
          >
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Review queue</h3>
              <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">Imported rows stay separate from the ledger until you classify them into categories, debt payments, fixed bills, savings goals, duplicates, or transfers.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="neutral">{importsSummary.total} total</Badge>
              <Badge tone={importsSummary.unreviewed > 0 ? "warning" : "success"}>{importsSummary.unreviewed} unreviewed</Badge>
            </div>
            <p className="text-sm text-[var(--text-muted)]">
              {importsSummary.earliestDate && importsSummary.latestDate
                ? `${activeMonthLabel} import range: ${formatIsoDate(importsSummary.earliestDate)} to ${formatIsoDate(importsSummary.latestDate)}`
                : `No imported statement rows for ${activeMonthLabel}.`}
            </p>
          </div>
        </form>
        <div className="mt-4 space-y-3">
          {importError ? <ErrorState title="Import failed" message={importError} /> : null}
          {importSuccess ? <SuccessNotice title="Import complete" message={importSuccess} /> : null}
        </div>
      </Card>

      <Card
        title="Imported Rows Review"
        subtitle="Work through the review queue quickly with compact rows, bulk tools, and editable suggestions."
        actions={(
          <div className="flex items-center gap-3">
            <Badge tone={importsSummary.unreviewed > 0 ? "warning" : "neutral"}>{importsSummary.unreviewed} needs review</Badge>
            <Button type="button" variant="ghost" onClick={() => setIsImportsExpanded((current) => !current)}>
              {isImportsExpanded ? "Collapse review" : "Expand review"}
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3"
            style={{
              borderColor: "var(--border-color)",
              background: "var(--surface-plain)",
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
                  importsView === "needs_review"
                    ? "border-transparent bg-[var(--primary-color)] text-[var(--primary-contrast)]"
                    : "border-[var(--border-color)] bg-[var(--surface-color)] text-stone-600"
                }`}
                onClick={() => {
                  setImportsView("needs_review");
                  setIsImportsExpanded(true);
                }}
              >
                Needs review ({needsReviewImports.length})
              </button>
              <button
                type="button"
                className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
                  importsView === "ignored"
                    ? "border-transparent bg-[var(--primary-color)] text-[var(--primary-contrast)]"
                    : "border-[var(--border-color)] bg-[var(--surface-color)] text-stone-600"
                }`}
                onClick={() => {
                  setImportsView("ignored");
                  setIsImportsExpanded(true);
                }}
              >
                Ignored ({ignoredImports.length})
              </button>
              <button
                type="button"
                className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
                  importsView === "processed"
                    ? "border-transparent bg-[var(--primary-color)] text-[var(--primary-contrast)]"
                    : "border-[var(--border-color)] bg-[var(--surface-color)] text-stone-600"
                }`}
                onClick={() => {
                  setImportsView("processed");
                  setIsImportsExpanded(true);
                }}
              >
                Processed ({processedImports.length})
              </button>
            </div>
            <div className="text-sm text-[var(--text-muted)]">
              {importsSummary.earliestDate && importsSummary.latestDate
                ? `${formatIsoDate(importsSummary.earliestDate)} to ${formatIsoDate(importsSummary.latestDate)}`
                : `No imported rows in ${activeMonthLabel}`}
            </div>
          </div>

          {reviewError ? <ErrorState title="Review action failed" message={reviewError} /> : null}
          {reviewSuccess ? <SuccessNotice title="Imported row updated" message={reviewSuccess} /> : null}

          {!isImportsExpanded ? (
            <div
              className="rounded-2xl border border-dashed px-4 py-4 text-sm"
              style={{
                borderColor: "var(--border-color)",
                background: "var(--surface-plain)",
                color: "var(--text-muted)",
              }}
            >
              Imported rows review is collapsed. Expand it to process the review queue and bulk-approve similar imports.
            </div>
          ) : isLoading ? (
            <LoadingState label="Loading imported rows..." />
          ) : !error && data ? (
            importsInView.length ? (
              <div className="space-y-3">
                {importsView === "needs_review" ? (
                  <div
                    className="rounded-2xl border px-4 py-3"
                    style={{
                      borderColor: "var(--border-color)",
                      background: "var(--surface-plain)",
                    }}
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <label className="inline-flex items-center gap-3 text-sm font-medium text-raf-ink">
                        <input
                          type="checkbox"
                          checked={needsReviewImports.length > 0 && selectedImportIds.length === needsReviewImports.length}
                          onChange={toggleSelectAllImports}
                        />
                        <span>Select all</span>
                      </label>
                      {hasSelectedNeedsReview ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <Badge tone="warning">{selectedNeedsReviewItems.length} selected</Badge>
                          <select
                            className="rounded-full border border-stone-300 bg-white px-3 py-2 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                            value={bulkBucketId}
                            onChange={(event) => setBulkBucketId(event.target.value)}
                          >
                            <option value="">Choose category</option>
                            {data.categories.map((category) => (
                              <option key={category.id} value={category.id}>{category.label}</option>
                            ))}
                          </select>
                          <select
                            className="rounded-full border border-stone-300 bg-white px-3 py-2 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                            value={bulkRuleMode}
                            onChange={(event) => setBulkRuleMode(event.target.value as "none" | "suggestion" | "reusable_rule")}
                          >
                            <option value="none">No saved memory</option>
                            <option value="suggestion">Suggest this choice next time</option>
                            <option value="reusable_rule">Save as reusable rule</option>
                          </select>
                          <Button type="button" disabled={isBulkReviewing} onClick={() => void handleBulkReview("approve")}>
                            {isBulkReviewing ? <LoadingSpinner inline size="sm" label="Approving..." /> : "Approve Selected"}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-[var(--text-muted)]">Select rows, choose a fallback category if needed, and approve them in bulk.</span>
                      )}
                    </div>
                  </div>
                ) : null}

                <div className="overflow-hidden rounded-2xl border" style={{ borderColor: "var(--border-color)" }}>
                  <div
                    className="hidden px-4 py-2.5 text-xs font-semibold lg:grid lg:grid-cols-[36px,88px,minmax(0,320px),112px,132px,132px,112px,44px] lg:gap-3"
                    style={{
                      background: "var(--surface-plain)",
                      color: "var(--text-muted)",
                    }}
                  >
                    <span />
                    <span>Date</span>
                    <span>Description</span>
                    <span>Amount</span>
                    <span>Bucket</span>
                    <span>Linked type</span>
                    <span>Primary action</span>
                    <span />
                  </div>
                  <div
                    className="divide-y"
                    style={{
                      borderColor: "var(--border-color)",
                      background: "var(--surface-color)",
                    }}
                  >
                    {importsInView.map((item) => {
                      const isInflow = Number(item.amount) > 0;
                      const isPending = reviewPendingIds.includes(item.id);
                      const draft = getReviewDraft(item);
                      const status = importRowStatus(item, draft);
                      const panelMode = importPanelModes[item.id] ?? null;
                      const isExpanded = panelMode !== null;
                      const needsReview = item.status === "unreviewed";
                      const isIgnored = item.status === "ignored";
                      const isMenuOpen = openImportMenuId === item.id;
                      const isAdvancedOpen = openAdvancedMenuId === item.id;
                      const activeRule = item.suggestion && !dismissedRuleEffects[item.id] ? item.suggestion : null;
                      const isRuleEditing = editingRuleId === activeRule?.id;
                      const canLinkFixedBill = data.fixedBills.length > 0;

                      return (
                        <div key={item.id}>
                          <div className={`grid gap-2 px-4 py-2.5 lg:grid-cols-[36px,88px,minmax(0,320px),112px,132px,132px,112px,44px] lg:items-start ${isIgnored ? "bg-stone-50/70" : ""}`}>
                            <div className="flex items-center justify-center">
                              {needsReview ? (
                                <input
                                  type="checkbox"
                                  checked={selectedImportIds.includes(item.id)}
                                  onChange={() => toggleImportSelection(item.id)}
                                />
                              ) : (
                                <span className="text-xs text-stone-400">-</span>
                              )}
                            </div>
                            <div className="min-w-0 text-sm text-stone-600 lg:pt-1">{formatIsoDate(item.date)}</div>
                            <div className="min-w-0 max-w-[320px]">
                              <div className="break-words text-sm font-medium leading-5 text-raf-ink" title={item.description}>
                                {item.description}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <Badge tone={status.tone}>{status.label}</Badge>
                                {activeRule?.auto_apply ? <Badge tone="success">Applied by rule</Badge> : null}
                                {activeRule && !activeRule.auto_apply ? <Badge tone="neutral">{activeRule.rule_type === "reusable_rule" ? "Reusable rule" : "Suggestion"}</Badge> : null}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                                <span>{importStateNote(item, draft)}</span>
                                {activeRule ? <span>Rule: "{activeRule.match_value ?? activeRule.normalized_description}"</span> : null}
                                {activeRule?.auto_apply ? (
                                  <button type="button" className="text-[var(--primary-color)]" onClick={() => resetRuleEffect(item)}>Undo</button>
                                ) : null}
                                {item.review_note ? <span>Note: {item.review_note}</span> : null}
                              </div>
                            </div>
                            <div className="min-w-0 rounded-xl px-3 py-2 text-right lg:bg-transparent lg:px-0 lg:py-1" style={{ background: "var(--surface-plain)" }}>
                              <div className="text-[11px] font-semibold text-[var(--text-muted)] lg:hidden">Amount</div>
                              <div className={`text-sm font-semibold ${isInflow ? "text-emerald-700" : "text-rose-700"}`}>
                                {<Money value={item.amount} />}
                              </div>
                            </div>
                            <div className="min-w-0 lg:pt-0.5">
                              {needsReview && requiresCategorySelection(draft.classificationType) ? (
                                <select
                                  className="w-full rounded-xl border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-700 outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                                  value={draft.categoryId}
                                  disabled={isPending || isBulkReviewing}
                                  onChange={(event) => updateReviewDraft(item, { categoryId: event.target.value })}
                                >
                                  <option value="">Select a category</option>
                                  {data.categories.map((category) => (
                                    <option key={category.id} value={category.id}>{category.label}</option>
                                  ))}
                                </select>
                              ) : (
                                <div className="truncate text-sm text-[var(--text-muted)]">{getBucketLabel(item)}</div>
                              )}
                            </div>
                            <div className="min-w-0 truncate text-sm text-[var(--text-muted)] lg:pt-0.5">{getLinkedLabel(item)}</div>
                            <div className="min-w-0 lg:pt-0.5">
                              {needsReview ? (
                                <Button
                                  type="button"
                                  className="min-h-9 rounded-full px-3 py-1.5 text-xs"
                                  disabled={isPending || isBulkReviewing}
                                  onClick={() => void handleReviewImportedRow(item)}
                                >
                                  {isPending ? <LoadingSpinner inline size="sm" label="Approving..." /> : primaryReviewLabel(draft.classificationType)}
                                </Button>
                              ) : isIgnored ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  className="min-h-9 rounded-full px-3 py-1.5 text-xs"
                                  disabled={isPending}
                                  onClick={() => void handleUnignoreImportedRow(item)}
                                >
                                  Unignore
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  className="min-h-9 rounded-full px-3 py-1.5 text-xs"
                                  disabled={isPending}
                                  onClick={() => void handleUnprocessImportedRow(item)}
                                >
                                  Unprocess
                                </Button>
                              )}
                            </div>
                            <div className="relative flex justify-end">
                              <button
                                type="button"
                                aria-label="More import actions"
                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border transition hover:bg-[var(--surface-plain)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-color)]"
                                style={{
                                  borderColor: "var(--border-color)",
                                  background: "var(--surface-color)",
                                  color: "var(--text-strong)",
                                }}
                                onClick={() => toggleImportMenu(item.id)}
                              >
                                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                                  <circle cx="4" cy="10" r="1.6" />
                                  <circle cx="10" cy="10" r="1.6" />
                                  <circle cx="16" cy="10" r="1.6" />
                                </svg>
                              </button>
                              {isMenuOpen ? (
                                <div
                                  className="absolute right-0 top-10 z-10 min-w-[210px] rounded-2xl border p-2 shadow-lg"
                                  style={{
                                    borderColor: "var(--border-color)",
                                    background: "var(--surface-color)",
                                  }}
                                >
                                  {needsReview ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                      onClick={() => {
                                        openImportPanel(item.id, "review");
                                        setOpenImportMenuId(null);
                                      }}
                                    >
                                      Review transaction
                                    </button>
                                  ) : null}
                                  {isIgnored ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                      onClick={() => void handleUnignoreImportedRow(item)}
                                    >
                                      Unignore
                                    </button>
                                  ) : null}
                                  {!needsReview && !isIgnored ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                      onClick={() => void handleUnprocessImportedRow(item)}
                                    >
                                      Unprocess transaction
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                    onClick={() => {
                                      openImportPanel(item.id, "details");
                                      setOpenImportMenuId(null);
                                    }}
                                  >
                                    View details
                                  </button>
                                  {needsReview ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-600 transition hover:bg-[var(--surface-plain)] hover:text-rose-500"
                                      onClick={() => void handleIgnoreImportedRow(item)}
                                    >
                                      Ignore transaction
                                    </button>
                                  ) : null}
                                  {activeRule ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                      onClick={() => toggleAdvancedMenu(item.id)}
                                    >
                                      Rule actions {isAdvancedOpen ? "v" : ">"}
                                    </button>
                                  ) : null}
                                  {isAdvancedOpen && activeRule ? (
                                    <div className="mt-2 space-y-1 border-t pt-2" style={{ borderColor: "var(--border-color)" }}>
                                      {activeRule.rule_type !== "suggestion" ? (
                                        <button
                                          type="button"
                                          className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                          onClick={() => void handleRuleModeUpdate(activeRule, "suggestion", false)}
                                        >
                                          Convert to suggestion only
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                        onClick={() => {
                                          setEditingRuleId(activeRule.id);
                                          openImportPanel(item.id, "review");
                                          setOpenImportMenuId(null);
                                        }}
                                      >
                                        Edit rule
                                      </button>
                                      <button
                                        type="button"
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-600 transition hover:bg-[var(--surface-plain)] hover:text-rose-500"
                                        onClick={() => void handleDeleteRule(activeRule)}
                                      >
                                        Delete rule
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {isExpanded ? (
                            <div
                              className="border-t px-4 py-4"
                              style={{
                                borderColor: "var(--border-color)",
                                background: "color-mix(in srgb, var(--surface-plain) 84%, var(--surface-color))",
                              }}
                            >
                              {activeRule ? (
                                <div className="mb-4 rounded-2xl border px-4 py-3" style={{ borderColor: "var(--border-color)", background: "var(--surface-color)" }}>
                                  <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-sm text-[var(--text-muted)]">
                                      {activeRule.auto_apply ? "Applied by rule" : "Suggestion available"}: "{activeRule.match_value ?? activeRule.normalized_description}".
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                    {needsReview ? (
                                      <Button type="button" variant="secondary" onClick={() => applySuggestion(item)}>
                                        Use suggestion
                                      </Button>
                                    ) : null}
                                    {activeRule.auto_apply ? (
                                      <Button type="button" variant="secondary" onClick={() => resetRuleEffect(item)}>
                                        Undo
                                      </Button>
                                    ) : null}
                                    </div>
                                  </div>
                                </div>
                              ) : null}

                              {panelMode === "review" && needsReview && activeRule && isRuleEditing ? (
                                <ImportRuleEditor
                                  categories={data.categories}
                                  debts={data.debts}
                                  fixedBills={data.fixedBills}
                                  goals={data.goals}
                                  draft={getRuleDraft(activeRule)}
                                  isSaving={pendingRuleId === activeRule.id}
                                  saveLabel="Save rule"
                                  allowAutoApplyToggle={false}
                                  onChange={(patch) => updateRuleDraft(activeRule, patch)}
                                  onCancel={() => setEditingRuleId(null)}
                                  onSave={() => void handleSaveRuleEdits(activeRule)}
                                />
                              ) : panelMode === "review" && needsReview ? (
                                <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-color)" }}>
                                  <div className="mb-4 rounded-2xl border px-3 py-3 text-sm text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                                    Choose a review outcome, set the category if needed, optionally save the rule, then approve.
                                  </div>
                                  <div className="grid gap-4 md:grid-cols-2">
                                    <label className="block">
                                      <span className="mb-2 block text-sm font-medium text-raf-ink">Review action</span>
                                      <select
                                        className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                                        value={draft.classificationType}
                                        disabled={isPending || isBulkReviewing}
                                        onChange={(event) => updateReviewDraft(item, {
                                          classificationType: event.target.value as ImportClassificationPayload["classification_type"],
                                          categoryId: "",
                                          debtId: "",
                                          fixedBillId: "",
                                          goalId: "",
                                        })}
                                      >
                                      <option value="income">Add to income deposit</option>
                                      <option value="transaction">Approve as transaction</option>
                                      <option value="debt_payment">Link to debt payment</option>
                                        {canLinkFixedBill ? <option value="fixed_bill_payment">Link to fixed bill</option> : null}
                                        <option value="goal_funding">Internal transfer -&gt; savings goal</option>
                                        <option value="duplicate">Mark duplicate</option>
                                        <option value="transfer">Mark transfer</option>
                                        <option value="ignore">Ignore</option>
                                      </select>
                                    </label>

                                    {requiresCategorySelection(draft.classificationType) ? (
                                      <label className="block">
                                        <span className="mb-2 block text-sm font-medium text-raf-ink">Bucket</span>
                                        <select
                                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                                          value={draft.categoryId}
                                          disabled={isPending || isBulkReviewing}
                                          onChange={(event) => updateReviewDraft(item, { categoryId: event.target.value })}
                                        >
                                          <option value="">Select a category</option>
                                          {data.categories.map((category) => (
                                            <option key={category.id} value={category.id}>{category.label}</option>
                                          ))}
                                        </select>
                                      </label>
                                    ) : null}

                                    {requiresDebtSelection(draft.classificationType) ? (
                                      <label className="block">
                                        <span className="mb-2 block text-sm font-medium text-raf-ink">Debt</span>
                                        <select
                                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                                          value={draft.debtId}
                                          disabled={isPending || isBulkReviewing}
                                          onChange={(event) => updateReviewDraft(item, { debtId: event.target.value })}
                                        >
                                          <option value="">Select debt</option>
                                          {data.debts.map((debt) => (
                                            <option key={debt.id} value={debt.id}>{debt.name}</option>
                                          ))}
                                        </select>
                                      </label>
                                    ) : null}

                                    {requiresFixedBillSelection(draft.classificationType) ? (
                                      <label className="block">
                                        <span className="mb-2 block text-sm font-medium text-raf-ink">Fixed bill</span>
                                        <select
                                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                                          value={draft.fixedBillId}
                                          disabled={isPending || isBulkReviewing}
                                          onChange={(event) => updateReviewDraft(item, { fixedBillId: event.target.value })}
                                        >
                                          <option value="">Select fixed bill</option>
                                          {data.fixedBills.map((bill) => (
                                            <option key={bill.id} value={bill.id}>{bill.name}</option>
                                          ))}
                                        </select>
                                      </label>
                                    ) : null}

                                    {requiresGoalSelection(draft.classificationType) ? (
                                      <label className="block">
                                        <span className="mb-2 block text-sm font-medium text-raf-ink">Savings goal</span>
                                        <select
                                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                                          value={draft.goalId}
                                          disabled={isPending || isBulkReviewing}
                                          onChange={(event) => updateReviewDraft(item, { goalId: event.target.value })}
                                        >
                                          <option value="">Select goal</option>
                                          {data.goals.map((goal) => (
                                            <option key={goal.id} value={goal.id}>{goal.name}</option>
                                          ))}
                                        </select>
                                        {looksLikeSavingsTransfer(item) ? (
                                          <span className="mt-2 block text-xs text-stone-500">
                                            This bank debit will be recorded as a positive contribution to the selected goal.
                                          </span>
                                        ) : null}
                                      </label>
                                    ) : null}

                                    <div className="md:col-span-2">
                                      <Input
                                        label="Review note"
                                        name={`review-note-${item.id}`}
                                        placeholder="Optional note"
                                        value={draft.reviewNote}
                                        onChange={(event) => updateReviewDraft(item, { reviewNote: event.target.value })}
                                      />
                                    </div>

                                    <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                                      <label className="flex items-start gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
                                        <input
                                          type="radio"
                                          name={`rule-mode-${item.id}`}
                                          className="mt-1"
                                          checked={draft.saveRuleMode === "suggestion"}
                                          disabled={isPending || isBulkReviewing}
                                          onChange={() => updateReviewDraft(item, { saveRuleMode: "suggestion", autoApplyRule: false })}
                                        />
                                        <span>
                                          <span className="block font-medium text-raf-ink">Suggest this choice next time</span>
                                          <span className="mt-1 block text-stone-500">Recommend this choice for similar future transactions but do not apply automatically.</span>
                                        </span>
                                      </label>

                                      <label className="flex items-start gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
                                        <input
                                          type="radio"
                                          name={`rule-mode-${item.id}`}
                                          className="mt-1"
                                          checked={draft.saveRuleMode === "reusable_rule"}
                                          disabled={isPending || isBulkReviewing}
                                          onChange={() => updateReviewDraft(item, { saveRuleMode: "reusable_rule", autoApplyRule: true })}
                                        />
                                        <span>
                                          <span className="block font-medium text-raf-ink">Save as reusable rule</span>
                                          <span className="mt-1 block text-stone-500">Save a rule that will auto-apply for similar transactions. Use Settings to disable auto-apply later.</span>
                                        </span>
                                      </label>
                                      {draft.saveRuleMode === "reusable_rule" ? (
                                        <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700 md:col-span-2">
                                          <span className="block font-medium text-raf-ink">Auto-apply enabled</span>
                                          <span className="mt-1 block text-stone-500">Reusable rules auto-apply immediately. To disable that later, go to Settings.</span>
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>

                                  <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      disabled={isPending || isBulkReviewing}
                                      onClick={() => {
                                        closeImportPanel(item.id);
                                        setOpenImportMenuId(null);
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      type="button"
                                      disabled={isPending || isBulkReviewing}
                                      onClick={() => void handleReviewImportedRow(item)}
                                    >
                                      {isPending ? <LoadingSpinner inline size="sm" label="Approving..." /> : primaryReviewLabel(draft.classificationType)}
                                    </Button>
                                  </div>
                                </div>
                              ) : panelMode === "details" ? (
                                <div className="rounded-2xl border border-stone-200 bg-white p-4">
                                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    <div>
                                      <div className="text-xs font-medium text-stone-500">Date</div>
                                      <div className="mt-1 text-sm text-raf-ink">{formatIsoDate(item.date)}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-medium text-stone-500">Status</div>
                                      <div className="mt-1"><Badge tone={status.tone}>{status.label}</Badge></div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-medium text-stone-500">Amount</div>
                                      <div className={`mt-1 text-sm font-semibold ${Number(item.amount) >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                                        {<Money value={item.amount} />}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-medium text-stone-500">Linked</div>
                                      <div className="mt-1 text-sm text-stone-600">{getLinkedLabel(item)}</div>
                                    </div>
                                  </div>
                                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                                    <div>
                                      <div className="text-xs font-medium text-stone-500">Description</div>
                                      <div className="mt-1 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-raf-ink">
                                        {item.description}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-medium text-stone-500">Bucket</div>
                                      <div className="mt-1 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-600">
                                        {getBucketLabel(item) || "None"}
                                      </div>
                                    </div>
                                  </div>
                                  {activeRule ? (
                                    <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
                                      <div className="text-xs font-medium text-stone-500">Rule</div>
                                      <div className="mt-1 text-sm text-raf-ink">
                                        {activeRule.auto_apply ? "Applied by rule" : "Suggestion available"}: "{activeRule.match_value ?? activeRule.normalized_description}"
                                      </div>
                                    </div>
                                  ) : null}
                                  {item.review_note ? (
                                    <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
                                      <div className="text-xs font-medium text-stone-500">Review note</div>
                                      <div className="mt-1 text-sm text-raf-ink">{item.review_note}</div>
                                    </div>
                                  ) : null}
                                  <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                                    <Button type="button" variant="secondary" onClick={() => closeImportPanel(item.id)}>
                                      Close
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex flex-wrap gap-2">
                                  {isIgnored ? <Badge tone="neutral">Restore this item before editing</Badge> : null}
                                  {!isIgnored ? <Badge tone="neutral">Reviewed in Transactions</Badge> : null}
                                  {item.linked_transaction_id ? <Badge tone="neutral">Transaction linked</Badge> : null}
                                  {item.linked_income_entry_id ? <Badge tone="success">Income added</Badge> : null}
                                  {item.linked_debt_id ? <Badge tone="warning">{debtLookup.get(item.linked_debt_id) ?? "Debt linked"}</Badge> : null}
                                  {item.linked_fixed_bill_id ? <Badge tone="neutral">{fixedBillLookup.get(item.linked_fixed_bill_id) ?? "Fixed bill linked"}</Badge> : null}
                                  {item.linked_goal_id ? <Badge tone="success">{goalLookup.get(item.linked_goal_id) ?? "Goal linked"}</Badge> : null}
                                  {!isIgnored ? (
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      className="rounded-full px-3 py-1.5 text-xs"
                                      disabled={isPending}
                                      onClick={() => void handleUnprocessImportedRow(item)}
                                    >
                                      Unprocess transaction
                                    </Button>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                title={importsView === "needs_review" ? "No rows need review" : importsView === "ignored" ? "No ignored imports" : "No processed imports yet"}
                message={importsView === "needs_review"
                  ? "Upload a PDF bank statement or switch months to review imported rows for a different period."
                  : importsView === "ignored"
                    ? "Ignored transactions stay recoverable. Once a row is ignored, you can reopen it here."
                    : "Approved, duplicate, transfer, and other processed rows will move here once they leave the review queue."}
              />
            )
          ) : null}
        </div>
      </Card>

      <div id="transactions-table">
      <Card title="Transactions Table" subtitle={`Showing transactions from ${formatIsoDate(fromDate)} to ${formatIsoDate(toDate)}.`}>
        {isLoading ? <LoadingState label="Loading transactions..." /> : null}
        {!isLoading && error ? <ErrorState title="Failed to fetch transactions" message={error} onRetry={() => void reload()} /> : null}
        {!isLoading && !error && data ? (
          <>
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3"
              style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {categorySlugFilterFromUrl || categoryFilterFromUrl ? (
                  <span className="rounded-full bg-[color:color-mix(in_srgb,var(--primary-color)_10%,transparent)] px-3 py-1 text-[11px] font-semibold text-[var(--text-strong)]">
                    {dashboardFocusedBucketLabel ? `${dashboardFocusedBucketLabel} filter active` : "Dashboard filter active"}
                  </span>
                ) : null}
                {[
                  ["all", "All"],
                  ["spend", "Spend"],
                  ["income", "Income"],
                  ["transfer", "Transfer"],
                  ["debt", "Debt Payoff"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
                      quickFilter === value
                        ? "border-transparent bg-[var(--primary-color)] text-[var(--primary-contrast)]"
                        : "border-[var(--border-color)] bg-[var(--surface-color)] text-[var(--text-muted)]"
                    }`}
                    onClick={() => applyQuickFilter(value as "all" | "spend" | "income" | "transfer" | "debt")}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {categorySlugFilterFromUrl || categoryFilterFromUrl ? (
                <Button type="button" variant="secondary" className="rounded-full px-3 py-1.5 text-xs" onClick={clearDashboardBucketFocus}>
                  Clear filter
                </Button>
              ) : null}
            </div>
            {visibleTransactions.length ? (
              <Table
                headers={[
                  <span className="inline-block w-20 text-[0.72rem] text-[var(--text-strong)]">Date</span>,
                  <span className="text-[0.72rem] text-[var(--text-strong)]">{sortableHeader("Description", "description")}</span>,
                  <span className="inline-block w-[120px] text-[0.68rem] text-[var(--text-muted)]">Category</span>,
                  <span className="inline-block w-[110px] text-[0.68rem] text-[var(--text-muted)]">Type</span>,
                  <span className="inline-block w-[88px] text-[0.74rem] font-bold text-[var(--text-strong)]">Amount</span>,
                  <span className="inline-block w-[110px] text-[0.68rem] text-[var(--text-muted)]">Actions</span>,
                ]}
                footer={(
                  <div className="flex items-center justify-between gap-4 text-sm text-stone-500">
                    <span>{visibleTransactions.length} item(s) on this page after search and sort</span>
                    <span>{data.transactions.nextCursor ? "More pages available" : "End of results"}</span>
                  </div>
                )}
              >
                {visibleTransactions.map((transaction: TransactionTableRow) => {
                  const categoryLabel = transaction.categoryId
                    ? categoryLookup.get(transaction.categoryId) ?? transaction.categoryId
                    : "";
                  const typeLabel = transaction.isImportOnly
                    ? (transaction.importedClassificationType === "income"
                      ? "income import"
                      : transaction.importedClassificationType === "duplicate"
                        ? "duplicate"
                        : transaction.importedClassificationType === "transfer"
                          ? "transfer"
                          : transaction.importedClassificationType === "ignore"
                            ? "ignored"
                            : transaction.direction)
                    : transaction.direction;
                  const typeSummary = transaction.source === "import"
                    ? `${typeLabel} • Imported`
                    : typeLabel;

                  return (
                    <tr key={transaction.id} className="transition hover:bg-[var(--surface-plain)]">
                      <td className="w-20 px-4 py-3 text-sm text-[var(--text-muted)]">{formatIsoDate(transaction.transactionDate)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-[var(--text-strong)]">
                        <div className="max-w-[420px] whitespace-normal break-words">{transaction.description}</div>
                      </td>
                      <td className="w-[120px] px-4 py-3 text-sm">
                        {categoryLabel ? <Badge tone={categoryTone(categoryLabel)} className="px-2 py-0 text-[10px] font-medium leading-5">{categoryLabel}</Badge> : null}
                      </td>
                      <td className="w-[100px] px-4 py-3 text-sm">
                        <div className="text-[11px] text-[var(--text-muted)]">{typeSummary}</div>
                      </td>
                      <td className={`w-[88px] px-4 py-3 text-right text-sm font-bold ${amountClassName(transaction.direction)}`}>
                        {<Money value={transaction.amount} />}
                      </td>
                      <td className="w-[110px] px-4 py-3 text-sm">
                        {transaction.isImportOnly ? (
                          <div className="text-right text-xs text-[var(--text-muted)]">Review row</div>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              className="min-h-8 rounded-full px-3 py-1.5 text-xs"
                              onClick={() => setEditingTransaction(mapTransactionToEditState(transaction))}
                            >
                              Edit
                            </Button>
                            <button
                              type="button"
                              aria-label="Delete transaction"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-rose-50 hover:text-rose-600"
                              disabled={isDeletingTransaction === transaction.id}
                              onClick={() => void handleDeleteTransaction(transaction as Transaction)}
                            >
                              {isDeletingTransaction === transaction.id ? "…" : "ðŸ—‘"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <div className="space-y-4">
                <EmptyState
                  title={dashboardFocusedBucketLabel
                    ? `No transactions found for ${dashboardFocusedBucketLabel} this month.`
                    : "No transactions match these filters"}
                  message={dashboardFocusedBucketLabel
                    ? "Clear the filter to return to the full Transactions table."
                    : "Adjust the quick filter, date range, category filter, or description search to widen the current view."}
                />
                {dashboardFocusedBucketLabel ? (
                  <div className="flex justify-center">
                    <Button type="button" variant="secondary" className="rounded-full px-3 py-1.5 text-xs" onClick={clearDashboardBucketFocus}>
                      Clear filter
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </>
        ) : null}
      </Card>
      </div>

      {editingTransaction ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
          <div
            className="w-full max-w-2xl rounded-[1.75rem] border border-[var(--border-color)] p-5 shadow-xl"
            style={{ background: "var(--surface-color)" }}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-[var(--text-strong)]">Edit Transaction</div>
                <div className="mt-1 text-sm text-[var(--text-muted)]">Update the ledger row without losing its month or category context.</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="min-h-9 min-w-9 rounded-full px-0 text-[var(--text-muted)] hover:bg-[var(--surface-plain)] hover:text-[var(--text-strong)]"
                aria-label="Close edit transaction"
                onClick={() => setEditingTransaction(null)}
              >
                X
              </Button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Input
                label="Transaction date"
                type="date"
                value={editingTransaction.transactionDate}
                onChange={(event) => setEditingTransaction((current) => current ? { ...current, transactionDate: event.target.value } : current)}
              />
              <MoneyInput
                label="Amount"
                name="editAmount"
                value={editingTransaction.amount}
                onChange={(nextValue) => setEditingTransaction((current) => current ? { ...current, amount: nextValue } : current)}
              />
              <Input
                label="Description"
                value={editingTransaction.description}
                onChange={(event) => setEditingTransaction((current) => current ? { ...current, description: event.target.value } : current)}
              />
              <Input
                label="Merchant"
                value={editingTransaction.merchant}
                onChange={(event) => setEditingTransaction((current) => current ? { ...current, merchant: event.target.value } : current)}
              />
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Type</span>
                <select
                  className="ui-field"
                  value={editingTransaction.direction}
                  onChange={(event) => setEditingTransaction((current) => current ? { ...current, direction: event.target.value as "debit" | "credit" } : current)}
                >
                  <option value="debit">debit</option>
                  <option value="credit">credit</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Category</span>
                <select
                  className="ui-field"
                  value={editingTransaction.categoryId}
                  onChange={(event) => {
                    const categoryId = event.target.value;
                    setEditingTransaction((current) => current ? {
                      ...current,
                      categoryId,
                      linkedGoalId: current.linkedGoalId && data?.goals.some((goal) => goal.id === current.linkedGoalId && goal.bucket_id === categoryId)
                        ? current.linkedGoalId
                        : "",
                    } : current);
                  }}
                >
                  <option value=""></option>
                  {(data?.categories ?? []).map((category) => (
                    <option key={category.id} value={category.id}>{category.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Linked debt</span>
                <select
                  className="ui-field"
                  value={editingTransaction.linkedDebtId}
                  onChange={(event) => setEditingTransaction((current) => current ? { ...current, linkedDebtId: event.target.value } : current)}
                >
                  <option value="">None</option>
                  {(data?.debts ?? []).map((debt) => (
                    <option key={debt.id} value={debt.id}>{debt.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-[var(--text-strong)]">Linked goal</span>
                <select
                  className="ui-field"
                  value={editingTransaction.linkedGoalId}
                  onChange={(event) => setEditingTransaction((current) => current ? { ...current, linkedGoalId: event.target.value } : current)}
                >
                  <option value="">None</option>
                  {goalsForEditedBucket.map((goal) => (
                    <option key={goal.id} value={goal.id}>{goal.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <SplitTransactionEditor
              transaction={{
                id: editingTransaction.id,
                transactionDate: editingTransaction.transactionDate,
                description: editingTransaction.description,
                merchant: editingTransaction.merchant || null,
                amount: normalizeMoneyInput(editingTransaction.amount) ?? editingTransaction.amount,
                direction: editingTransaction.direction,
                categoryId: editingTransaction.categoryId || null,
                linkedDebtId: editingTransaction.linkedDebtId || null,
                linkedGoalId: editingTransaction.linkedGoalId || null,
              }}
              categories={data?.categories ?? []}
              parentCategoryLabel={editingTransaction.categoryId ? categoryLookup.get(editingTransaction.categoryId) ?? editingTransaction.categoryId : ""}
              onSaved={async () => {
                setSubmitSuccess("Transaction split saved.");
                await reload();
              }}
              onCleared={async () => {
                setSubmitSuccess("Transaction split cleared.");
                await reload();
              }}
            />

            <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
              <Button type="button" variant="secondary" onClick={() => setEditingTransaction(null)}>
                Cancel
              </Button>
              <Button type="button" disabled={isSavingEdit} onClick={() => void handleSaveEditedTransaction()}>
                {isSavingEdit ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
