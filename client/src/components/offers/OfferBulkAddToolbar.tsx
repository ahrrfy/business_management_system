/**
 * client/src/components/offers/OfferBulkAddToolbar.tsx
 *
 * Complete 3-way Bulk Product Addition Suite for Step 3 ("نطاق المواد"):
 * 1. Visual Multi-Select Catalog Browser (filter by category + search + select all + batch add).
 * 2. Bulk Barcode / SKU Paste Modal (paste list from Excel/WhatsApp -> 1-shot SQL batch match).
 * 3. 1-Click Full Category Pull into the editable items table (with ability to exclude any item).
 */

import React, { useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  ClipboardPaste,
  FolderPlus,
  ListChecks,
  Loader2,
  Package,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { MAX_PROMOTION_TARGETS } from "@shared/promotionEngine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { formatIqd } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { buildOfferItemFromSearchProduct } from "./offersMultiRuleHelpers";
import {
  capOfferItemsToTargetLimit,
  pullCategorySearchPages,
  resolveBulkPasteOutcome,
  resolveCategoryPullOutcome,
} from "./offersDraftGuards";
import type { SelectedOfferItem } from "./offersTypes";

export interface OfferBulkAddToolbarProps {
  categories: ReadonlyArray<{ id: number; name: string }>;
  selectedItems: SelectedOfferItem[];
  onAddItems: (items: SelectedOfferItem[]) => void;
  onClearAll?: () => void;
}

export function OfferBulkAddToolbar({
  categories,
  selectedItems,
  onAddItems,
  onClearAll,
}: OfferBulkAddToolbarProps) {
  const utils = trpc.useUtils();
  const existingVariantIds = useMemo(
    () => new Set(selectedItems.map((i) => i.variantId)),
    [selectedItems]
  );

  // 1) Visual Catalog Browser Dialog State
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserCatId, setBrowserCatId] = useState("");
  const [browserSearch, setBrowserSearch] = useState("");
  const [browserFilter, setBrowserFilter] = useState<"ALL" | "UNADDED" | "OWNED" | "CONSIGNMENT">("ALL");
  const [pickedMap, setPickedMap] = useState<Map<number, any>>(new Map());

  const catalogQ = trpc.salesPromotions.searchProducts.useQuery(
    {
      q: browserSearch.trim() || undefined,
      categoryId: browserCatId ? Number(browserCatId) : null,
      limit: 300,
    },
    { enabled: browserOpen, staleTime: 5000 }
  );

  const filteredBrowserRows = useMemo(() => {
    const raw = catalogQ.data ?? [];
    return raw.filter((p) => {
      if (browserFilter === "UNADDED" && existingVariantIds.has(p.variantId)) return false;
      if (browserFilter === "OWNED" && p.isConsignment) return false;
      if (browserFilter === "CONSIGNMENT" && !p.isConsignment) return false;
      return true;
    });
  }, [catalogQ.data, browserFilter, existingVariantIds]);

  const selectableBrowserRows = useMemo(
    () => filteredBrowserRows.filter((p) => !existingVariantIds.has(p.variantId)),
    [filteredBrowserRows, existingVariantIds]
  );

  // 2) Bulk Barcode / SKU Paste Dialog State
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteRaw, setPasteRaw] = useState("");
  const [isPasting, setIsPasting] = useState(false);
  const [pasteFeedback, setPasteFeedback] = useState<string | null>(null);

  // 3) 1-Click Category Pull State
  const [quickCatId, setQuickCatId] = useState("");
  const [isPullingCategory, setIsPullingCategory] = useState(false);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const [inlineNoticeTone, setInlineNoticeTone] = useState<"pos" | "warn">("pos");

  const handleConfirmBrowserSelection = () => {
    const built = Array.from(pickedMap.values())
      .filter((p) => !existingVariantIds.has(p.variantId))
      .map((p) => buildOfferItemFromSearchProduct(p))
      .filter((x): x is SelectedOfferItem => x != null);
    const { acceptedItems, droppedCount, limitReachedNotice } = capOfferItemsToTargetLimit(
      built,
      selectedItems.length,
    );
    if (acceptedItems.length > 0) {
      onAddItems(acceptedItems);
    }
    if (droppedCount > 0 && limitReachedNotice) {
      setInlineNoticeTone("warn");
      setInlineNotice(limitReachedNotice);
    } else if (acceptedItems.length > 0) {
      setInlineNoticeTone("pos");
      setInlineNotice(`تمت إضافة ${acceptedItems.length} مادة من مستعرض الأصناف.`);
    }
    setPickedMap(new Map());
    setBrowserOpen(false);
  };

  const handleExecuteBulkPaste = async () => {
    const tokens = Array.from(
      new Set(
        pasteRaw
          .split(/[\r\n,;\t\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
      )
    );
    if (tokens.length === 0) {
      setPasteFeedback("ألصق باركوداً أو رمز مادة واحداً على الأقل.");
      return;
    }
    setIsPasting(true);
    setPasteFeedback(null);
    try {
      const cappedTokens = tokens.slice(0, MAX_PROMOTION_TARGETS);
      const matchedProducts: any[] = [];
      for (let offset = 0; offset < cappedTokens.length; offset += 500) {
        const chunk = cappedTokens.slice(offset, offset + 500);
        const batch = await utils.salesPromotions.searchProducts.fetch({
          codes: chunk,
          limit: 500,
        });
        matchedProducts.push(...batch);
      }
      const outcome = resolveBulkPasteOutcome({
        tokens,
        matchedProducts,
        existingVariantIds,
        currentSelectedCount: selectedItems.length,
      });
      if (outcome.itemsToAdd.length > 0) {
        onAddItems(outcome.itemsToAdd);
      }
      setInlineNoticeTone(outcome.tone);
      setInlineNotice(outcome.summary);
      if (outcome.unmatchedCodes.length === 0 && !outcome.capped) {
        setPasteRaw("");
        setPasteOpen(false);
      } else {
        setPasteFeedback(outcome.summary);
      }
    } catch {
      setPasteFeedback("تعذر مطابقة الأكواد الملصقة حالياً، حاول مرة أخرى.");
    } finally {
      setIsPasting(false);
    }
  };

  const handlePullCategoryItems = async () => {
    if (!quickCatId) return;
    setIsPullingCategory(true);
    setInlineNotice(null);
    try {
      const catIdNum = Number(quickCatId);
      const { rows, truncated } = await pullCategorySearchPages({
        categoryId: catIdNum,
        fetchPage: ({ categoryId, limit, offset }) =>
          utils.salesPromotions.searchProducts.fetch({ categoryId, limit, offset }),
      });
      const catName = categories.find((c) => String(c.id) === quickCatId)?.name ?? "الفئة";
      const outcome = resolveCategoryPullOutcome({
        fetchedRows: rows,
        truncated,
        existingVariantIds,
        catName,
        currentSelectedCount: selectedItems.length,
      });
      if (outcome.itemsToAdd.length > 0) {
        onAddItems(outcome.itemsToAdd);
      }
      setInlineNoticeTone(outcome.tone);
      setInlineNotice(outcome.notice);
    } finally {
      setIsPullingCategory(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setBrowserOpen(true)}
            className="h-8 text-xs gap-1.5 font-semibold"
          >
            <ListChecks className="size-3.5 text-primary" />
            مستعرض الإضافة المتعددة
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setPasteFeedback(null);
              setPasteOpen(true);
            }}
            className="h-8 text-xs gap-1.5"
          >
            <ClipboardPaste className="size-3.5 text-primary" />
            لصق قائمة باركودات / أكواد
          </Button>
        </div>

        {/* Quick 1-Click Category Pull */}
        <div className="flex flex-wrap items-center gap-1.5">
          <AppSelect
            value={quickCatId}
            onValueChange={setQuickCatId}
            className="h-8 w-48 text-xs"
            size="sm"
          >
            <option value="">سحب مواد فئة كاملة…</option>
            {categories.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </AppSelect>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!quickCatId || isPullingCategory}
            onClick={() => void handlePullCategoryItems()}
            className="h-8 text-xs gap-1"
          >
            {isPullingCategory ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FolderPlus className="size-3.5" />
            )}
            سحب للجدول
          </Button>

          {onClearAll && selectedItems.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClearAll}
              className="h-8 text-xs gap-1 text-muted-foreground hover:text-[var(--sem-neg)]"
            >
              <Trash2 className="size-3.5" /> تفريغ ({selectedItems.length})
            </Button>
          )}
        </div>
      </div>

      {inlineNotice && (
        <div
          className={`flex items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-xs ${
            inlineNoticeTone === "warn"
              ? "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
              : "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
          }`}
        >
          <span className="flex items-center gap-1.5">
            {inlineNoticeTone === "warn" ? (
              <TriangleAlert className="size-3.5 shrink-0" />
            ) : (
              <CheckCircle2 className="size-3.5 shrink-0" />
            )}
            {inlineNotice}
          </span>
          <button
            type="button"
            onClick={() => setInlineNotice(null)}
            className="text-[11px] underline opacity-80 hover:opacity-100"
          >
            إخفاء
          </button>
        </div>
      )}

      {/* Dialog 1: Visual Catalog Browser & Multi-Select */}
      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">اختيار مواد متعددة دفعة واحدة</DialogTitle>
            <DialogDescription className="text-xs">
              ابحث بالاسم أو اختر القسم، وحدد المواد المطلوبة سوية لإضافتها للعرض بنقرة واحدة.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <UnifiedSearchInput
              value={browserSearch}
              onChange={setBrowserSearch}
              placeholder="ابحث باسم المادة أو الكود أو الباركود…"
              className="sm:col-span-2"
              inputClassName="h-9 text-xs"
              barcode={false}
            />
            <AppSelect
              value={browserCatId}
              onValueChange={setBrowserCatId}
              className="h-9 text-xs"
            >
              <option value="">كل الأقسام</option>
              {categories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </AppSelect>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/50 px-2.5 py-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              {(["ALL", "UNADDED", "OWNED", "CONSIGNMENT"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setBrowserFilter(f)}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    browserFilter === f
                      ? "bg-primary text-primary-foreground font-semibold"
                      : "bg-background text-muted-foreground hover:text-foreground border border-border"
                  }`}
                >
                  {f === "ALL" && "الكل"}
                  {f === "UNADDED" && "غير المضافة فقط"}
                  {f === "OWNED" && "بضاعة المكتبة"}
                  {f === "CONSIGNMENT" && "بضاعة أمانة"}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                disabled={selectableBrowserRows.length === 0}
                onClick={() => {
                  setPickedMap((prev) => {
                    const next = new Map(prev);
                    const allChecked = selectableBrowserRows.every((p) => next.has(p.variantId));
                    for (const p of selectableBrowserRows) {
                      if (allChecked) next.delete(p.variantId);
                      else next.set(p.variantId, p);
                    }
                    return next;
                  });
                }}
              >
                {selectableBrowserRows.length > 0 &&
                selectableBrowserRows.every((p) => pickedMap.has(p.variantId))
                  ? "إلغاء تحديد المعروض"
                  : `تحديد كل المعروض (${selectableBrowserRows.length})`}
              </Button>
            </div>
          </div>

          <div className="flex-1 min-h-[260px] max-h-[46vh] overflow-y-auto rounded-md border border-border divide-y divide-border">
            {catalogQ.isLoading ? (
              <div className="flex items-center justify-center p-8 text-xs text-muted-foreground gap-2">
                <Loader2 className="size-4 animate-spin text-primary" />
                <span>{ACTION_LABELS.loading}</span>
              </div>
            ) : filteredBrowserRows.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground">
                لا توجد أصناف مطابقة للفلاتر الحالية.
              </div>
            ) : (
              filteredBrowserRows.map((p: any) => {
                const alreadyInOffer = existingVariantIds.has(p.variantId);
                const checked = alreadyInOffer || pickedMap.has(p.variantId);
                const baseU = p.units?.find((u: any) => u.isBaseUnit) ?? p.units?.[0];
                return (
                  <label
                    key={p.variantId}
                    className={`flex items-center justify-between gap-3 px-3 py-2 text-xs transition-colors ${
                      alreadyInOffer
                        ? "bg-muted/30 opacity-70 cursor-default"
                        : "hover:bg-muted/40 cursor-pointer"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        disabled={alreadyInOffer}
                        checked={checked}
                        onChange={() => {
                          setPickedMap((prev) => {
                            const next = new Map(prev);
                            if (next.has(p.variantId)) next.delete(p.variantId);
                            else next.set(p.variantId, p);
                            return next;
                          });
                        }}
                        className="rounded border-border text-primary shrink-0"
                      />
                      <Package className="size-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-foreground truncate">{p.productName}</span>
                          {p.isConsignment && (
                            <Badge
                              variant="outline"
                              className="text-[10px] py-0 px-1 border-[var(--sem-warn)]/40 text-[var(--sem-warn)] bg-[var(--sem-warn-bg)]"
                            >
                              أمانة
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                          <span>كود المادة: {p.sku}</span>
                          {baseU?.barcode && <span>• باركود: {baseU.barcode}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {baseU?.retailPrice && (
                        <span className="font-semibold tabular-nums">
                          {formatIqd(baseU.retailPrice)} د.ع
                        </span>
                      )}
                      {alreadyInOffer && (
                        <Badge
                          variant="outline"
                          className="border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] text-[10px]"
                        >
                          <Check className="size-3 ml-0.5" /> مضاف
                        </Badge>
                      )}
                    </div>
                  </label>
                );
              })
            )}
          </div>

          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            <span className="text-xs text-muted-foreground">
              المواد المحددة للإضافة: <strong>{pickedMap.size}</strong> مادة
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setBrowserOpen(false)}>
                إلغاء
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pickedMap.size === 0}
                onClick={handleConfirmBrowserSelection}
              >
                إضافة المحدد للعرض ({pickedMap.size})
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog 2: Bulk Paste Barcodes / SKUs */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base">لصق قائمة باركودات أو أكواد مواد دفعة واحدة</DialogTitle>
            <DialogDescription className="text-xs">
              ألصق قائمة باركودات أو أكواد المواد مباشرةً من شيت Excel أو رسالة واتساب (كل كود بسطر أو مفصول بفاصلة أو مسافة).
            </DialogDescription>
          </DialogHeader>

          <Textarea
            value={pasteRaw}
            onChange={(e) => setPasteRaw(e.target.value)}
            rows={6}
            dir="ltr"
            placeholder={"629100202601\n629100202602\nMLZ-2026-CHEM"}
            className="font-mono text-xs"
          />

          {pasteFeedback && (
            <div className="rounded border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)]">
              {pasteFeedback}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPasteOpen(false)}>
              إغلاق
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPasting || !pasteRaw.trim()}
              onClick={() => void handleExecuteBulkPaste()}
              className="gap-1.5"
            >
              {isPasting && <Loader2 className="size-3.5 animate-spin" />}
              مطابقة وإضافة الكل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
