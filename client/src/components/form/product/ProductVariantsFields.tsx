/**
 * ProductVariantsFields — قالبُ الوحدات والأسعار + المتغيّرات (المصفوفة/الجدول/الاستيراد/الملصقات)،
 * القسمُ الثاني من `ProductFormFields` (م٦ ق٤ / D5) — واحدٌ للإنشاء والتعديل.
 *
 * الفروقُ المشروعة بين الوضعين، كلُّها في `mode` لا في نسخةٍ ثانية من المكوّن:
 *   • المخزون يُحرَّر في الإنشاء (رصيدٌ افتتاحيّ) وقراءةٌ فقط في التعديل (يُدار عبر الجرد/الحركات).
 *   • بدائلُ الباركود: محلّيةٌ في الإنشاء (تُدرَج ذرّياً مع المنتج)، وحوارٌ خادميّ فوريّ في التعديل.
 *   • سجلُّ السعر لكلّ وحدةٍ محفوظة في التعديل وحده (لا تاريخَ لمنتجٍ لم يُحفَظ).
 *   • حذفُ متغيّرٍ محفوظ يُعطّله (حفظاً للمخزون)، والجديدُ يُحذف.
 * الأرقامُ لاتينية — قرار المالك.
 */
import { useState } from "react";
import { X } from "lucide-react";

import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { NumberInput } from "@/components/form/NumberInput";
import { MarginBadge } from "@/components/product/variantBits";
import { BulkTools, MatrixGenerator } from "@/components/product/VariantMatrix";
import { VariantsTable } from "@/components/product/VariantsTable";
import { ImportModal, LabelPrintModal } from "@/components/product/variantModals";
import { exportRows } from "@/lib/export";
import {
  genEan13,
  incEan13,
  isValidEan13,
  syncColorChipsOnRename,
  variantStockTotal,
  type ClientUnit,
  type ClientVariant,
} from "@/lib/variants";
import type { ProductModelPatch } from "./ProductFormFields";
import {
  applyImportRows,
  baseRetailOf,
  dbVariantId,
  finalName,
  generateVariants,
  isDbVariant,
  type ProductFormMode,
  type ProductFormModel,
} from "./productFormModel";

export type ProductVariantsFieldsProps = {
  mode: ProductFormMode;
  model: ProductFormModel;
  onChange: (patch: ProductModelPatch) => void;
  branches: Array<{ id: number; name: string }>;
  branchId: number;
  onBranchChange: (id: number) => void;
  takenInDb: Set<string>;
  onOpenAliasDialog?: (target: { variantId: number; unitName: string; label: string }) => void;
};

export function ProductVariantsFields({
  mode,
  model,
  onChange,
  branches,
  branchId,
  onBranchChange,
  takenInDb,
  onOpenAliasDialog,
}: ProductVariantsFieldsProps) {
  const isCreate = mode === "create";
  const [importOpen, setImportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const name = finalName(model);
  const baseRetail = baseRetailOf(model);
  const activeCount = model.variants.filter((v) => v.isActive).length;
  const totalStock = model.variants.reduce((s, v) => s + variantStockTotal(v.stockByBranch), 0);
  const includedCount = model.colors.length
    ? model.sizes.length
      ? model.colors.flatMap((c) => model.sizes.map((s) => `${c}|${s}`)).filter((k) => !model.excluded.includes(k)).length
      : model.colors.length
    : 0;

  /* ── الوحدات ── */
  const addUnit = () =>
    onChange((m) => ({
      units: [...m.units, { id: m.nextUnitId, name: "", factor: "", isBase: false, sellInStore: false, retail: "", wholesale: "", government: "" }],
      nextUnitId: m.nextUnitId + 1,
    }));
  const patchUnit = (id: number, patch: Partial<ClientUnit>) =>
    onChange((m) => ({ units: m.units.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const removeUnit = (id: number) =>
    onChange((m) => {
      if (m.units.length <= 1) return {};
      const next = m.units.filter((x) => x.id !== id);
      // إن حُذفت وحدة الأساس، رقِّ الأولى الباقية أساساً — وإلّا بقي القالب بلا أساس ويُحجَب الحفظ.
      if (!next.some((x) => x.isBase)) next[0] = { ...next[0], isBase: true };
      return { units: next };
    });
  const setBaseUnit = (id: number) => onChange((m) => ({ units: m.units.map((x) => ({ ...x, isBase: x.id === id })) }));

  /* ── المتغيّرات ── */
  const toggleExclude = (key: string) =>
    onChange((m) => ({ excluded: m.excluded.includes(key) ? m.excluded.filter((k) => k !== key) : [...m.excluded, key] }));
  const patchVariant = (id: string, patch: Partial<ClientVariant>) =>
    onChange((m) => ({ variants: m.variants.map((v) => (v.id === id ? { ...v, ...patch } : v)) }));
  // الموجود (db:) لا يُحذف — يُعطَّل حفظاً للمخزون؛ الجديد يُحذف من النموذج.
  const removeVariant = (id: string) =>
    onChange((m) => ({
      variants: isDbVariant(id) ? m.variants.map((v) => (v.id === id ? { ...v, isActive: false } : v)) : m.variants.filter((v) => v.id !== id),
    }));
  const commitColorRename = (oldColor: string, newColor: string) =>
    onChange((m) => ({ colors: syncColorChipsOnRename(m.colors, oldColor, newColor, m.variants.map((v) => v.color)) }));
  const onScan = (vid: string, uid: number) =>
    onChange((m) => ({ variants: m.variants.map((v) => (v.id === vid ? { ...v, unitBarcodes: { ...v.unitBarcodes, [uid]: genEan13("200") } } : v)) }));
  const bulkMin = (val: string) => onChange((m) => ({ variants: m.variants.map((v) => ({ ...v, minStock: val })) }));
  const bulkStock = (val: string) =>
    onChange((m) => ({ variants: m.variants.map((v) => ({ ...v, stockByBranch: { ...v.stockByBranch, [branchId]: val } })) }));
  const bulkSeq = (uid: number, start: string) =>
    onChange((m) => {
      let code = isValidEan13(start) ? start : genEan13("200");
      return {
        variants: m.variants.map((v) => {
          if (v.unitBarcodes[uid]) return v;
          const next = { ...v, unitBarcodes: { ...v.unitBarcodes, [uid]: code } };
          code = incEan13(code);
          return next;
        }),
      };
    });

  function exportExcel() {
    exportRows(model.variants, {
      filename: `منتج-${name || "بمتغيرات"}`,
      sheetName: "المنتجات",
      columns: [
        { key: "name", header: "الاسم الكامل", map: (v) => [name, v.color, v.size].filter(Boolean).join(" ") },
        { key: "color", header: "اللون", map: (v) => v.color },
        { key: "size", header: "القياس", map: (v) => v.size },
        { key: "sku", header: "SKU", map: (v) => v.sku },
        ...model.units.map((u) => ({ key: `bc_${u.id}`, header: `باركود ${u.name || "وحدة"}`, map: (v: ClientVariant) => v.unitBarcodes[u.id] || "" })),
        { key: "stock", header: "المخزون (كل الفروع)", map: (v) => variantStockTotal(v.stockByBranch) },
        { key: "price", header: "سعر البيع", map: (v) => (v.priceOverride && v.retail.trim() ? v.retail.trim() : baseRetail) },
        { key: "active", header: "الحالة", map: (v) => (v.isActive ? "مفعّل" : "معطّل") },
      ],
    });
  }

  const savedVariants = model.variants.filter((v) => isDbVariant(v.id) && v.isActive);

  return (
    <>
      {/* قالب الوحدات والأسعار المشترك */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">قالب الوحدات والأسعار · مشترك</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              يُطبَّق على كل المتغيّرات (مطابقة بالاسم). ولكل وحدة من كل لون <b>باركودها المستقل</b> (يُدخَل في جدول المتغيّرات).
              {!isCreate && " حذف وحدة من القالب يُعطّلها — لا يمحو تاريخها."}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addUnit}>+ وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="hidden grid-cols-12 gap-2 px-1 text-[11px] font-semibold text-muted-foreground md:grid">
            <span className="col-span-2">الوحدة</span>
            <span className="col-span-1">معامل</span>
            <span className="col-span-2">سعر المفرد</span>
            <span className="col-span-2">سعر الجملة</span>
            <span className="col-span-2">سعر الحكومي</span>
            <span className="col-span-2">الهامش</span>
            <span className="col-span-1 text-center">أساس / متجر</span>
          </div>
          {model.units.map((u) => {
            const factor = u.isBase ? 1 : parseFloat(u.factor) || 1;
            const unitCost = (parseFloat(model.costPrice) || 0) * factor;
            return (
              <div key={u.id} className="grid grid-cols-2 items-center gap-2 border-t pt-2 md:grid-cols-12 md:border-0 md:pt-0">
                <Input className="h-8 text-sm md:col-span-2" value={u.name} onChange={(e) => patchUnit(u.id, { name: e.target.value })} placeholder="قطعة / درزن" />
                <NumberInput className="h-8 text-sm md:col-span-1" disabled={u.isBase} value={u.isBase ? "1" : u.factor} onChange={(factorValue) => patchUnit(u.id, { factor: factorValue })} placeholder="12" decimals={4} ariaLabel="معامل التحويل" />
                <MoneyInput className="h-8 text-sm md:col-span-2" value={u.retail} onChange={(retail) => patchUnit(u.id, { retail })} placeholder="مفرد" ariaLabel="سعر المفرد" />
                <MoneyInput className="h-8 text-sm md:col-span-2" value={u.wholesale} onChange={(wholesale) => patchUnit(u.id, { wholesale })} placeholder="جملة" ariaLabel="سعر الجملة" />
                <MoneyInput className="h-8 text-sm md:col-span-2" value={u.government ?? ""} onChange={(government) => patchUnit(u.id, { government })} placeholder="حكومي" ariaLabel="سعر الحكومي" />
                <div className="md:col-span-2"><MarginBadge cost={unitCost} sell={u.retail} /></div>
                <div className="flex items-center justify-center gap-2 md:col-span-1">
                  <input type="radio" name="baseUnit" checked={u.isBase} onChange={() => setBaseUnit(u.id)} title="الوحدة الأساس" aria-label="الوحدة الأساس" />
                  <input type="checkbox" checked={u.sellInStore} onChange={(e) => patchUnit(u.id, { sellInStore: e.target.checked })} title="متاحة للبيع في المتجر الإلكتروني" aria-label="متاحة للبيع في المتجر الإلكتروني" />
                  <button type="button" onClick={() => removeUnit(u.id)} disabled={model.units.length <= 1} className="text-muted-foreground hover:text-destructive disabled:opacity-30" aria-label="حذف الوحدة">
                    <X aria-hidden className="size-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* المتغيّرات */}
      <Card>
        <CardHeader className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              المتغيّرات (الألوان والقياسات)
              <Badge variant="secondary" className="bg-primary/10 text-primary" dir="ltr">{model.variants.length}</Badge>
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {isCreate
                ? "كل صفّ منتج مخزنيّ مستقل: SKU ورصيد لكل فرع وظهور منفصل في البيع — وباركود مستقل لكل وحدة. افتح تفاصيل الصفّ (السهم) لإضافة «بدائل»."
                : "عدّل الموجود أو أضِف جديداً. حذف لون موجود يعطّله (حفظاً للمخزون). المخزون قراءة فقط هنا."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              الفرع:
              <AppSelect value={String(branchId)} onValueChange={(next) => onBranchChange(Number(next))} className="h-8 border-input px-2 text-xs text-foreground">
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </AppSelect>
            </label>
            <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>استيراد / لصق</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPrintOpen(true)} disabled={!model.variants.length}>طباعة الملصقات</Button>
            <Button type="button" variant="outline" size="sm" onClick={exportExcel} disabled={!model.variants.length}>تصدير Excel</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <MatrixGenerator
            colors={model.colors}
            setColors={(colors) => onChange({ colors })}
            sizes={model.sizes}
            setSizes={(sizes) => onChange({ sizes })}
            excluded={new Set(model.excluded)}
            toggleExclude={toggleExclude}
            onGenerate={() => onChange((m) => ({ variants: generateVariants(m) }))}
            includedCount={includedCount}
            existingCount={model.variants.length}
          />
          {model.variants.length > 0 && (
            <BulkTools
              units={model.units}
              branchName={branches.find((b) => b.id === branchId)?.name ?? "الفرع"}
              onMinAll={bulkMin}
              onStockAll={isCreate ? bulkStock : () => { /* المخزون يُدار عبر الجرد/الحركات — لا تعديل بالجملة في التعديل */ }}
              onSeq={bulkSeq}
            />
          )}
          <VariantsTable
            variants={model.variants}
            units={model.units}
            branches={branches}
            branchId={branchId}
            costPrice={model.costPrice}
            baseName={name}
            takenInDb={takenInDb}
            patchVariant={patchVariant}
            removeVariant={removeVariant}
            onScan={onScan}
            onColorCommit={commitColorRename}
            stockEditable={isCreate}
            localAliases={isCreate}
            priceHistory={!isCreate}
            emptyHint={isCreate ? undefined : "لا متغيّرات — أضِف عبر المولّد أعلاه."}
          />
          {model.variants.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-1 text-xs text-muted-foreground">
              <span>الإجمالي: <b className="text-foreground" dir="ltr">{model.variants.length}</b> منتج (<span dir="ltr">{activeCount}</span> مفعّل)</span>
              <span>مخزون كلّي (كل الفروع): <b className="text-foreground" dir="ltr">{totalStock}</b> قطعة</span>
              <span>سعر البيع الأساس: <b className="text-foreground" dir="ltr">{baseRetail || "—"}</b> د.ع</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* بدائل الباركود (التعديل): للمتغيّرات المحفوظة فعلياً — تُحفَظ فوراً بلا انتظار «حفظ التعديلات». */}
      {onOpenAliasDialog && savedVariants.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">بدائل الباركود</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              باركودات إضافية تُشير لنفس الوحدة (نفس السعر والمخزون) — لمسّاح لا يقرأ نوعاً معيّناً، أو لباركود مصنّعٍ قديم. تُحفَظ فوراً.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {savedVariants.map((v) => {
              const withBarcode = model.units.filter((u) => (v.unitBarcodes[u.id] || "").trim());
              const variantId = dbVariantId(v.id) ?? 0;
              return (
                <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span className="min-w-[8rem] text-sm font-medium">{v.color || v.sku}</span>
                  {withBarcode.length === 0 ? (
                    <span className="text-xs text-muted-foreground">لا باركود أساسيّ بعد لهذا المتغيّر — أضِفه في جدول المتغيّرات أعلاه أوّلاً.</span>
                  ) : (
                    withBarcode.map((u) => (
                      <Button key={u.id} type="button" size="sm" variant="outline" onClick={() => onOpenAliasDialog({ variantId, unitName: u.name, label: `${v.color || v.sku} — ${u.name || "وحدة"}` })}>
                        {u.name || "وحدة"}: بدائل
                      </Button>
                    ))
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <ImportModal open={importOpen} onOpenChange={setImportOpen} units={model.units} onImport={(rows) => onChange((m) => ({ variants: applyImportRows(m, rows, branchId, isCreate) }))} />
      <LabelPrintModal open={printOpen} onOpenChange={setPrintOpen} variants={model.variants} units={model.units} baseName={name} baseRetail={baseRetail} />
    </>
  );
}
