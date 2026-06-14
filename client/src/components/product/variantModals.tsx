/**
 * variantModals.tsx — نافذتان لشاشة المتغيّرات:
 *  - ImportModal: لصق صفوف Excel (ذهاب-وإياب مع التصدير) ← دمج بمفتاح color|size.
 *  - LabelPrintModal: طباعة ملصق لكل وحدة من كل لون مفعّل، بالكمية المطلوبة،
 *    عبر قالب النظام المُعلَّم (printBarcodeSheet) — نفس تصميم صفحة «ملصقات الباركود».
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { printBarcodeSheet, type BarcodeLabelItem } from "@/lib/printing/printTemplates";
import {
  isValidEan13,
  onlyDigits,
  parseVariantPaste,
  toArabicDigits,
  variantStockTotal,
  type ClientUnit,
  type ClientVariant,
  type ParsedVariantRow,
} from "@/lib/variants";
import { ColorDot } from "./variantBits";

/* ============================ استيراد / لصق ============================ */

/** مثال يتكيّف مع عدد الوحدات في القالب (عمود باركود لكل وحدة) — كي يطابق التحليل. */
function buildSample(unitCount: number): string {
  const rows: Array<[string, string, string]> = [
    ["أزرق", "M", "24"],
    ["أزرق", "L", "18"],
    ["أخضر", "M", "30"],
  ];
  return rows
    .map(([color, size, stock], r) => {
      const barcodes = Array.from({ length: Math.max(1, unitCount) }, (_, i) => String(6291041500244 + r * 1000 + i * 100));
      return [color, size, "", ...barcodes, stock].join("\t");
    })
    .join("\n");
}

export function ImportModal({
  open,
  onOpenChange,
  units,
  onImport,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  units: ClientUnit[];
  onImport: (rows: ParsedVariantRow[]) => void;
}) {
  const [text, setText] = useState("");
  const parsed = parseVariantPaste(text, units.length);
  const headerHint = ["اللون", "القياس", "SKU", ...units.map((u) => `باركود ${u.name || "وحدة"}`), "المخزون"].join(" · ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>استيراد / لصق من Excel</DialogTitle>
          <DialogDescription>
            الصق صفوفاً من Excel (مفصولة بـ Tab) بنفس ترتيب أعمدة التصدير. الأعمدة الفارغة تُملأ تلقائياً، والدمج بمفتاح اللون+القياس.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-mono text-muted-foreground truncate" dir="ltr">{headerHint}</p>
            <button type="button" className="text-[11px] text-primary hover:underline shrink-0" onClick={() => setText(buildSample(units.length))}>
              إدراج مثال
            </button>
          </div>
          <Textarea
            rows={6}
            dir="ltr"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"أزرق\tM\t\t6291041500244\t…\t24"}
            className="font-mono text-xs"
          />
          {parsed.length > 0 && (
            <div className="rounded-lg border overflow-hidden max-h-56 overflow-y-auto">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0">
                  <tr className="bg-muted/60 text-[11px] text-muted-foreground">
                    <th className="px-2 py-1.5">اللون</th>
                    <th className="px-2 py-1.5">القياس</th>
                    {units.map((u) => (
                      <th key={u.id} className="px-2 py-1.5">باركود {u.name || "وحدة"}</th>
                    ))}
                    <th className="px-2 py-1.5">مخزون</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.slice(0, 8).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1.5"><span className="inline-flex items-center gap-1"><ColorDot name={r.color} size={10} />{r.color}</span></td>
                      <td className="px-2 py-1.5" dir="ltr">{r.size || "—"}</td>
                      {units.map((u, j) => (
                        <td key={u.id} className="px-2 py-1.5 font-mono" dir="ltr">{r.barcodes[j] || "—"}</td>
                      ))}
                      <td className="px-2 py-1.5 text-center">{toArabicDigits(r.stock || "0")}</td>
                    </tr>
                  ))}
                  {parsed.length > 8 && (
                    <tr className="border-t">
                      <td colSpan={3 + units.length} className="px-2 py-1.5 text-center text-muted-foreground">
                        + {toArabicDigits(parsed.length - 8)} صف آخر…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {parsed.length ? <>سيُضاف/يُحدَّث <b className="text-foreground">{toArabicDigits(parsed.length)}</b> متغيّر</> : "لا صفوف بعد"}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>إلغاء</Button>
            <Button
              type="button"
              size="sm"
              disabled={!parsed.length}
              onClick={() => {
                onImport(parsed);
                setText("");
                onOpenChange(false);
              }}
            >
              إضافة المتغيّرات
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ طباعة الملصقات بالجملة ============================ */

interface PrintLabel {
  key: string;
  variant: ClientVariant;
  unit: ClientUnit;
  barcode: string;
  qty: string;
}

export function LabelPrintModal({
  open,
  onOpenChange,
  variants,
  units,
  baseName,
  baseRetail,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  variants: ClientVariant[];
  units: ClientUnit[];
  baseName: string;
  baseRetail: string;
}) {
  // كمية مخصّصة لكل (متغيّر×وحدة) — الافتراضي: وحدة الأساس = مخزون اللون، غيرها = 0.
  const [qtyOverride, setQtyOverride] = useState<Record<string, string>>({});

  const labels: PrintLabel[] = [];
  for (const v of variants) {
    if (!v.isActive) continue;
    for (const u of units) {
      const barcode = (v.unitBarcodes[u.id] || "").trim();
      if (!barcode) continue;
      const key = `${v.id}:${u.id}`;
      const def = u.isBase ? String(variantStockTotal(v.stockByBranch)) : "0";
      labels.push({ key, variant: v, unit: u, barcode, qty: qtyOverride[key] ?? def });
    }
  }
  const totalCopies = labels.reduce((s, l) => s + (parseInt(l.qty, 10) || 0), 0);

  const priceFor = (l: PrintLabel) =>
    l.unit.isBase && l.variant.priceOverride && l.variant.retail.trim()
      ? l.variant.retail.trim()
      : l.unit.retail.trim() || (l.unit.isBase ? baseRetail : "");

  function doPrint() {
    const items: BarcodeLabelItem[] = labels.flatMap((l) => {
      const n = parseInt(l.qty, 10) || 0;
      const fullName = [baseName, l.variant.color, l.variant.size].filter(Boolean).join(" ") + ` — ${l.unit.name || "وحدة"}`;
      return Array.from({ length: n }, () => ({
        name: fullName,
        sku: l.variant.sku,
        price: priceFor(l) || null,
        barcode: l.barcode,
      }));
    });
    if (items.length) printBarcodeSheet(items);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>طباعة الملصقات بالجملة</DialogTitle>
          <DialogDescription>
            ملصق لكل وحدة من كل لون مفعّل — الكمية الافتراضية = المخزون الافتتاحي للأساس. عدّلها ثم اطبع الورقة كاملة (تصميم النظام المُعلَّم).
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto">
          {labels.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              لا باركودات صالحة للطباعة بعد. أدخل باركوداً لوحدة واحدة على الأقل من لون مفعّل.
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {labels.map((l) => (
                <div key={l.key} className="rounded-lg border bg-card p-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                      <ColorDot name={l.variant.color} size={11} />
                      {l.variant.color || "—"}{l.variant.size ? ` · ${l.variant.size}` : ""}
                    </span>
                    <span className="text-[10px] rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground">{l.unit.name || "وحدة"}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate" dir="ltr">{l.barcode}{!isValidEan13(l.barcode) ? " ⚠" : ""}</div>
                  <label className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
                    عدد النسخ:
                    <Input
                      value={l.qty}
                      onChange={(e) => setQtyOverride((q) => ({ ...q, [l.key]: onlyDigits(e.target.value) }))}
                      dir="ltr"
                      className="h-7 w-16 text-center text-xs"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {toArabicDigits(labels.length)} ملصق مختلف • {toArabicDigits(totalCopies)} نسخة إجمالاً
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>إغلاق</Button>
            <Button type="button" size="sm" disabled={!totalCopies} onClick={doPrint}>
              اطبع {toArabicDigits(totalCopies)} ملصق ⎙
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
