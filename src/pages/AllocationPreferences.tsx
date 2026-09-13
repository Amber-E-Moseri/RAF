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

export function AllocationPreferences({ embedded = false }: { embedded?: boolean } = {}) {
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
      eyebrow="Planning"
      title="Allocation Preferences"
      description="Adjust category percentages and keep the active total balanced."
      embedded={embedded}
      actions={(
        <Button type="button" variant="ghost" onClick={() => setIsAdvancedMode((current) => !current)}>
          {isAdvancedMode ? "Hide Advanced" : "Show Advanced"}
        </Button>
      )}
    >
      <section className="grid gap-4">
        <Card
          title="Category Summary"
          subtitle="Keep active categories at exactly 100% before saving."
          actions={(
            <Badge tone={totalTone}>
              {activeCategoryCount} active
            </Badge>
          )}
        >
          <div className="space-y-4">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <div>
                  <p className="text-[11px] font-medium text-[var(--text-muted)]">Total allocated</p>
                  <p className="mt-1 text-3xl font-bold tracking-tight text-[var(--text-strong)]">{activeTotalPercent.toFixed(2)}%</p>
                </div>
                <div className="max-w-sm text-right text-sm text-[var(--text-muted)]">
                  {inlineValidationMessage}
                </div>
              </div>
              <div className="mt-4 h-3 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
                <div
                  className="h-full rounded-full bg-[var(--primary-color)] transition-[width] duration-200"
                  style={{ width: allocationBarWidth(activeTotalPercent) }}
                />
              </div>
            </div>
            {!isValidTotal ? (
              <p className="text-sm text-amber-700">
                Active allocation percentages must equal {formatPercentWithDigits("1", 2)} before save is allowed.
              </p>
            ) : null}
            {hasFieldErrors ? (
              <p className="text-sm text-rose-700">
                One or more categories still need attention before preferences can be saved.
              </p>
            ) : null}
          </div>
        </Card>

        <Card title="Categories" subtitle="Focus on names, percentages, and whether each category is active.">
          {isLoading ? <LoadingState label="Loading categories..." /> : null}
          {!isLoading && loadError ? <ErrorState title="Failed to load allocation preferences" message={loadError} onRetry={() => void loadCategories()} /> : null}
          {!isLoading && !loadError && !categories.length ? (
            <EmptyState
              title="No categories available"
              message="Add your first category to start splitting each deposit."
            />
          ) : null}
          {!isLoading && !loadError && categories.length ? (
            <div className="space-y-4">
              {categories.map((category) => {
                const errors = validation.get(category.id) ?? {};
                const percentInput = percentInputDrafts[category.id] ?? toPercentInput(category.allocationPercent);

                return (
                  <div
                    key={category.id}
                    className={`rounded-3xl border p-4 transition ${category.isActive ? "" : "opacity-70"}`.trim()}
                    style={{ borderColor: "var(--border-color)", background: "var(--surface-elevated)" }}
                  >
                    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.8fr),132px,180px,180px] xl:items-center">
                      <div className="min-w-0">
                        <label className="block">
                          <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                            Category name
                          </span>
                          <input
                            className="ui-field"
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
                        </label>
                        {errors.label ? <p className="mt-2 text-xs text-rose-600">{errors.label}</p> : null}
                      </div>

                      <label className="block">
                        <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                          Percentage
                        </span>
                        <div className="relative">
                          <input
                            className="ui-field pr-10"
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
                          <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm text-[var(--text-muted)]">%</span>
                        </div>
                        {errors.allocationPercent ? <p className="mt-2 text-xs text-rose-600">{errors.allocationPercent}</p> : null}
                      </label>

                      <div className="flex flex-col gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                          Active
                        </span>
                        <div className="flex items-center justify-between rounded-2xl border px-4 py-3 text-sm text-[var(--text-strong)]" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                          <label className="flex items-center gap-3">
                            <span className="min-w-[26px] text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                              {category.isActive ? "On" : "Off"}
                            </span>
                            <input
                              type="checkbox"
                              className="peer sr-only"
                              checked={category.isActive}
                              onChange={(event) => updateCategory(category.id, (current) => ({
                                ...current,
                                isActive: event.target.checked,
                              }))}
                            />
                            <span className="relative inline-flex h-7 w-12 items-center rounded-full bg-[var(--surface-elevated)] transition peer-checked:bg-[var(--primary-color)]">
                              <span className="absolute left-1 h-5 w-5 rounded-full bg-[var(--surface-plain)] shadow-sm transition-transform peer-checked:translate-x-5" />
                            </span>
                          </label>
                          <Badge tone={category.isActive ? "success" : "neutral"}>
                            {category.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                          Controls
                        </span>
                        <div className="flex items-center justify-between rounded-[1.1rem] border px-3 py-2.5" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                          <div className="flex items-center gap-2">
                            {category.isSystem ? (
                              <Badge tone="warning" className="px-2 py-0.5 text-[10px]">
                                System
                              </Badge>
                            ) : (
                              <Badge tone="neutral" className="px-2 py-0.5 text-[10px]">
                                Custom
                              </Badge>
                            )}
                          </div>
                          <span className="text-[12px] text-[var(--text-muted)]">
                            {isAdvancedMode ? "Advanced open" : "Simple view"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {isAdvancedMode ? (
                      <div className="mt-4 rounded-2xl border p-4" style={{ borderColor: "var(--border-color)", background: "var(--surface-plain)" }}>
                        <div className="grid gap-4 md:grid-cols-[1fr,160px,auto]">
                          <label className="block">
                            <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                              Slug
                            </span>
                            <input
                              className="ui-field disabled:opacity-60"
                              value={category.slug}
                              disabled={!category.isNew}
                              onChange={(event) => updateCategory(category.id, (current) => ({
                                ...current,
                                slug: slugify(event.target.value),
                                slugEdited: true,
                              }))}
                            />
                            {errors.slug ? <p className="mt-2 text-xs text-rose-600">{errors.slug}</p> : null}
                          </label>
                          <label className="block">
                            <span className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                              Sort order
                            </span>
                            <input
                              className="ui-field"
                              type="number"
                              step="1"
                              value={category.sortOrder}
                              onChange={(event) => updateCategory(category.id, (current) => ({
                                ...current,
                                sortOrder: Number.parseInt(event.target.value || "0", 10),
                              }))}
                            />
                            {errors.sortOrder ? <p className="mt-2 text-xs text-rose-600">{errors.sortOrder}</p> : null}
                          </label>
                          <div className="flex items-end justify-start gap-3">
                            <p className="text-sm text-[var(--text-muted)]">
                              Backend fields stay tucked away here unless you need them.
                            </p>
                            {!category.isSystem ? (
                              <Button
                                type="button"
                                variant="ghost"
                                className="h-auto rounded-2xl px-0 py-0 text-rose-700"
                                onClick={() => deleteCategory(category.id)}
                              >
                                Delete category
                              </Button>
                            ) : (
                              <span className="text-xs text-[var(--text-muted)]">System categories stay protected.</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}

              <div className="flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--border-color)" }}>
                <div>
                  <Button type="button" variant="secondary" onClick={openAddCategoryModal}>
                    Add Category
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <Button type="button" variant="secondary" onClick={resetDrafts} disabled={isLoading || isSaving}>
                    Cancel
                  </Button>
                  <Button type="button" disabled={!canSave || isSaving} onClick={() => setIsConfirmModalOpen(true)}>
                    {isSaving ? "Saving..." : "Save Preferences"}
                  </Button>
                </div>
              </div>
            </div>
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
