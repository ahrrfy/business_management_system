/**
 * VariantsTable.tsx — جدول المتغيّرات: صفّ لكل صنف مخزنيّ مستقل.
 * عمود باركود لكل وحدة (تحقّق لحظي) · مخزون الفرع المختار · SKU بكشف تكرار ·
 * تبديل نشط · صفّ توسيع (باركودات كل وحدة + مخزون كل فرع + نقطة الطلب + سعر خاص).
 */
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  barcodeState,
  onlyDigits,
  toArabicDigits,
  variantStockTotal,
  type BarcodeState,
  type ClientUnit,
  type ClientVariant,
} from "@/lib/variants";
import { ColorDot, Field, ImageSlot, MarginBadge, MiniBarcode, ScanButton } from "./variantBits";

interface Branch {
  id: number;
  name: string;
}

/** ترجمة حالة الباركود إلى صنف بصريّ + تلميح. */
const BC_STYLE: Record<BarcodeState, { cls: string; title: string }> = {
  empty: { cls: "", title: "" },
  valid: { cls: "border-emerald-500/60", title: "باركود EAN-13 صالح" },
  invalid: { cls: "border-destructive ring-1 ring-destructive", title: "خانة تحقّق EAN-13 غير صحيحة" },
  dupInForm: { cls: "border-amber-500 ring-1 ring-amber-500", title: "باركود مكرّر داخل النموذج" },
  takenInDb: { cls: "border-amber-500 ring-1 ring-amber-500", title: "باركود مُستخدَم في منتج آخر" },
};

export function VariantsTable({
  variants,
  units,
  branches,
  branchId,
  costPrice,
  baseName,
  takenInDb,
  patchVariant,
  removeVariant,
  onScan,
  stockEditable = true,
  emptyHint = "لا متغيّرات بعد — استخدم المولّد أعلاه (اكتب لوناً ثم «ولّد المتغيّرات»).",
}: {
  variants: ClientVariant[];
  units: ClientUnit[];
  branches: Branch[];
  branchId: number;
  costPrice: string;
  baseName: string;
  takenInDb: Set<string>;
  patchVariant: (id: string, patch: Partial<ClientVariant>) => void;
  removeVariant: (id: string) => void;
  onScan: (variantId: string, unitId: number) => void;
  /** في التعديل: المخزون قراءة فقط (يُدار عبر شاشات الجرد/الحركات). */
  stockEditable?: boolean;
  emptyHint?: string;
}) {
  // عدّادات التكرار داخل النموذج (باركود + SKU) — مرّة لكل تغيّر بدل كل رسم.
  const { bcCount, skuCount } = useMemo(() => {
    const bc: Record<string, number> = {};
    const sku: Record<string, number> = {};
    for (const v of variants) {
      if (v.sku) sku[v.sku] = (sku[v.sku] || 0) + 1;
      for (const u of units) {
        const c = v.unitBarcodes[u.id];
        if (c) bc[c] = (bc[c] || 0) + 1;
      }
    }
    return { bcCount: bc, skuCount: sku };
  }, [variants, units]);
  const cellState = (code: string): BarcodeState =>
    barcodeState(code, { countInForm: bcCount[code] || 0, takenInDb: takenInDb.has(code) });

  const branch = branches.find((b) => b.id === branchId);

  if (variants.length === 0)
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 py-10 text-center">
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    );

  const minW = 760 + units.length * 184;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-right" style={{ minWidth: minW }}>
        <thead>
          <tr className="bg-muted/60 text-[11px] font-semibold text-muted-foreground">
            <th className="px-3 py-2 w-9">#</th>
            <th className="px-3 py-2">اللون</th>
            <th className="px-3 py-2">القياس</th>
            <th className="px-3 py-2">SKU</th>
            {units.map((u) => (
              <th key={u.id} className="px-2 py-2 whitespace-nowrap">
                باركود {u.name || "وحدة"}
                <span className="font-normal text-muted-foreground/70"> ×{u.isBase ? "1" : u.factor || "?"}</span>
              </th>
            ))}
            <th className="px-2 py-2 whitespace-nowrap">مخزون · {branch?.name ?? "الفرع"}</th>
            <th className="px-2 py-2">حد أدنى</th>
            <th className="px-3 py-2">السعر</th>
            <th className="px-2 py-2">نشط</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody className="bg-card">
          {variants.map((v, i) => (
            <VariantRow
              key={v.id}
              v={v}
              idx={i}
              units={units}
              branches={branches}
              branchId={branchId}
              costPrice={costPrice}
              baseName={baseName}
              cellState={cellState}
              skuDup={(sku) => (skuCount[sku] || 0) > 1}
              patch={(patch) => patchVariant(v.id, patch)}
              remove={() => removeVariant(v.id)}
              onScan={(unitId) => onScan(v.id, unitId)}
              stockEditable={stockEditable}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VariantRow({
  v,
  idx,
  units,
  branches,
  branchId,
  costPrice,
  baseName,
  cellState,
  skuDup,
  patch,
  remove,
  onScan,
  stockEditable,
}: {
  v: ClientVariant;
  idx: number;
  units: ClientUnit[];
  branches: Branch[];
  branchId: number;
  costPrice: string;
  baseName: string;
  cellState: (code: string) => BarcodeState;
  skuDup: (sku: string) => boolean;
  patch: (patch: Partial<ClientVariant>) => void;
  remove: () => void;
  onScan: (unitId: number) => void;
  stockEditable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fullName = [baseName, v.color, v.size].filter(Boolean).join(" ");
  const setBc = (uid: number, val: string) => patch({ unitBarcodes: { ...v.unitBarcodes, [uid]: val } });
  const setStock = (bid: number, val: string) => patch({ stockByBranch: { ...v.stockByBranch, [bid]: onlyDigits(val) } });
  const skuBad = skuDup(v.sku);

  return (
    <>
      <tr className={cn("border-t hover:bg-accent/40 transition-colors", !v.isActive && "opacity-50")}>
        <td className="px-3 py-2 text-center text-xs text-muted-foreground tabular-nums">{toArabicDigits(idx + 1)}</td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <ColorDot name={v.color} />
            <span className="text-sm font-medium whitespace-nowrap">{v.color || "—"}</span>
          </div>
        </td>
        <td className="px-3 py-2 text-sm" dir="ltr">
          {v.size || <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-3 py-2">
          <Input
            value={v.sku}
            onChange={(e) => patch({ sku: e.target.value })}
            dir="ltr"
            title={skuBad ? "SKU مكرّر داخل المنتج" : ""}
            className={cn("h-8 font-mono text-xs w-32", skuBad && "border-destructive ring-1 ring-destructive")}
          />
        </td>
        {units.map((u) => {
          const code = v.unitBarcodes[u.id] || "";
          const st = BC_STYLE[cellState(code)];
          return (
            <td key={u.id} className="px-2 py-2">
              <div className="flex items-center gap-1">
                <Input
                  value={code}
                  onChange={(e) => setBc(u.id, e.target.value)}
                  dir="ltr"
                  placeholder={`باركود ${u.name || ""}`.trim()}
                  title={st.title}
                  className={cn("h-8 font-mono text-xs w-32", st.cls)}
                />
                <ScanButton onClick={() => onScan(u.id)} />
              </div>
            </td>
          );
        })}
        <td className="px-2 py-2">
          <Input
            value={v.stockByBranch[branchId] || (stockEditable ? "" : "0")}
            onChange={(e) => stockEditable && setStock(branchId, e.target.value)}
            readOnly={!stockEditable}
            title={stockEditable ? "" : "الرصيد الحالي — يُدار عبر شاشات الجرد/الحركات"}
            dir="ltr"
            inputMode="numeric"
            className={cn("h-8 text-xs w-16 text-center", !stockEditable && "bg-muted/40 text-muted-foreground cursor-default")}
            placeholder="0"
          />
        </td>
        <td className="px-2 py-2">
          <Input
            value={v.minStock}
            onChange={(e) => patch({ minStock: onlyDigits(e.target.value) })}
            dir="ltr"
            inputMode="numeric"
            className="h-8 text-xs w-16 text-center"
          />
        </td>
        <td className="px-3 py-2">
          {v.priceOverride ? (
            <Badge variant="secondary" className="bg-primary/10 text-primary">سعر خاص</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">مشترك</span>
          )}
        </td>
        <td className="px-2 py-2 text-center">
          <button
            type="button"
            onClick={() => patch({ isActive: !v.isActive })}
            title={v.isActive ? "مفعّل — انقر للتعطيل" : "معطّل — انقر للتفعيل"}
            aria-label={v.isActive ? "تعطيل المتغيّر" : "تفعيل المتغيّر"}
            className={cn("h-3.5 w-3.5 rounded-full inline-block transition-colors", v.isActive ? "bg-emerald-500" : "bg-muted-foreground/40")}
          />
        </td>
        <td className="px-2 py-2">
          <div className="flex items-center gap-0.5 justify-end">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              title="باركودات الوحدات · مخزون الفروع · السعر الخاص"
              aria-label="تفاصيل المتغيّر"
              className={cn("h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition", open && "bg-accent text-foreground")}
            >
              <span className={cn("transition-transform text-[10px] inline-block", open && "rotate-90")}>▶</span>
            </button>
            <button
              type="button"
              onClick={remove}
              title="حذف المتغيّر"
              aria-label="حذف المتغيّر"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition"
            >
              ✕
            </button>
          </div>
        </td>
      </tr>

      {open && (
        <tr className="bg-muted/40">
          <td />
          <td colSpan={8 + units.length} className="px-3 pb-4 pt-1">
            <div className="rounded-lg border bg-card p-4 grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* ملصقات الباركود لكل وحدة + الهامش */}
              <div className="lg:col-span-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-semibold text-muted-foreground">باركود كل وحدة (معاينة) + هامش الربح</p>
                  <span className="text-[11px] text-muted-foreground">{fullName}</span>
                </div>
                <div className="flex flex-wrap gap-3">
                  {units.map((u) => {
                    const code = v.unitBarcodes[u.id] || "";
                    const factor = u.isBase ? 1 : parseFloat(u.factor) || 1;
                    const unitCost = (parseFloat(costPrice) || 0) * factor;
                    const unitSell = u.isBase && v.priceOverride && v.retail ? v.retail : u.retail;
                    return (
                      <div key={u.id} className="rounded-lg border bg-muted/20 p-3 w-[210px] flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold">{u.name || "وحدة"}</span>
                          <span className="text-[10px] text-muted-foreground">×{u.isBase ? "1" : u.factor || "?"}</span>
                          <MarginBadge cost={unitCost} sell={unitSell} className="ms-auto" />
                        </div>
                        <div className="bg-white rounded p-2 flex justify-center min-h-[52px] items-center">
                          <MiniBarcode value={code} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* مخزون كل فرع + نقطة إعادة الطلب */}
              <div className="lg:col-span-2 border-t pt-3">
                <p className="text-[11px] font-semibold text-muted-foreground mb-2">
                  {stockEditable ? "المخزون الافتتاحي لكل فرع" : "الرصيد الحالي لكل فرع (يُدار عبر الجرد/الحركات)"}
                </p>
                <div className="flex flex-wrap gap-3">
                  {branches.map((b) => (
                    <Field key={b.id} label={b.name}>
                      <Input
                        value={v.stockByBranch[b.id] || (stockEditable ? "" : "0")}
                        onChange={(e) => stockEditable && setStock(b.id, e.target.value)}
                        readOnly={!stockEditable}
                        dir="ltr"
                        inputMode="numeric"
                        className={cn("h-8 text-xs w-24 text-center", !stockEditable && "bg-muted/40 text-muted-foreground cursor-default")}
                        placeholder="0"
                      />
                    </Field>
                  ))}
                  <Field label="نقطة إعادة الطلب" hint="يقترح الشراء عند بلوغها.">
                    <Input
                      value={v.reorderPoint}
                      onChange={(e) => patch({ reorderPoint: onlyDigits(e.target.value) })}
                      dir="ltr"
                      inputMode="numeric"
                      className="h-8 text-xs w-24 text-center"
                    />
                  </Field>
                  <div className="self-end text-xs text-muted-foreground pb-2">
                    الإجمالي: <b className="text-foreground">{toArabicDigits(variantStockTotal(v.stockByBranch))}</b>
                  </div>
                </div>
              </div>

              {/* سعر خاص لهذا اللون */}
              <div className="border-t pt-3">
                <label className="flex items-center gap-2 text-xs mb-2">
                  <Switch checked={v.priceOverride} onCheckedChange={(c) => patch({ priceOverride: c })} />
                  استثناء بسعر خاص لهذا اللون
                </label>
                {v.priceOverride ? (
                  <div className="flex gap-2">
                    <Field label="تكلفة">
                      <Input value={v.costPrice} onChange={(e) => patch({ costPrice: e.target.value })} dir="ltr" className="h-8 text-xs w-24" placeholder="—" />
                    </Field>
                    <Field label="بيع (المفرد)">
                      <Input value={v.retail} onChange={(e) => patch({ retail: e.target.value })} dir="ltr" className="h-8 text-xs w-24" placeholder="—" />
                    </Field>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">يتبع التسعير المشترك في قالب الوحدات.</p>
                )}
              </div>

              {/* صورة هذا اللون (مستقلّة عن صور المنتج العامّة) */}
              <div className="border-t pt-3">
                <p className="text-[11px] font-semibold text-muted-foreground mb-2">صورة هذا اللون</p>
                <ImageSlot value={v.image} onChange={(img) => patch({ image: img })} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
