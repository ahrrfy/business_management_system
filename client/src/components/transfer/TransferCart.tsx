/**
 * TransferCart — سلة سند التحويل بتجربة جدول الفاتورة المتقدمة (طلب المالك ١٤/٧).
 *
 * يعيد استخدام ProductSearchBar (بحث حيّ + أسهم/Enter + حلّ باركود الماسح) وBulkPicker
 * («إضافة متعددة» بتحديد جماعي) كما هما من طقم الفاتورة، مع جدول خاص بالتحويل: لا أسعار
 * ولا خصومات (لا معنى لها مخزنياً) — وحدة/متاح/كمية ±/معادل الأساس + شارات نافذ/لا يكفي
 * بطلبٍ مجمَّع لكل متغيّر عبر كل وحداته (قطعة+كرتون لنفس الصنف يتقاسمان نفس الرصيد).
 *
 * الأسطر بوحدة البيع المختارة (درزن/كرتون…) وتُجمَّع بالأساس لكل متغيّر عند الإرسال
 * (الخادم يرفض تكرار المتغيّر في السند الواحد — التجميع في Transfers.tsx).
 */
import type { Dispatch, SetStateAction } from "react";
import { Package, PackagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fmtInt } from "@/lib/money";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import { BulkPicker } from "@/components/invoice/BulkPicker";
import type { InvoiceLine } from "@/components/invoice/types";

/** سطر السلة — نستعمل شكل InvoiceLine نفسه (حقول السعر تُهمَل) لتوافق الشريطين المشتركين. */
export type TransferCartLine = Pick<
  InvoiceLine,
  "productId" | "variantId" | "productUnitId" | "name" | "sku" | "barcode" | "unit" | "qty" | "conversionFactor" | "stockBase"
>;

export interface TransferLineState {
  isOut: boolean;
  isShort: boolean;
  availInUnit: number;
  baseQty: number;
  /** معامل تحويل غير صحيح × الكمية ⇒ كمية أساس كسرية (مرفوضة §٥). */
  fractional: boolean;
}

/** حالة المخزون لكل سطر بطلبٍ مجمَّع per-variant (نفس منطق ProductTable). */
export function computeLineStates(lines: TransferCartLine[]): TransferLineState[] {
  const demandByVariant = new Map<number, number>();
  for (const l of lines) {
    const f = Number(l.conversionFactor) || 1;
    demandByVariant.set(l.variantId, (demandByVariant.get(l.variantId) ?? 0) + (Number(l.qty) || 0) * f);
  }
  return lines.map((l) => {
    const f = Number(l.conversionFactor) || 1;
    const baseQty = (Number(l.qty) || 0) * f;
    const availBase = Number(l.stockBase) || 0;
    const reqBase = demandByVariant.get(l.variantId) ?? baseQty;
    const isOut = availBase <= 0;
    return {
      isOut,
      isShort: !isOut && reqBase > availBase,
      availInUnit: Math.floor(availBase / f),
      baseQty,
      fractional: !Number.isInteger(baseQty) || baseQty <= 0,
    };
  });
}

function QuantityControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-1">
      <Button type="button" variant="outline" size="icon" className="h-8 w-8 text-base" onClick={() => onChange(Math.max(1, value - 1))} aria-label="إنقاص">
        −
      </Button>
      <Input
        dir="ltr"
        value={String(value)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n) && n >= 1) onChange(n);
        }}
        className="h-8 w-14 text-center text-sm font-extrabold"
        aria-label="الكمية"
      />
      <Button type="button" variant="outline" size="icon" className="h-8 w-8 text-base" onClick={() => onChange(value + 1)} aria-label="زيادة">
        +
      </Button>
    </div>
  );
}

export interface TransferCartProps {
  lines: TransferCartLine[];
  setLines: Dispatch<SetStateAction<TransferCartLine[]>>;
  /** فرع المصدر — البحث/الأرصدة عليه. */
  branchId: number;
  bulkOpen: boolean;
  setBulkOpen: (open: boolean) => void;
  onNotify?: (msg: string, kind: "error" | "info") => void;
}

export function TransferCart({ lines, setLines, branchId, bulkOpen, setBulkOpen, onNotify }: TransferCartProps) {
  const states = computeLineStates(lines);
  const totalBase = states.reduce((s, st) => s + (Number.isFinite(st.baseQty) ? st.baseQty : 0), 0);

  /** إضافة سطر بدمج نفس الوحدة (نفس دلالة ADD_ITEM في reducer الفاتورة: نفس productUnitId ⇒ +1). */
  const addLine = (line: InvoiceLine) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.productUnitId === line.productUnitId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        return next;
      }
      const { productId, variantId, productUnitId, name, sku, barcode, unit, qty, conversionFactor, stockBase } = line;
      return [...prev, { productId, variantId, productUnitId, name, sku, barcode, unit, qty, conversionFactor, stockBase }];
    });
  };
  const addMany = (items: InvoiceLine[]) => items.forEach(addLine);
  const setQty = (idx: number, qty: number) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty } : l)));
  const removeAt = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const th = "sticky top-0 z-[2] whitespace-nowrap border-b-2 bg-muted px-2 py-2.5 text-center text-xs font-bold text-muted-foreground";
  const td = "px-2 py-2.5 text-center text-sm align-middle";

  return (
    <section className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="shrink-0 border-b px-3.5 py-3">
        <ProductSearchBar invoiceType="SALE" branchId={branchId} tier="RETAIL" onAddProduct={addLine} onNotify={onNotify} />
      </div>

      <div className="flex shrink-0 items-center justify-between border-b bg-muted px-3.5 py-1.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-extrabold">
            <PackagePlus aria-hidden className="size-4" /> أصناف السند
          </span>
          {lines.length > 0 && (
            <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-bold text-primary-foreground">
              {fmtInt(lines.length)} سطر · {fmtInt(totalBase)} وحدة أساس
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
            onClick={() => setBulkOpen(true)}
          >
            <Package aria-hidden className="size-4" /> إضافة متعددة
          </Button>
          {lines.length > 0 && (
            <Button type="button" size="sm" variant="outline" className="h-7 border-rose-400/40 text-rose-600 hover:bg-rose-50" onClick={() => setLines([])}>
              تفريغ الكل
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={cn(th, "w-9")}>#</th>
              <th className={cn(th, "w-24")}>الباركود</th>
              <th className={cn(th, "min-w-[180px] text-right")}>المنتج</th>
              <th className={cn(th, "w-16")}>الوحدة</th>
              <th className={cn(th, "w-20")}>المتاح (مصدر)</th>
              <th className={cn(th, "w-36")}>الكمية</th>
              <th className={cn(th, "w-24")}>يعادل بالأساس</th>
              <th className={cn(th, "w-10")} aria-label="حذف" />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-muted-foreground">
                  <div className="opacity-50 flex justify-center"><Package aria-hidden size={40} /></div>
                  <div className="mt-2 text-sm font-semibold">لا أصناف في السند</div>
                  <div className="mx-auto mt-1 max-w-xs text-xs">ابحث بالاسم أو SKU أو امسح الباركود، أو استعمل «إضافة متعددة»</div>
                </td>
              </tr>
            )}
            {lines.map((l, idx) => {
              const st = states[idx];
              return (
                <tr
                  key={`${l.productUnitId}-${idx}`}
                  className={cn(
                    "border-b transition hover:bg-muted/50",
                    st.isOut && "border-s-[3px] border-s-destructive bg-destructive/5",
                    !st.isOut && st.isShort && "border-s-[3px] border-s-amber-500 bg-amber-50 dark:bg-amber-950/20",
                  )}
                >
                  <td className={cn(td, "font-semibold text-muted-foreground")}>{idx + 1}</td>
                  <td className={cn(td, "font-mono text-[11px] text-muted-foreground")} dir="ltr">{l.barcode?.slice(-6) ?? "—"}</td>
                  <td className={cn(td, "text-right")}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-foreground">{l.name}</span>
                      {st.isOut && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[10px] font-extrabold text-destructive-foreground">نافذ — لا مخزون</span>
                      )}
                      {!st.isOut && st.isShort && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-extrabold text-amber-50">
                          {st.availInUnit === 0 ? "لا يكفي لوحدة" : `المتاح ${fmtInt(st.availInUnit)} فقط`}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{l.sku}</div>
                  </td>
                  <td className={cn(td, "text-xs text-muted-foreground")}>{l.unit}</td>
                  <td className={td}>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-extrabold tabular-nums",
                        st.isOut ? "bg-destructive text-destructive-foreground" : st.isShort ? "bg-amber-100 text-amber-700" : "text-muted-foreground",
                      )}
                      dir="ltr"
                    >
                      {fmtInt(st.availInUnit)}
                    </span>
                  </td>
                  <td className={td}>
                    <QuantityControl value={l.qty} onChange={(v) => setQty(idx, v)} />
                  </td>
                  <td className={cn(td, "text-sm font-extrabold tabular-nums")} dir="ltr">
                    {fmtInt(st.baseQty)}
                    {Number(l.conversionFactor) > 1 && (
                      <div className="text-[10px] font-normal text-muted-foreground" dir="rtl">×{fmtInt(Number(l.conversionFactor))}</div>
                    )}
                  </td>
                  <td className={td}>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 border-rose-300/40 text-rose-600 hover:bg-rose-50"
                      onClick={() => removeAt(idx)}
                      aria-label="حذف"
                    >
                      <X aria-hidden className="size-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <BulkPicker open={bulkOpen} onClose={() => setBulkOpen(false)} onAddItems={addMany} invoiceType="SALE" branchId={branchId} tier="RETAIL" />
    </section>
  );
}
