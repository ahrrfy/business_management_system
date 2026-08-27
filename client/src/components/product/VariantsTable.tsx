/**
 * VariantsTable.tsx — جدول المتغيّرات: صفّ لكل منتج مخزنيّ مستقل.
 * عمود باركود لكل وحدة (تحقّق لحظي) · مخزون الفرع المختار · SKU بكشف تكرار ·
 * تبديل نشط · صفّ توسيع (باركودات كل وحدة + مخزون كل فرع + نقطة الطلب + سعر خاص).
 */
import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { NumberInput } from "@/components/form/NumberInput";
import { Switch } from "@/components/ui/switch";
import {
  barcodeInfo,
  onlyDigits,
  toArabicDigits,
  variantStockTotal,
  type BarcodeInfo,
  type ClientUnit,
  type ClientVariant,
} from "@/lib/variants";
import { ColorPickerDot, Field, MarginBadge, MiniBarcode, ScanButton } from "./variantBits";
import { UnitBarcodeAliases } from "./UnitBarcodeAliases";
import { UnitPriceHistory } from "./UnitPriceHistory";
import { ChevronLeft, X } from "lucide-react";
import { variantDisplayName } from "@shared/variantDisplay";

interface Branch {
  id: number;
  name: string;
}

/**
 * ترجمة `barcodeInfo` إلى صنف بصريّ + تلميح صادق.
 * الشدّة (severity) تحدّد اللون؛ الرسالة تُذكر نوع الترميز الفعليّ (Code128/UPC-A/EAN-8/…)
 * بدل ادّعاء «EAN-13 غير صحيح» على باركود مصنّعي شرعيّ من عائلة أخرى.
 */
function cellStyle(info: BarcodeInfo): { cls: string; title: string } {
  const cls =
    info.severity === "blocker" ? "border-destructive ring-1 ring-destructive"
    : info.severity === "warn"    ? "border-[var(--sem-warn)] ring-1 ring-amber-500"
    : info.severity === "ok"      ? "border-[var(--sem-pos)]/60"
    : info.severity === "info"    ? "border-blue-500/40"
    : "";
  // التلميح: نوع الترميز + الرسالة (يظهر عند التحويم على خلية صغيرة لا تسع بادج).
  const title = info.symbology.label
    ? `[${info.symbology.label}] ${info.message}`.trim()
    : info.message;
  return { cls, title };
}

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
  onColorCommit,
  stockEditable = true,
  localAliases = false,
  priceHistory = false,
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
  /**
   * يُستدعى عند **إتمام** إعادة تسمية لون متغيّر بالصفّ (blur) بقيمتيه القديمة والجديدة — ليزامن النموذج
   * الأب رقائقَ مصفوفة الألوان فيبقى «ولّد المتغيّرات» متّسقاً. اختياريّ (الشاشات بلا مصفوفة تتركه).
   */
  onColorCommit?: (oldColor: string, newColor: string) => void;
  /** في التعديل: المخزون قراءة فقط (يُدار عبر شاشات الجرد/الحركات). */
  stockEditable?: boolean;
  /**
   * عند true: يعرض زرّ «بدائل» (باركودات بديلة) لكل وحدة في صفّ التوسيع، بوضع محلّي يكتب في
   * `variant.unitBarcodeAliases` — تُدرَج ذرّياً مع المنتج عند الحفظ (شاشة الإضافة فقط؛ التعديل
   * يستعمل مساراً خادميّاً منفصلاً فلا يُفعَّل هنا كي لا تُفقَد البدائل بمسار تحديثٍ لا يحملها).
   */
  localAliases?: boolean;
  /** في شاشة التعديل فقط: يعرض سجل السعر للوحدات المحفوظة داخل تفاصيل المتغيّر. */
  priceHistory?: boolean;
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
  const cellInfo = (code: string): BarcodeInfo =>
    barcodeInfo(code, { countInForm: bcCount[code] || 0, takenInDb: takenInDb.has(code) });

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
              cellInfo={cellInfo}
              skuDup={(sku) => (skuCount[sku] || 0) > 1}
              patch={(patch) => patchVariant(v.id, patch)}
              remove={() => removeVariant(v.id)}
              onScan={(unitId) => onScan(v.id, unitId)}
              onColorCommit={onColorCommit}
              stockEditable={stockEditable}
              localAliases={localAliases}
              priceHistory={priceHistory}
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
  cellInfo,
  skuDup,
  patch,
  remove,
  onScan,
  onColorCommit,
  stockEditable,
  localAliases,
  priceHistory,
}: {
  v: ClientVariant;
  idx: number;
  units: ClientUnit[];
  branches: Branch[];
  branchId: number;
  costPrice: string;
  baseName: string;
  cellInfo: (code: string) => BarcodeInfo;
  skuDup: (sku: string) => boolean;
  patch: (patch: Partial<ClientVariant>) => void;
  remove: () => void;
  onScan: (unitId: number) => void;
  onColorCommit?: (oldColor: string, newColor: string) => void;
  stockEditable: boolean;
  localAliases: boolean;
  priceHistory: boolean;
}) {
  const [open, setOpen] = useState(false);
  // لون الصفّ عند بدء التحرير (focus) — لمقارنته عند الإتمام (blur) فنزامن رقائق المصفوفة عند إعادة التسمية.
  const colorAtFocus = useRef("");
  const fullName = variantDisplayName({
    productName: baseName,
    variantName: v.variantName,
    color: v.color,
    size: v.size,
    variantKind: v.variantKind,
  });
  const setBc = (uid: number, val: string) => patch({ unitBarcodes: { ...v.unitBarcodes, [uid]: val } });
  const setStock = (bid: number, val: string) => patch({ stockByBranch: { ...v.stockByBranch, [bid]: val } });
  const skuBad = skuDup(v.sku);

  return (
    <>
      <tr className={cn("border-t hover:bg-accent/40 transition-colors", !v.isActive && "opacity-50")}>
        <td className="px-3 py-2 text-center text-xs text-muted-foreground tabular-nums">{toArabicDigits(idx + 1)}</td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <ColorPickerDot name={v.color} hex={v.colorHex} onChange={(colorHex) => patch({ colorHex })} />
            <Input
              value={v.color}
              onChange={(e) => patch({ color: e.target.value })}
              onFocus={() => { colorAtFocus.current = v.color; }}
              onBlur={() => { if (onColorCommit && colorAtFocus.current !== v.color) onColorCommit(colorAtFocus.current, v.color); }}
              placeholder="اللون"
              dir="auto"
              aria-label={`اسم لون المتغيّر ${idx + 1}`}
              className="h-8 text-sm w-28 font-medium"
            />
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
          const info = cellInfo(code);
          const st = cellStyle(info);
          return (
            <td key={u.id} className="px-2 py-2">
              <div className="flex items-center gap-1">
                <Input
                  value={code}
                  onChange={(e) => setBc(u.id, e.target.value)}
                  dir="ltr"
                  placeholder={`باركود ${u.name || ""}`.trim()}
                  title={st.title}
                  aria-invalid={info.severity === "blocker"}
                  className={cn("h-8 font-mono text-xs w-32", st.cls)}
                />
                {code && info.symbology.label && (
                  <Badge
                    variant={info.severity === "blocker" ? "destructive" : info.severity === "warn" ? "outline" : info.severity === "ok" ? "default" : "secondary"}
                    className="text-[9px] whitespace-nowrap px-1 py-0 leading-tight"
                    title={`نوع الترميز المكتشف: ${info.symbology.label}`}
                  >
                    {info.symbology.label}
                  </Badge>
                )}
                <ScanButton onClick={() => onScan(u.id)} />
              </div>
            </td>
          );
        })}
        <td className="px-2 py-2">
          {stockEditable ? (
            <NumberInput
              value={v.stockByBranch[branchId] || ""}
              onChange={(val) => setStock(branchId, val)}
              className="h-8 text-xs w-16 text-center"
              placeholder="0"
              ariaLabel="المخزون الافتتاحي للفرع"
            />
          ) : (
            <Input
              value={v.stockByBranch[branchId] || "0"}
              readOnly
              title="الرصيد الحالي — يُدار عبر شاشات الجرد/الحركات"
              dir="ltr"
              inputMode="numeric"
              className="h-8 text-xs w-16 text-center bg-muted/40 text-muted-foreground cursor-default"
              placeholder="0"
            />
          )}
        </td>
        <td className="px-2 py-2">
          <NumberInput
            value={v.minStock}
            onChange={(val) => patch({ minStock: val })}
            className="h-8 text-xs w-16 text-center"
            ariaLabel="الحد الأدنى للمخزون"
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
            className={cn("h-3.5 w-3.5 rounded-full inline-block transition-colors", v.isActive ? "bg-[var(--sem-pos-bg)]0" : "bg-muted-foreground/40")}
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
              <ChevronLeft aria-hidden className={cn("size-3.5 transition-transform", open && "-rotate-90")} />
            </button>
            <button
              type="button"
              onClick={remove}
              title="حذف المتغيّر"
              aria-label="حذف المتغيّر"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        </td>
      </tr>

      {open && (
        <tr className="bg-muted/40">
          <td />
          <td colSpan={8 + units.length} className="px-3 pb-4 pt-1">
            <div className="rounded-lg border bg-card p-4 grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* نوع المتغيّر (م٣): تنويعة لون/قياس أو بديلٌ مستقلّ (منتجٌ حقيقيٌّ تحت الاسم الجامع). */}
              <div className="lg:col-span-3 border-b pb-3">
                <p className="text-[11px] font-semibold text-muted-foreground mb-2">نوع المتغيّر</p>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex overflow-hidden rounded-md border text-xs">
                    <button
                      type="button"
                      onClick={() => patch({ variantKind: "VARIANT" })}
                      className={cn(
                        "px-3 py-1.5 transition-colors",
                        (v.variantKind ?? "VARIANT") === "VARIANT"
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground",
                      )}
                    >
                      تنويعة (لون/قياس)
                    </button>
                    <button
                      type="button"
                      onClick={() => patch({ variantKind: "ALTERNATIVE" })}
                      className={cn(
                        "border-s px-3 py-1.5 transition-colors",
                        v.variantKind === "ALTERNATIVE"
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground",
                      )}
                    >
                      بديل مستقلّ
                    </button>
                  </div>
                  {v.variantKind === "ALTERNATIVE" && (
                    <Input
                      value={v.variantName ?? ""}
                      onChange={(e) => patch({ variantName: e.target.value })}
                      placeholder="اسم البديل (الماركة/المنشأ)"
                      className="h-8 w-56 text-xs"
                      aria-label="اسم البديل"
                    />
                  )}
                </div>
                {v.variantKind === "ALTERNATIVE" && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    البديل منتجٌ حقيقيٌّ مستقلّ: يلزمه اسمٌ مميّز وباركود، ويُعدّ ويُعرض بمخزونه وتكلفته وباركوده منفصلاً.
                  </p>
                )}
              </div>
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
                    // التكلفة الأساس = تكلفة اللون الخاصّة عند تفعيل السعر الخاص (مطابقةً لـbuildPayload/جانب البيع
                    // في السطر التالي)، وإلّا المشتركة. كان يستعمل المشتركة دائماً ⇒ هامشٌ معروضٌ خاطئ عند سعرٍ
                    // خاصّ بتكلفةٍ مختلفة (عرضٌ فقط — لا يُخزَّن ولا يدخل الدفتر).
                    const baseCost = v.priceOverride && v.costPrice.trim() ? parseFloat(v.costPrice) || 0 : parseFloat(costPrice) || 0;
                    const unitCost = baseCost * factor;
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
                        {localAliases && (
                          <UnitBarcodeAliases
                            unitName={u.name || "وحدة"}
                            variantLabel={fullName}
                            localAliases={v.unitBarcodeAliases?.[u.id] ?? []}
                            onLocalChange={(next) =>
                              patch({ unitBarcodeAliases: { ...(v.unitBarcodeAliases ?? {}), [u.id]: next } })
                            }
                          />
                        )}
                        {priceHistory && (
                          <UnitPriceHistory
                            variantId={v.id.startsWith("db:") ? Number(v.id.slice(3)) : null}
                            unitName={u.name || "وحدة"}
                            variantLabel={fullName || v.sku}
                          />
                        )}
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
                      {stockEditable ? (
                        <NumberInput
                          value={v.stockByBranch[b.id] || ""}
                          onChange={(val) => setStock(b.id, val)}
                          className="h-8 text-xs w-24 text-center"
                          placeholder="0"
                          ariaLabel={`مخزون افتتاحي — ${b.name}`}
                        />
                      ) : (
                        <Input
                          value={v.stockByBranch[b.id] || "0"}
                          readOnly
                          dir="ltr"
                          inputMode="numeric"
                          className="h-8 text-xs w-24 text-center bg-muted/40 text-muted-foreground cursor-default"
                          placeholder="0"
                        />
                      )}
                    </Field>
                  ))}
                  <Field label="نقطة إعادة الطلب" hint="يقترح الشراء عند بلوغها.">
                    <NumberInput
                      value={v.reorderPoint}
                      onChange={(val) => patch({ reorderPoint: val })}
                      className="h-8 text-xs w-24 text-center"
                      ariaLabel="نقطة إعادة الطلب"
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
                      <MoneyInput value={v.costPrice} onChange={(val) => patch({ costPrice: val })} className="h-8 text-xs w-24" placeholder="—" ariaLabel="تكلفة المتغيّر (سعر خاص)" />
                    </Field>
                    <Field label="بيع (المفرد)">
                      <MoneyInput value={v.retail} onChange={(val) => patch({ retail: val })} className="h-8 text-xs w-24" placeholder="—" ariaLabel="سعر بيع المتغيّر (سعر خاص)" />
                    </Field>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">يتبع التسعير المشترك في قالب الوحدات.</p>
                )}
              </div>

              {/* عرض/إزالة إرثية فقط؛ إضافة صورة اللون واستبدالها عبر Product Studio. */}
              <div className="border-t pt-3">
                <p className="text-[11px] font-semibold text-muted-foreground mb-2">صورة هذا اللون</p>
                {v.image ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <img src={v.image} alt={`صورة ${v.color || v.sku}`} className="size-20 rounded-md border object-cover" />
                    <button
                      type="button"
                      className="min-h-9 rounded-md border px-3 text-xs text-destructive hover:bg-destructive/10"
                      onClick={() => patch({ image: null })}
                    >
                      إزالة عند الحفظ
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">تُضاف صورة هذا اللون بعد حفظ المنتج عبر استوديو صور المنتجات.</p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
