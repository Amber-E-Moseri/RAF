import { useEffect, useMemo, useState } from "react";

import { ApiError } from "../api/client";
import {
  getAllocationCategories,
  getAllocationCategoryHistory,
  saveAllocationCategories,
} from "../api/allocationCategoriesApi";
import { ErrorState } from "../components/feedback/ErrorState";
import { LoadingState } from "../components/feedback/LoadingState";
import { SuccessNotice } from "../components/feedback/SuccessNotice";
import { PageShell } from "../components/layout/PageShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { formatPercentWithDigits } from "../lib/format";
import type {
  AllocationCategory,
  AllocationCategorySnapshot,
  AllocationCategoryWriteItem,
} from "../lib/types";

interface DraftCategory extends AllocationCategory {
  isNew: boolean;
  slugEdited: boolean;
}

interface CategoryErrors {
  label?: string;
  slug?: string;
  allocationPercent?: string;
  sortOrder?: string;
}

interface NewCategoryFormState {
  label: string;
  allocationPercent: string;
  isActive: boolean;
}

function toPercentInput(allocationPercent: string) {
  return (Number(allocationPercent) * 100).toFixed(2);
}

function toFractionString(percentInput: string) {
  const normalized = Number(percentInput || "0");
  if (!Number.isFinite(normalized)) {
    return "0.0000";
  }

  return (normalized / 100).toFixed(4);
}

function approximatelyOne(total: number) {
  return Math.abs(total - 1) <= 0.0001;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function toDraftCategory(item: AllocationCategory): DraftCategory {
  return {
    ...item,
    isNew: false,
    slugEdited: true,
  };
}

function createNewCategoryDraft(sortOrder: number, form?: Partial<NewCategoryFormState>): DraftCategory {
  const tempId = `draft_${crypto.randomUUID()}`;
  const label = form?.label?.trim() ?? "";

  return {
    id: tempId,
    slug: slugify(label),
    label,
    sortOrder,
    allocationPercent: toFractionString(form?.allocationPercent ?? "0"),
    isActive: form?.isActive ?? true,
    isSystem: false,
    isNew: true,
    slugEdited: Boolean(label),
  };
}

function validateCategory(category: DraftCategory): CategoryErrors {
  const errors: CategoryErrors = {};

  if (!category.label.trim()) {
    errors.label = "Category name is required.";
  }

  if (!category.slug.trim()) {
    errors.slug = "Slug is required.";
  } else if (!/^[a-z0-9_]+$/.test(category.slug.trim())) {
    errors.slug = "Use lowercase letters, numbers, and underscores only.";
  }

  const allocationPercent = Number(category.allocationPercent);
  if (!Number.isFinite(allocationPercent) || allocationPercent < 0 || allocationPercent > 1) {
    errors.allocationPercent = "Use a valid percentage between 0.00 and 100.00.";
  }

  if (!Number.isInteger(category.sortOrder)) {
    errors.sortOrder = "Sort order must be a whole number.";
  }

  return errors;
}

function buildInlineValidationMessage(activeTotalPercent: number, isValidTotal: boolean) {
  if (isValidTotal) {
    return `Total Allocated: ${activeTotalPercent.toFixed(2)}% - balanced`;
  }

  if (activeTotalPercent < 100) {
    return `Total Allocated: ${activeTotalPercent.toFixed(2)}% - add ${(100 - activeTotalPercent).toFixed(2)}% to reach 100%.`;
  }

  return `Total Allocated: ${activeTotalPercent.toFixed(2)}% - reduce ${(activeTotalPercent - 100).toFixed(2)}% to reach 100%.`;
}

function buildTotalTone(activeTotalPercent: number, isValidTotal: boolean): "success" | "warning" | "danger" {
  if (isValidTotal) {
    return "success";
  }

  return activeTotalPercent > 100 ? "danger" : "warning";
}

function allocationBarWidth(activeTotalPercent: number) {
  return `${Math.max(0, Math.min(activeTotalPercent, 100))}%`;
}

function normalizePercentDraft(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "0.00";
  }

  return numeric.toFixed(2);
}

const DEFAULT_NEW_CATEGORY_FORM: NewCategoryFormState = {
  label: "",
  allocationPercent: "0.00",
  isActive: true,
};

export function AllocationPreferences() {
  const [categories, setCategories] = useState<DraftCategory[]>([]);
  const [percentInputDrafts, setPercentInputDrafts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [updateEndpointMissing, setUpdateEndpointMissing] = useState(false);
  const [isAdvancedMode, setIsAdvancedMode] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [newCategoryForm, setNewCategoryForm] = useState<NewCategoryFormState>(DEFAULT_NEW_CATEGORY_FORM);
  const [history, setHistory] = useState<AllocationCategorySnapshot[]>([]);

  async function loadCategories() {
    setIsLoading(true);
    setLoadError(null);
    setUpdateEndpointMissing(false);

    try {
      const [items, snapshots] = await Promise.all([
        getAllocationCategories(),
        getAllocationCategoryHistory(),
      ]);
      setCategories(items.map(toDraftCategory));
      setHistory(snapshots);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setLoadError("Category settings are not available in this environment.");
      } else {
        setLoadError(error instanceof Error ? error.message : "Allocation categories could not be loaded.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadCategories();
  }, []);

  const validation = useMemo(() => {
    const errorsById = new Map<string, CategoryErrors>();
    const slugCounts = new Map<string, number>();

    for (const category of categories) {
      const trimmedSlug = category.slug.trim();
      if (trimmedSlug) {
        slugCounts.set(trimmedSlug, (slugCounts.get(trimmedSlug) ?? 0) + 1);
      }
    }

    for (const category of categories) {
      const errors = validateCategory(category);
      const trimmedSlug = category.slug.trim();

      if (trimmedSlug && (slugCounts.get(trimmedSlug) ?? 0) > 1) {
        errors.slug = "Slug must be unique.";
      }

      errorsById.set(category.id, errors);
    }

    return errorsById;
  }, [categories]);

  const activeTotalFraction = useMemo(() => {
    return categories.reduce((sum, category) => {
      if (!category.isActive) {
        return sum;
      }

      return sum + Number(category.allocationPercent);
    }, 0);
  }, [categories]);

  const activeTotalPercent = useMemo(() => activeTotalFraction * 100, [activeTotalFraction]);
  const isValidTotal = approximatelyOne(activeTotalFraction);
  const hasFieldErrors = Array.from(validation.values()).some((errors) => Object.keys(errors).length > 0);
  const canSave = categories.length > 0 && isValidTotal && !hasFieldErrors && !updateEndpointMissing;
  const activeCategoryCount = categories.filter((category) => category.isActive).length;
  const inlineValidationMessage = buildInlineValidationMessage(activeTotalPercent, isValidTotal);
  const totalTone = buildTotalTone(activeTotalPercent, isValidTotal);

  function updateCategory(id: string, updater: (category: DraftCategory) => DraftCategory) {
    setCategories((current) => current.map((category) => (
      category.id === id ? updater(category) : category
    )));
    setSaveError(null);
    setSaveSuccess(null);
  }

  function updatePercentDraft(id: string, value: string) {
    setPercentInputDrafts((current) => ({
      ...current,
      [id]: value,
    }));
  }

  function clearPercentDraft(id: string) {
    setPercentInputDrafts((current) => {
      if (!(id in current)) {
        return current;
      }

      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function openAddCategoryModal() {
    setNewCategoryForm(DEFAULT_NEW_CATEGORY_FORM);
    setIsAddModalOpen(true);
    setSaveError(null);
    setSaveSuccess(null);
  }

  function closeAddCategoryModal() {
    setIsAddModalOpen(false);
    setNewCategoryForm(DEFAULT_NEW_CATEGORY_FORM);
  }

  function resetDrafts() {
    setSaveError(null);
    setSaveSuccess(null);
    setIsConfirmModalOpen(false);
    void loadCategories();
  }

  function addCategoryFromModal() {
    if (!newCategoryForm.label.trim()) {
      return;
    }

    const nextSortOrder = categories.reduce((max, category) => Math.max(max, category.sortOrder), 0) + 1;
    const draft = createNewCategoryDraft(nextSortOrder, {
      ...newCategoryForm,
      allocationPercent: normalizePercentDraft(newCategoryForm.allocationPercent),
    });

    setCategories((current) => [...current, draft]);
    closeAddCategoryModal();
  }

  function removeDraftCategory(id: string) {
    setCategories((current) => current.filter((category) => category.id !== id));
    setSaveError(null);
    setSaveSuccess(null);
  }

  function deleteCategory(id: string) {
    removeDraftCategory(id);
  }

  async function handleSave() {
    if (!canSave) {
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const payload: AllocationCategoryWriteItem[] = categories.map((category) => ({
        slug: category.slug.trim(),
        label: category.label.trim(),
        sortOrder: category.sortOrder,
        allocationPercent: category.allocationPercent,
        isActive: category.isActive,
      }));

      await saveAllocationCategories(payload);
      setSaveSuccess("Allocation preferences saved.");
      setIsConfirmModalOpen(false);
      await loadCategories();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setUpdateEndpointMissing(true);
        setSaveError("Category settings cannot be saved in this environment.");
      } else {
        setSaveError(error instanceof Error ? error.message : "Allocation preferences could not be saved.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <PageShell
      eyebrow="Plan"
      title="Allocation without noise."
      description="Adjust allocation preferences, see execution, and keep Buffer visible without turning NOMI into a traditional budgeting app."
      actions={(
        <Button type="button" variant="ghost" onClick={() => setIsAdvancedMode((current) => !current)}>
          {isAdvancedMode ? "Hide Advanced" : "Show Advanced"}
        </Button>
      )}
    >
      <section className="grid gap-6">
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Card>
            <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Total allocated</p>
            <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">{activeTotalPercent.toFixed(1)}%</p>
          </Card>
          <Card>
            <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Unallocated</p>
            <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">{Math.max(0, 100 - activeTotalPercent).toFixed(1)}%</p>
          </Card>
          <Card>
            <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Active categories</p>
            <p className="mt-2 text-[25px] font-black tracking-tight text-[var(--text-strong)]">{activeCategoryCount}</p>
          </Card>
        </section>

        <Card
          title="Current allocation"
          subtitle="Keep active categories at exactly 100% before saving."
          actions={<Badge tone={totalTone}>{activeCategoryCount} active</Badge>}
        >
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>{activeTotalPercent.toFixed(2)}% allocated</span>
              <span>{isValidTotal ? "Balanced" : inlineValidationMessage}</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
              <div
                className="h-full rounded-full bg-[var(--primary-color)] transition-[width] duration-200"
                style={{ width: allocationBarWidth(activeTotalPercent) }}
              />
            </div>
            {!isValidTotal ? (
              <p className="mt-2 text-xs text-amber-700">
                Active allocation percentages must equal {formatPercentWithDigits("1", 2)} before save is allowed.
              </p>
            ) : null}
            {hasFieldErrors ? (
              <p className="mt-2 text-xs text-rose-700">
                One or more categories still need attention before preferences can be saved.
              </p>
            ) : null}
          </div>
          {isLoading ? <LoadingState label="Loading categories..." /> : null}
          {!isLoading && loadError ? <ErrorState title="Failed to load allocation preferences" message={loadError} onRetry={() => void loadCategories()} /> : null}
          {!isLoading && !loadError && !categories.length ? (
            <EmptyState
              title="No categories available"
              message="Add your first category to start splitting each deposit."
            />
          ) : null}
          {!isLoading && !loadError && categories.length ? (
            <>
              <div className="hidden border-b border-[var(--border-color)] pb-2 md:grid md:grid-cols-[1fr,100px,60px,auto] md:items-center md:gap-4">
                <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Category</span>
                <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Share</span>
                <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">Active</span>
                <span />
              </div>

              <div className="divide-y divide-[var(--border-color)]">
                {categories.map((category, index) => {
                  const errors = validation.get(category.id) ?? {};
                  const percentInput = percentInputDrafts[category.id] ?? toPercentInput(category.allocationPercent);
                  const dotHue = (index * 137.5) % 360;

                  return (
                    <div key={category.id}>
                      <div className={`grid gap-3 py-3 md:grid-cols-[1fr,100px,60px,auto] md:items-center ${!category.isActive ? "opacity-50" : ""}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `hsl(${dotHue}, 55%, 55%)` }} />
                          <input
                            className="ui-field !border-0 !bg-transparent !px-0 !py-1 text-sm font-medium text-[var(--text-strong)]"
                            value={category.label}
                            onChange={(event) => updateCategory(category.id, (current) => {
                              const nextLabel = event.target.value;
                              return {
                                ...current,
                                label: nextLabel,
                                slug: current.isNew && !current.slugEdited ? slugify(nextLabel) : current.slug,
                              };
                            })}
                          />
                          {errors.label ? <span className="shrink-0 text-xs text-rose-600" title={errors.label}>!</span> : null}
                        </div>

                        <div className="relative">
                          <input
                            className="ui-field w-full pr-7 text-sm"
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            inputMode="decimal"
                            value={percentInput}
                            onFocus={(event) => {
                              updatePercentDraft(category.id, percentInput);
                              event.currentTarget.select();
                            }}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              updatePercentDraft(category.id, nextValue);
                              updateCategory(category.id, (current) => ({
                                ...current,
                                allocationPercent: toFractionString(nextValue),
                              }));
                            }}
                            onBlur={(event) => {
                              const normalizedPercent = normalizePercentDraft(event.target.value);
                              updateCategory(category.id, (current) => ({
                                ...current,
                                allocationPercent: toFractionString(normalizedPercent),
                              }));
                              clearPercentDraft(category.id);
                            }}
                          />
                          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-[var(--text-muted)]">%</span>
                          {errors.allocationPercent ? <p className="mt-1 text-[10px] text-rose-600">{errors.allocationPercent}</p> : null}
                        </div>

                        <button
                          type="button"
                          onClick={() => updateCategory(category.id, (current) => ({ ...current, isActive: !current.isActive }))}
                          className={`relative h-6 w-[42px] shrink-0 rounded-full transition ${category.isActive ? "bg-[var(--primary-color)]" : "bg-[#d6dbe0]"}`}
                        >
                          <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition ${category.isActive ? "left-[21px]" : "left-[3px]"}`} />
                        </button>

                        <div className="flex items-center gap-2">
                          {category.isSystem ? (
                            <Badge tone="warning" className="px-2 py-0.5 text-[9px]">System</Badge>
                          ) : null}
                          {!category.isSystem && isAdvancedMode ? (
                            <button type="button" className="text-xs text-rose-600 hover:underline" onClick={() => deleteCategory(category.id)}>Delete</button>
                          ) : null}
                        </div>
                      </div>

                      {isAdvancedMode ? (
                        <div className="mb-3 ml-[22px] grid gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--surface-elevated)] p-3 md:grid-cols-[1fr,120px]">
                          <label className="block">
                            <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">Slug</span>
                            <input
                              className="ui-field text-sm disabled:opacity-60"
                              value={category.slug}
                              disabled={!category.isNew}
                              onChange={(event) => updateCategory(category.id, (current) => ({
                                ...current,
                                slug: slugify(event.target.value),
                                slugEdited: true,
                              }))}
                            />
                            {errors.slug ? <p className="mt-1 text-[10px] text-rose-600">{errors.slug}</p> : null}
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">Sort order</span>
                            <input
                              className="ui-field text-sm"
                              type="number"
                              step="1"
                              value={category.sortOrder}
                              onChange={(event) => updateCategory(category.id, (current) => ({
                                ...current,
                                sortOrder: Number.parseInt(event.target.value || "0", 10),
                              }))}
                            />
                            {errors.sortOrder ? <p className="mt-1 text-[10px] text-rose-600">{errors.sortOrder}</p> : null}
                          </label>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex flex-col gap-3 border-t border-[var(--border-color)] pt-4 sm:flex-row sm:items-center sm:justify-between">
                <Button type="button" variant="secondary" onClick={openAddCategoryModal}>Add Category</Button>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <Button type="button" variant="secondary" onClick={resetDrafts} disabled={isLoading || isSaving}>Cancel</Button>
                  <Button type="button" disabled={!canSave || isSaving} onClick={() => setIsConfirmModalOpen(true)}>
                    {isSaving ? "Saving..." : "Save Preferences"}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </Card>

        <Card title="Allocation History" subtitle="Historical snapshots stay read-only and continue powering prior months.">
          {history.length ? (
            <div className="space-y-3">
              {history.map((snapshot) => (
                <div key={snapshot.snapshotId} className="rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-elevated)" }}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-strong)]">
                        {snapshot.effectiveFrom ?? "Unknown start"}{snapshot.supersededAt ? ` to ${snapshot.supersededAt}` : " to present"}
                      </p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        Prior months continue using this snapshot for reporting accuracy.
                      </p>
                    </div>
                    <Badge tone={snapshot.supersededAt ? "neutral" : "success"}>
                      {snapshot.supersededAt ? "Historical" : "Current"}
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {snapshot.items
                      .filter((item) => item.isActive)
                      .sort((left, right) => left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug))
                      .map((item) => (
                        <span key={item.id} className="rounded-full border px-3 py-1 text-xs text-[var(--text-muted)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                          {item.label} {formatPercentWithDigits(item.allocationPercent, 2)}
                        </span>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No history yet"
              message="Your saved category snapshots will appear here after the first update."
            />
          )}
        </Card>

        {saveError ? <ErrorState title="Failed to save allocation preferences" message={saveError} /> : null}
        {saveSuccess ? <SuccessNotice title="Preferences saved" message={saveSuccess} /> : null}
      </section>

      {isAddModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 px-4">
          <div className="w-full max-w-lg rounded-[28px] border p-6 shadow-2xl" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-muted)]">New Category</p>
                <h3 className="mt-2 text-xl font-bold tracking-tight text-[var(--text-strong)]">Add Category</h3>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                  Start with the name, percentage, and active state. Backend details stay hidden until needed.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border px-3 py-1 text-sm transition"
                style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
                onClick={closeAddCategoryModal}
              >
                Close
              </button>
            </div>

            <div className="mt-6 grid gap-4">
              <label className="block">
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Category name
                </span>
                <input
                  className="ui-field"
                  value={newCategoryForm.label}
                  onChange={(event) => setNewCategoryForm((current) => ({
                    ...current,
                    label: event.target.value,
                  }))}
                  placeholder="Emergency Fund"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Starting percentage
                </span>
                <div className="relative">
                  <input
                    className="ui-field pr-10"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={newCategoryForm.allocationPercent}
                    onChange={(event) => setNewCategoryForm((current) => ({
                      ...current,
                      allocationPercent: event.target.value,
                    }))}
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm text-[var(--text-muted)]">%</span>
                </div>
              </label>

              <label className="flex items-center justify-between rounded-2xl border px-4 py-3 text-sm text-[var(--text-strong)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-elevated)" }}>
                <span>Active right away</span>
                <input
                  type="checkbox"
                  checked={newCategoryForm.isActive}
                  onChange={(event) => setNewCategoryForm((current) => ({
                    ...current,
                    isActive: event.target.checked,
                  }))}
                />
              </label>
            </div>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Button type="button" variant="secondary" onClick={closeAddCategoryModal}>
                Cancel
              </Button>
              <Button type="button" disabled={!newCategoryForm.label.trim()} onClick={addCategoryFromModal}>
                Add Category
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {isConfirmModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 px-4">
          <div className="w-full max-w-lg rounded-[28px] border p-6 shadow-2xl" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-muted)]">Allocation Update</p>
            <h3 className="mt-2 text-xl font-bold tracking-tight text-[var(--text-strong)]">Update allocation?</h3>
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              Updating your allocation will apply from today. Your previous allocation will still be used for all prior months.
              This will not change any historical reports.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button type="button" variant="secondary" onClick={() => setIsConfirmModalOpen(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleSave()} disabled={isSaving}>
                {isSaving ? "Updating..." : "Update allocation"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
