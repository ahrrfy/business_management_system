/**
 * client/src/components/offers/OfferProductSearchInput.tsx
 *
 * Consecutive barcode gun reader (ScanBurstDetector) with persistent focus,
 * instant hardware scan lookup, secondary packaging barcode resolution,
 * duplicate detection with synthetic audio chime, and debounced manual search.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Barcode, Check, Loader2, Package, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { playAudioFeedback } from "@/lib/audioFeedback";
import { ScanBurstDetector } from "@/lib/barcodeScanTiming";
import { normalizeBarcodeScannerInput } from "@shared/barcodeScanner";
import { formatIqd } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import type { SelectedOfferItem } from "./offersTypes";

export interface OfferProductSearchInputProps {
  selectedItems: SelectedOfferItem[];
  onAddItem: (item: SelectedOfferItem) => void;
  onAddItems?: (items: SelectedOfferItem[]) => void;
  disabled?: boolean;
}

let duplicateAudioCtx: AudioContext | null = null;

function getDuplicateAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!duplicateAudioCtx || duplicateAudioCtx.state === "closed") {
    duplicateAudioCtx = new AudioCtx();
  }
  return duplicateAudioCtx;
}

function playDuplicateChime() {
  try {
    const ctx = getDuplicateAudioContext();
    if (!ctx) {
      playAudioFeedback("warning");
      return;
    }
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(330, now + 0.15);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.22);
  } catch {
    playAudioFeedback("warning");
  }
}

export function OfferProductSearchInput({
  selectedItems,
  onAddItem,
  onAddItems,
  disabled = false,
}: OfferProductSearchInputProps) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const detectorRef = useRef<ScanBurstDetector>(new ScanBurstDetector({ intraGapMs: 40, minLength: 3 }));

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());

  // Auto-focus & Persistent Focus retention engine
  const ensureFocus = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    ensureFocus();
  }, [ensureFocus]);

  // Debounce manual typing by 250ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Query for manual search dropdown
  const searchQ = trpc.salesPromotions.searchProducts.useQuery(
    { q: debouncedQuery.trim(), limit: 20 },
    {
      enabled: !disabled && debouncedQuery.trim().length >= 1,
      staleTime: 5000,
    }
  );

  const buildOfferItem = useCallback((product: any, matchedBarcode?: string): SelectedOfferItem | null => {
    const units = product.units ?? [];
    let selectedUnit = units[0];
    if (matchedBarcode) {
      const normScan = normalizeBarcodeScannerInput(matchedBarcode);
      const barcodeMatch = units.find((u: any) => {
        if (u.barcode && normalizeBarcodeScannerInput(String(u.barcode)) === normScan) return true;
        if (Array.isArray(u.altBarcodes)) {
          return u.altBarcodes.some((alt: string) => normalizeBarcodeScannerInput(String(alt)) === normScan);
        }
        return false;
      });
      selectedUnit = barcodeMatch ?? units.find((u: any) => u.isBaseUnit) ?? units[0];
    } else {
      selectedUnit = units.find((u: any) => u.isBaseUnit) ?? units[0];
    }
    if (!selectedUnit) return null;

    return {
      productId: product.productId,
      productName: product.productName,
      productCode: product.productCode ?? product.sku,
      variantId: product.variantId,
      sku: product.sku,
      variantKind: product.variantKind ?? "VARIANT",
      isConsignment: Boolean(product.isConsignment),
      costPrice: product.costPrice ?? null,
      productUnitId: selectedUnit.id,
      unitName: selectedUnit.unitName,
      conversionFactor: selectedUnit.conversionFactor,
      retailPrice: selectedUnit.retailPrice,
      barcode: selectedUnit.barcode,
      isBaseUnit: Boolean(selectedUnit.isBaseUnit),
      units: units.map((u: any) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: String(u.conversionFactor ?? "1"),
        barcode: u.barcode ?? null,
        isBaseUnit: Boolean(u.isBaseUnit),
        retailPrice: String(u.retailPrice ?? "0"),
      })),
    };
  }, []);

  // Process and add a matched product
  const handleAddProduct = useCallback(
    (product: any, matchedBarcode?: string, keepMenuOpen = false) => {
      // 1. Duplicate scan detection (keyed by variantId so distinct variants of a product never collide)
      const alreadyAdded = selectedItems.some((i) => i.variantId === product.variantId);
      if (alreadyAdded) {
        setWarning("الصنف مضاف مسبقاً");
        playDuplicateChime();
        if (!keepMenuOpen) {
          setQuery("");
          setIsOpen(false);
        }
        ensureFocus();
        return false;
      }

      const newItem = buildOfferItem(product, matchedBarcode ?? debouncedQuery.trim());
      if (!newItem) {
        setWarning("لم يتم العثور على وحدة تعبئة للمنتج");
        ensureFocus();
        return false;
      }

      onAddItem(newItem);
      setCheckedIds((prev) => {
        if (!prev.has(product.variantId)) return prev;
        const next = new Set(prev);
        next.delete(product.variantId);
        return next;
      });
      playAudioFeedback("scan");
      setWarning(null);
      if (!keepMenuOpen) {
        setQuery("");
        setIsOpen(false);
      }
      ensureFocus();
      return true;
    },
    [selectedItems, onAddItem, buildOfferItem, debouncedQuery, ensureFocus]
  );

  const handleBatchAdd = useCallback(() => {
    const rows = (searchQ.data ?? []).filter(
      (p) => checkedIds.has(p.variantId) && !selectedItems.some((i) => i.variantId === p.variantId)
    );
    if (rows.length === 0) return;
    const activeQ = debouncedQuery.trim();
    const built = rows.map((p) => buildOfferItem(p, activeQ)).filter((x): x is SelectedOfferItem => x != null);
    if (built.length === 0) return;
    if (onAddItems) {
      onAddItems(built);
    } else {
      for (const item of built) onAddItem(item);
    }
    setCheckedIds(new Set());
    setWarning(null);
    playAudioFeedback("scan");
    ensureFocus();
  }, [searchQ.data, checkedIds, selectedItems, debouncedQuery, buildOfferItem, onAddItems, onAddItem, ensureFocus]);

  // Execute fast barcode lookup
  const executeBarcodeLookup = useCallback(
    async (code: string) => {
      const cleanCode = code.trim();
      if (!cleanCode) return;

      setIsSearching(true);
      try {
        const results = await utils.salesPromotions.searchProducts.fetch({
          q: cleanCode,
          limit: 5,
        });

        if (!results || results.length === 0) {
          setWarning("لم يتم العثور على الصنف");
          playAudioFeedback("error");
          setQuery("");
          ensureFocus();
          return;
        }

        // Add the top matched product
        handleAddProduct(results[0], cleanCode);
      } catch {
        setWarning("حدث خطأ أثناء البحث عن الصنف");
        playAudioFeedback("error");
        ensureFocus();
      } finally {
        setIsSearching(false);
      }
    },
    [utils, handleAddProduct, ensureFocus]
  );

  // Handle keyboard events (detect burst scanner vs human typing)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const flushRes = detectorRef.current.flush();
      const codeToSearch = flushRes.accepted && flushRes.code ? flushRes.code : query.trim();

      if (codeToSearch) {
        void executeBarcodeLookup(codeToSearch);
      }
      return;
    }

    if (e.key === "Escape") {
      setIsOpen(false);
      detectorRef.current.reset();
      return;
    }

    // Printable key detection for burst timing
    if (e.key.length === 1) {
      detectorRef.current.feed(
        {
          code: e.nativeEvent.code,
          key: e.key,
          shiftKey: e.shiftKey,
        },
        performance.now()
      );
    }
  };

  return (
    <div className="relative space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIsOpen(true);
              if (warning) setWarning(null);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (query.trim().length >= 1) setIsOpen(true);
            }}
            disabled={disabled}
            placeholder="امسح الباركود بمسدس الليزر أو ابحث باسم المادة أو الكود..."
            className="h-10 pr-9 pl-10 text-sm font-sans"
            dir="auto"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
            <Barcode className="size-4" />
          </div>
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            {isSearching || searchQ.isFetching ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : (
              <Search className="size-4" />
            )}
          </div>
        </div>
      </div>

      {/* Non-blocking persistent warning banner */}
      {warning && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)] animate-in fade-in">
          <AlertCircle className="size-4 shrink-0" />
          <span className="font-medium">{warning}</span>
        </div>
      )}

      {/* Manual Search Dropdown Suggestions */}
      {isOpen && debouncedQuery.trim().length >= 1 && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg text-popover-foreground">
          {searchQ.isLoading ? (
            <div className="flex items-center justify-center p-4 text-xs text-muted-foreground gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>جاري البحث في قاعدة الأصناف…</span>
            </div>
          ) : searchQ.data && searchQ.data.length > 0 ? (
            <div className="space-y-1">
              <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded bg-muted/80 px-2.5 py-1.5 backdrop-blur-sm text-xs">
                <label className="flex items-center gap-2 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={
                      searchQ.data.some((p) => !selectedItems.some((i) => i.variantId === p.variantId)) &&
                      searchQ.data
                        .filter((p) => !selectedItems.some((i) => i.variantId === p.variantId))
                        .every((p) => checkedIds.has(p.variantId))
                    }
                    onChange={(e) => {
                      const next = new Set(checkedIds);
                      for (const p of searchQ.data ?? []) {
                        if (selectedItems.some((i) => i.variantId === p.variantId)) continue;
                        if (e.target.checked) next.add(p.variantId);
                        else next.delete(p.variantId);
                      }
                      setCheckedIds(next);
                    }}
                    className="rounded border-border text-primary"
                  />
                  <span>تحديد الكل من نتائج البحث</span>
                </label>
                <div className="flex items-center gap-1.5">
                  {checkedIds.size > 0 && (
                    <Button type="button" size="sm" className="h-6 px-2.5 text-[11px] gap-1" onClick={handleBatchAdd}>
                      <Plus className="size-3" /> إضافة المحدد ({checkedIds.size})
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => {
                      setIsOpen(false);
                      ensureFocus();
                    }}
                  >
                    إغلاق
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border">
                {searchQ.data.map((p) => {
                  const isSelected = selectedItems.some((i) => i.variantId === p.variantId);
                  const isChecked = checkedIds.has(p.variantId);
                  const baseUnit = p.units?.find((u: any) => u.isBaseUnit) ?? p.units?.[0];

                  return (
                    <div
                      key={p.variantId}
                      className="w-full flex items-center justify-between p-2 text-right hover:bg-muted/50 rounded transition-colors gap-2"
                    >
                      <input
                        type="checkbox"
                        disabled={isSelected}
                        checked={isSelected || isChecked}
                        onChange={() => {
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.variantId)) next.delete(p.variantId);
                            else next.add(p.variantId);
                            return next;
                          });
                        }}
                        className="rounded border-border text-primary shrink-0 cursor-pointer"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddProduct(p, undefined, true)}
                        className="flex-1 flex items-center justify-between text-right"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                            <Package className="size-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold">{p.productName}</span>
                              {p.isConsignment ? (
                                <Badge variant="outline" className="text-[10px] py-0 px-1 border-[var(--sem-warn)]/40 text-[var(--sem-warn)] bg-[var(--sem-warn-bg)]">
                                  بضاعة أمانة
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] py-0 px-1 border-[var(--sem-info)]/30 text-[var(--sem-info)] bg-[var(--sem-info-bg)]">
                                  مملوك
                                </Badge>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                              <span>رمز: {p.productCode ?? p.sku}</span>
                              <span>•</span>
                              <span>وحدة: {baseUnit?.unitName ?? "قطعة"}</span>
                              {baseUnit?.retailPrice && (
                                <>
                                  <span>•</span>
                                  <span className="font-medium text-foreground">{formatIqd(baseUnit.retailPrice)} د.ع</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div>
                          {isSelected ? (
                            <Badge variant="outline" className="border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] text-[10px]">
                              <Check className="size-3 ml-1" /> مضاف
                            </Badge>
                          ) : (
                            <span className="text-xs text-primary font-medium hover:underline">
                              + إضافة
                            </span>
                          )}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="p-4 text-center text-xs text-muted-foreground">
              لا توجد منتجات مطابقة لـ «{debouncedQuery}»
            </div>
          )}
        </div>
      )}
    </div>
  );
}
