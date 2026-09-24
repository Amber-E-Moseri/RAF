import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { LoadingState } from "../components/feedback/LoadingState";
import { ErrorState } from "../components/feedback/ErrorState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Money } from "../components/ui/Money";
import { ImportRuleEditor } from "../components/imports/ImportRuleEditor";
import { LoadingSpinner } from "../components/feedback/LoadingSpinner";
import { formatIsoDate } from "../lib/format";
import type { ImportClassificationPayload } from "../lib/types";

type BadgeTone = "neutral" | "success" | "warning" | "danger";
type ImportPanelMode = "review" | "details";
type ImportRuleMode = "suggestion" | "reusable_rule";
type ImportClassificationType = ImportClassificationPayload["classification_type"];

function formatOptionalDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

interface TransactionImportWorkflowProps {
  // Import Bank Statement
  selectedImportFile: File | null;
  onSelectedImportFileChange: (file: File | null) => void;
  isImporting: boolean;
  importError: string | null;
  importSuccess: string | null;
  onImportUpload: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onImportRefresh: () => Promise<void>;
  activeMonthLabel: string;
  importsSummary: {
    total: number;
    unreviewed: number;
    earliestDate?: string | null;
    latestDate?: string | null;
  };

  // Imported Rows Review
  isImportsExpanded: boolean;
  onImportsExpandedChange: (expanded: boolean) => void;
  importsView: "needs_review" | "ignored" | "processed";
  onImportsViewChange: (view: "needs_review" | "ignored" | "processed") => void;
  needsReviewImports: any[];
  ignoredImports: any[];
  processedImports: any[];
  selectedImportIds: string[];
  bulkBucketId: string;
  bulkRuleMode: "none" | "suggestion" | "reusable_rule";
  isBulkReviewing: boolean;
  reviewError: string | null;
  reviewSuccess: string | null;
  reviewFocusId: string | null;
  isLoading: boolean;
  error: string | null;
  data: any | null;
  importPanelModes: Record<string, ImportPanelMode | null>;
  openImportMenuId: string | null;
  openAdvancedMenuId: string | null;
  editingRuleId: string | null;
  dismissedRuleEffects: Record<string, boolean>;
  importsInView: any[];

  // Handlers
  onToggleSelectAllImports: () => void;
  onToggleImportSelection: (id: string) => void;
  onBulkBucketIdChange: (id: string) => void;
  onBulkRuleModeChange: (mode: "none" | "suggestion" | "reusable_rule") => void;
  onBulkReview: (action: string) => Promise<void>;
  onAdvanceToNextUnreviewed: (id: string) => void;
  onOpenImportMenu: (id: string) => void;
  onCloseImportMenu: () => void;
  onUpdateReviewDraft: (item: any, patch: any) => void;
  onApplySuggestion: (item: any) => void;
  onResetRuleEffect: (item: any) => void;
  onHandleReviewImportedRow: (item: any) => Promise<void>;
  onHandleUnignoreImportedRow: (item: any) => Promise<void>;
  onHandleUnprocessImportedRow: (item: any) => Promise<void>;
  onOpenImportPanel: (id: string, mode: ImportPanelMode) => void;
  onCloseImportPanel: (id: string) => void;
  onToggleAdvancedMenu: (id: string) => void;
  onToggleImportMenu: (id: string) => void;
  onHandleIgnoreImportedRow: (item: any) => Promise<void>;
  onHandleDeleteRule: (rule: any) => Promise<void>;
  onHandleRuleModeUpdate: (rule: any, mode: ImportRuleMode, autoApply: boolean) => Promise<void>;
  onHandleSaveRuleEdits: (rule: any) => Promise<void>;

  // Import History
  isHistoryExpanded: boolean;
  onHistoryExpandedChange: (expanded: boolean) => void;
  selectedImportHistoryId: string | null;
  isLoadingImportHistoryDetail: boolean;
  importHistoryDetailError: string | null;
  importHistoryDetail: any | null;
  onSelectImportHistory: (id: string) => Promise<void>;

  // Close handler
  onClose: () => void;

  // Derived state helpers
  getReviewDraft: (item: any) => any;
  importRowStatus: (item: any, draft: any) => { tone: BadgeTone; label: string };
  importStateNote: (item: any, draft: any) => string;
  getBucketLabel: (item: any) => string;
  getLinkedLabel: (item: any) => string;
  primaryReviewLabel: (classificationType: ImportClassificationType) => string;
  requiresCategorySelection: (classificationType: ImportClassificationType) => boolean;
  requiresDebtSelection: (classificationType: ImportClassificationType) => boolean;
  requiresFixedBillSelection: (classificationType: ImportClassificationType) => boolean;
  requiresGoalSelection: (classificationType: ImportClassificationType) => boolean;
  getRuleDraft: (rule: any) => any;
  updateRuleDraft: (rule: any, patch: any) => void;
  looksLikeSavingsTransfer: (item: any) => boolean;
  importHistoryTitle: (item: any) => string;
  importHistoryAccountLabel: (item: any) => string;
  importHistoryReviewLabel: (item: any) => string;
  importHistoryLinkedLabel: (item: any) => string;
  debtLookup: Map<string, string>;
  fixedBillLookup: Map<string, string>;
  goalLookup: Map<string, string>;
  pendingRuleId: string | null;
}

export function TransactionImportWorkflow({
  selectedImportFile,
  onSelectedImportFileChange,
  isImporting,
  importError,
  importSuccess,
  onImportUpload,
  onImportRefresh,
  activeMonthLabel,
  importsSummary,
  isImportsExpanded,
  onImportsExpandedChange,
  importsView,
  onImportsViewChange,
  needsReviewImports,
  ignoredImports,
  processedImports,
  selectedImportIds,
  bulkBucketId,
  bulkRuleMode,
  isBulkReviewing,
  reviewError,
  reviewSuccess,
  reviewFocusId,
  isLoading,
  error,
  data,
  importPanelModes,
  openImportMenuId,
  openAdvancedMenuId,
  editingRuleId,
  dismissedRuleEffects,
  importsInView,
  onToggleSelectAllImports,
  onToggleImportSelection,
  onBulkBucketIdChange,
  onBulkRuleModeChange,
  onBulkReview,
  onAdvanceToNextUnreviewed,
  onOpenImportMenu,
  onCloseImportMenu,
  onUpdateReviewDraft,
  onApplySuggestion,
  onResetRuleEffect,
  onHandleReviewImportedRow,
  onHandleUnignoreImportedRow,
  onHandleUnprocessImportedRow,
  onOpenImportPanel,
  onCloseImportPanel,
  onToggleAdvancedMenu,
  onToggleImportMenu,
  onHandleIgnoreImportedRow,
  onHandleDeleteRule,
  onHandleRuleModeUpdate,
  onHandleSaveRuleEdits,
  isHistoryExpanded,
  onHistoryExpandedChange,
  selectedImportHistoryId,
  isLoadingImportHistoryDetail,
  importHistoryDetailError,
  importHistoryDetail,
  onSelectImportHistory,
  onClose,
  getReviewDraft,
  importRowStatus,
  importStateNote,
  getBucketLabel,
  getLinkedLabel,
  primaryReviewLabel,
  requiresCategorySelection,
  requiresDebtSelection,
  requiresFixedBillSelection,
  requiresGoalSelection,
  getRuleDraft,
  updateRuleDraft,
  looksLikeSavingsTransfer,
  importHistoryTitle,
  importHistoryAccountLabel,
  importHistoryReviewLabel,
  importHistoryLinkedLabel,
  debtLookup,
  fixedBillLookup,
  goalLookup,
  pendingRuleId,
}: TransactionImportWorkflowProps) {
  return (
    <div className="space-y-4">
      <div className="mb-6 flex items-center justify-between border-b pb-4" style={{ borderColor: "var(--border-color)" }}>
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-strong)]">Import Bank Statement</h2>
          <p className="text-sm text-[var(--text-muted)]">Upload statements, review rows, and manage history</p>
        </div>
        <Button type="button" variant="secondary" onClick={onClose}>
          Back to transactions
        </Button>
      </div>

      <Card
        title="Import Bank Statement"
        subtitle="Upload a PDF bank statement to create imported rows for review. Nothing becomes a completed RAF transaction until you approve it."
        actions={(
          <Button type="button" variant="secondary" disabled={isLoading || isImporting} onClick={() => void onImportRefresh()}>
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
                  onSelectedImportFileChange(file);
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
            <Button type="button" variant="ghost" onClick={() => onImportsExpandedChange(!isImportsExpanded)}>
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
                  onImportsViewChange("needs_review");
                  onImportsExpandedChange(true);
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
                  onImportsViewChange("ignored");
                  onImportsExpandedChange(true);
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
                  onImportsViewChange("processed");
                  onImportsExpandedChange(true);
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
                      <div className="flex items-center gap-3">
                        <label className="inline-flex items-center gap-3 text-sm font-medium text-raf-ink">
                          <input
                            type="checkbox"
                            checked={needsReviewImports.length > 0 && selectedImportIds.length === needsReviewImports.length}
                            onChange={onToggleSelectAllImports}
                          />
                          <span>Select all</span>
                        </label>
                        {needsReviewImports.length > 0 ? (
                          <button
                            type="button"
                            className="rounded-full border border-[var(--border-color)] px-3 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-elevated)]"
                            onClick={() => onAdvanceToNextUnreviewed(reviewFocusId ?? "")}
                          >
                            Next unreviewed ({needsReviewImports.length})
                          </button>
                        ) : null}
                      </div>
                      {selectedImportIds.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <Badge tone="warning">{selectedImportIds.length} selected</Badge>
                          <select
                            className="rounded-full border border-stone-300 bg-white px-3 py-2 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                            value={bulkBucketId}
                            onChange={(event) => onBulkBucketIdChange(event.target.value)}
                          >
                            <option value="">Choose category</option>
                            {data.categories.map((category: any) => (
                              <option key={category.id} value={category.id}>{category.label}</option>
                            ))}
                          </select>
                          <select
                            className="rounded-full border border-stone-300 bg-white px-3 py-2 text-sm text-raf-ink outline-none transition focus:border-raf-moss focus:ring-2 focus:ring-raf-sage"
                            value={bulkRuleMode}
                            onChange={(event) => onBulkRuleModeChange(event.target.value as "none" | "suggestion" | "reusable_rule")}
                          >
                            <option value="none">No saved memory</option>
                            <option value="suggestion">Suggest this choice next time</option>
                            <option value="reusable_rule">Save as reusable rule</option>
                          </select>
                          <Button type="button" disabled={isBulkReviewing} onClick={() => void onBulkReview("approve")}>
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
                      const isPending = pendingRuleId === item.id;
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
                        <div key={item.id} id={`import-row-${item.id}`} className={reviewFocusId === item.id ? "ring-2 ring-inset ring-[var(--primary-color)] rounded-lg" : undefined}>
                          <div className={`grid gap-2 px-4 py-2.5 lg:grid-cols-[36px,88px,minmax(0,320px),112px,132px,132px,112px,44px] lg:items-start ${isIgnored ? "bg-stone-50/70" : ""}`}>
                            <div className="flex items-center justify-center">
                              {needsReview ? (
                                <input
                                  type="checkbox"
                                  checked={selectedImportIds.includes(item.id)}
                                  onChange={() => onToggleImportSelection(item.id)}
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
                                  <button type="button" className="text-[var(--primary-color)]" onClick={() => onResetRuleEffect(item)}>Undo</button>
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
                                  onChange={(event) => onUpdateReviewDraft(item, { categoryId: event.target.value })}
                                >
                                  <option value="">Select a category</option>
                                  {data.categories.map((category: any) => (
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
                                  onClick={() => void onHandleReviewImportedRow(item)}
                                >
                                  {isPending ? <LoadingSpinner inline size="sm" label="Approving..." /> : primaryReviewLabel(draft.classificationType)}
                                </Button>
                              ) : isIgnored ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  className="min-h-9 rounded-full px-3 py-1.5 text-xs"
                                  disabled={isPending}
                                  onClick={() => void onHandleUnignoreImportedRow(item)}
                                >
                                  Unignore
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  className="min-h-9 rounded-full px-3 py-1.5 text-xs"
                                  disabled={isPending}
                                  onClick={() => void onHandleUnprocessImportedRow(item)}
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
                                onClick={() => onToggleImportMenu(item.id)}
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
                                        onOpenImportPanel(item.id, "review");
                                        onCloseImportMenu();
                                      }}
                                    >
                                      Review transaction
                                    </button>
                                  ) : null}
                                  {isIgnored ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                      onClick={() => void onHandleUnignoreImportedRow(item)}
                                    >
                                      Unignore
                                    </button>
                                  ) : null}
                                  {!needsReview && !isIgnored ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                      onClick={() => void onHandleUnprocessImportedRow(item)}
                                    >
                                      Unprocess transaction
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                    onClick={() => {
                                      onOpenImportPanel(item.id, "details");
                                      onCloseImportMenu();
                                    }}
                                  >
                                    View details
                                  </button>
                                  {needsReview ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-600 transition hover:bg-[var(--surface-plain)] hover:text-rose-500"
                                      onClick={() => void onHandleIgnoreImportedRow(item)}
                                    >
                                      Ignore transaction
                                    </button>
                                  ) : null}
                                  {activeRule ? (
                                    <button
                                      type="button"
                                      className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                      onClick={() => onToggleAdvancedMenu(item.id)}
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
                                          onClick={() => void onHandleRuleModeUpdate(activeRule, "suggestion", false)}
                                        >
                                          Convert to suggestion only
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--text-strong)] transition hover:bg-[var(--surface-plain)]"
                                        onClick={() => {
                                          // setEditingRuleId(activeRule.id); -- handled by parent via updateRuleDraft
                                          onOpenImportPanel(item.id, "review");
                                          onCloseImportMenu();
                                        }}
                                      >
                                        Edit rule
                                      </button>
                                      <button
                                        type="button"
                                        className="block w-full rounded-xl px-3 py-2 text-left text-sm text-rose-600 transition hover:bg-[var(--surface-plain)] hover:text-rose-500"
                                        onClick={() => void onHandleDeleteRule(activeRule)}
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
                                <div className="mb-4 rounded-2xl border-2 px-4 py-3" style={{ borderColor: "var(--primary-color)", background: "color-mix(in srgb, var(--primary-color) 6%, var(--surface-color))" }}>
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--primary-color)" }}>
                                        {activeRule.auto_apply ? "Auto-applied by rule" : "Categorization suggestion"}
                                      </div>
                                      <div className="mt-0.5 text-sm font-medium text-[var(--text-strong)]">
                                        "{activeRule.match_value ?? activeRule.normalized_description}"
                                      </div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {needsReview ? (
                                        <Button type="button" variant="primary" onClick={() => onApplySuggestion(item)}>
                                          Apply suggestion
                                        </Button>
                                      ) : null}
                                      {!activeRule.auto_apply && needsReview ? (
                                        <Button type="button" variant="secondary" onClick={() => { /* setEditingRuleId */ updateRuleDraft(activeRule, {}); }}>
                                          Remember this choice
                                        </Button>
                                      ) : null}
                                      {activeRule.auto_apply ? (
                                        <Button type="button" variant="secondary" onClick={() => onResetRuleEffect(item)}>
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
                                  onCancel={() => { /* setEditingRuleId(null) */ }}
                                  onSave={() => void onHandleSaveRuleEdits(activeRule)}
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
                                        onChange={(event) => onUpdateReviewDraft(item, {
                                          classificationType: event.target.value as any,
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
                                          onChange={(event) => onUpdateReviewDraft(item, { categoryId: event.target.value })}
                                        >
                                          <option value="">Select allocation bucket</option>
                                          {data.categories.map((category: any) => (
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
                                          onChange={(event) => onUpdateReviewDraft(item, { debtId: event.target.value })}
                                        >
                                          <option value="">Select debt</option>
                                          {data.debts.map((debt: any) => (
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
                                          onChange={(event) => onUpdateReviewDraft(item, { fixedBillId: event.target.value })}
                                        >
                                          <option value="">Select fixed bill</option>
                                          {data.fixedBills.map((bill: any) => (
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
                                          onChange={(event) => onUpdateReviewDraft(item, { goalId: event.target.value })}
                                        >
                                          <option value="">Select goal</option>
                                          {data.goals.map((goal: any) => (
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
                                        onChange={(event) => onUpdateReviewDraft(item, { reviewNote: event.target.value })}
                                      />
                                    </div>

                                    <div className="md:col-span-2">
                                      <span className="mb-2 block text-sm font-medium text-raf-ink">Remember this choice</span>
                                    </div>
                                    <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
                                      <label className="flex items-start gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
                                        <input
                                          type="radio"
                                          name={`rule-mode-${item.id}`}
                                          className="mt-1"
                                          checked={draft.saveRuleMode === "suggestion"}
                                          disabled={isPending || isBulkReviewing}
                                          onChange={() => onUpdateReviewDraft(item, { saveRuleMode: "suggestion", autoApplyRule: false })}
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
                                          onChange={() => onUpdateReviewDraft(item, { saveRuleMode: "reusable_rule", autoApplyRule: true })}
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
                                        onCloseImportPanel(item.id);
                                        onCloseImportMenu();
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      type="button"
                                      disabled={isPending || isBulkReviewing}
                                      onClick={() => void onHandleReviewImportedRow(item)}
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
                                    <Button type="button" variant="secondary" onClick={() => onCloseImportPanel(item.id)}>
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
                                      onClick={() => void onHandleUnprocessImportedRow(item)}
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

      <Card
        title="Import History"
        subtitle="A read-only record of past import batches."
        actions={(
          <Button type="button" variant="ghost" onClick={() => onHistoryExpandedChange(!isHistoryExpanded)}>
            {isHistoryExpanded ? "Collapse" : "Expand"}
          </Button>
        )}
      >
        {!isHistoryExpanded ? null : isLoading ? <LoadingState label="Loading import history..." /> : null}
        {isHistoryExpanded && !isLoading && (data?.importHistory?.length ?? 0) === 0 ? (
          <EmptyState
            title="No import history"
            message="Import history will appear here once you have uploaded bank statements or imported rows."
          />
        ) : null}
        {isHistoryExpanded && !isLoading && (data?.importHistory?.length ?? 0) > 0 ? (
          <div className="divide-y" style={{ borderColor: "var(--border-color)" }}>
            {(data?.importHistory ?? []).map((item: any) => {
              const isSelected = selectedImportHistoryId === item.id;
              return (
                <div key={item.id} className="py-3">
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-3 text-left"
                    onClick={() => void onSelectImportHistory(item.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-[var(--text-strong)] truncate">{importHistoryTitle(item)}</div>
                      <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        {importHistoryAccountLabel(item)} · {formatOptionalDateTime(item.created_at)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[12px] text-[var(--text-muted)]">{item.row_count} rows</div>
                      <div className="text-[11px] text-[var(--text-muted)]">{importHistoryReviewLabel(item)}</div>
                    </div>
                  </button>
                  {isSelected ? (
                    <div className="mt-3">
                      {isLoadingImportHistoryDetail ? <LoadingState label="Loading detail..." /> : null}
                      {importHistoryDetailError ? (
                        <p className="text-[12px] italic text-rose-500">{importHistoryDetailError}</p>
                      ) : null}
                      {importHistoryDetail?.id === item.id ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-3">
                            <div>
                              <div className="text-[var(--text-muted)]">Linked transactions</div>
                              <div className="font-medium text-[var(--text-strong)]">{importHistoryLinkedLabel(item)}</div>
                            </div>
                            <div>
                              <div className="text-[var(--text-muted)]">Status</div>
                              <div className="font-medium text-[var(--text-strong)]">{item.status}</div>
                            </div>
                            <div>
                              <div className="text-[var(--text-muted)]">Updated</div>
                              <div className="font-medium text-[var(--text-strong)]">{formatOptionalDateTime(item.updated_at)}</div>
                            </div>
                          </div>
                          {importHistoryDetail.rows.length > 0 ? (
                            <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--border-color)" }}>
                              <table className="w-full text-[12px]">
                                <thead>
                                  <tr className="border-b text-left text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                                    <th className="px-3 py-2 font-medium">Date</th>
                                    <th className="px-3 py-2 font-medium">Description</th>
                                    <th className="px-3 py-2 font-medium text-right">Amount</th>
                                    <th className="px-3 py-2 font-medium">Status</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y" style={{ borderColor: "var(--border-color)" }}>
                                  {importHistoryDetail.rows.map((row: any) => (
                                    <tr key={row.id}>
                                      <td className="px-3 py-2 text-[var(--text-muted)]">{row.date ?? "—"}</td>
                                      <td className="max-w-[200px] truncate px-3 py-2 text-[var(--text-strong)]">{row.description ?? "—"}</td>
                                      <td className="px-3 py-2 text-right font-medium text-[var(--text-strong)]">{row.amount ?? "—"}</td>
                                      <td className="px-3 py-2 text-[var(--text-muted)]">{row.status}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <p className="text-[12px] italic text-[var(--text-muted)]">No row-level detail available.</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </Card>
    </div>
  );

  function handleImportUpload(event: React.FormEvent<HTMLFormElement>) {
    void onImportUpload(event);
  }
}
