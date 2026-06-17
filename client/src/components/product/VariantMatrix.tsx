/**
 * VariantMatrix.tsx — مولّد المصفوفة (ألوان × قياسات + شبكة استثناء) + أدوات الجملة.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COLOR_PRESETS, onlyDigits, toArabicDigits, type ClientUnit } from "@/lib/variants";
import { ChipInput, ColorDot, Field } from "./variantBits";

/* ── مولّد المصفوفة + شبكة الاستثناء ──────────────────── */
export function MatrixGenerator({
  colors,
  setColors,
  sizes,
  setSizes,
  excluded,
  toggleExclude,
  onGenerate,
  includedCount,
  existingCount,
}: {
  colors: string[];
  setColors: (next: string[]) => void;
  sizes: string[];
  setSizes: (next: string[]) => void;
  excluded: Set<string>;
  toggleExclude: (key: string) => void;
  onGenerate: () => void;
  includedCount: number;
  existingCount: number;
}) {
  const hasGrid = colors.length > 0 && sizes.length > 0;
  return (
    <div className="rounded-lg border border-dashed border-primary/40 bg-primary/[0.03] p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="الألوان" hint="اكتب اللون واضغط Enter — أو انقر لوناً شائعاً.">
          <ChipInput items={colors} onChange={setColors} placeholder="أزرق، أسود، أحمر…" withDot presets={COLOR_PRESETS} />
        </Field>
        <Field label="القياسات (اختياري)" hint="للروب/الملابس: S, M, L… تُضرَب في الألوان تلقائياً.">
          <ChipInput items={sizes} onChange={setSizes} placeholder="S، M، L، XL…" />
        </Field>
      </div>

      {hasGrid && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-muted-foreground">
            استبعد التركيبات غير المتوفّرة (انقر الخلية لتعطيلها — مثلاً لون لا يأتي بكل القياسات):
          </p>
          <div className="overflow-x-auto">
            <table className="text-center border-collapse">
              <thead>
                <tr>
                  <th className="p-1" />
                  {sizes.map((s) => (
                    <th key={s} className="p-1 text-[11px] font-medium text-muted-foreground min-w-[44px]" dir="ltr">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {colors.map((c) => (
                  <tr key={c}>
                    <td className="p-1 pe-2 text-[11px] font-medium whitespace-nowrap text-right">
                      <span className="inline-flex items-center gap-1">
                        <ColorDot name={c} size={10} />
                        {c}
                      </span>
                    </td>
                    {sizes.map((s) => {
                      const off = excluded.has(`${c}|${s}`);
                      return (
                        <td key={s} className="p-0.5">
                          <button
                            type="button"
                            onClick={() => toggleExclude(`${c}|${s}`)}
                            className={cn(
                              "h-7 w-11 rounded text-[10px] font-medium transition-colors border",
                              off
                                ? "bg-muted text-muted-foreground/50 line-through border-transparent"
                                : "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20"
                            )}
                          >
                            {off ? "—" : "✓"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          {includedCount > 0 ? (
            <>
              سيُولَّد <b className="text-foreground">{toArabicDigits(includedCount)}</b> متغيّر — كل واحد منتج مخزنيّ مستقل، ولكل وحدة باركود مستقل.
            </>
          ) : (
            <>أضِف لوناً واحداً على الأقل.</>
          )}
        </p>
        <Button type="button" size="sm" onClick={onGenerate} disabled={includedCount === 0}>
          {existingCount > 0 ? "أعِد توليد الجدول" : "ولّد المتغيّرات"}
        </Button>
      </div>
    </div>
  );
}

/* ── أدوات الجملة (تطبيق على الكل + ترقيم تسلسلي) ──────── */
export function BulkTools({
  units,
  branchName,
  onMinAll,
  onStockAll,
  onSeq,
}: {
  units: ClientUnit[];
  branchName: string;
  onMinAll: (val: string) => void;
  onStockAll: (val: string) => void;
  onSeq: (unitId: number, start: string) => void;
}) {
  const [minV, setMinV] = useState("");
  const [stockV, setStockV] = useState("");
  const [seqUnit, setSeqUnit] = useState<number>(units[0]?.id ?? 0);
  const [seqStart, setSeqStart] = useState("");

  // الوحدة المختارة قد تُحذف — ارجع لأول وحدة متاحة.
  const activeSeqUnit = units.some((u) => u.id === seqUnit) ? seqUnit : units[0]?.id ?? 0;

  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-end gap-1.5">
        <Field label="حد أدنى للكل">
          <Input value={minV} onChange={(e) => setMinV(onlyDigits(e.target.value))} dir="ltr" className="h-8 w-20 text-center text-xs" placeholder="10" />
        </Field>
        <Button type="button" variant="outline" size="sm" onClick={() => minV && onMinAll(minV)}>
          تطبيق
        </Button>
      </div>
      <div className="flex items-end gap-1.5">
        <Field label={`مخزون للكل · ${branchName}`}>
          <Input value={stockV} onChange={(e) => setStockV(onlyDigits(e.target.value))} dir="ltr" className="h-8 w-20 text-center text-xs" placeholder="0" />
        </Field>
        <Button type="button" variant="outline" size="sm" onClick={() => onStockAll(stockV || "0")}>
          تطبيق
        </Button>
      </div>
      <div className="flex items-end gap-1.5">
        <Field label="ترقيم باركود تسلسلي" hint="يملأ الخلايا الفارغة للوحدة تصاعدياً.">
          <div className="flex items-center gap-1.5">
            <select
              value={activeSeqUnit}
              onChange={(e) => setSeqUnit(+e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || "وحدة"}
                </option>
              ))}
            </select>
            <Input
              value={seqStart}
              onChange={(e) => setSeqStart(onlyDigits(e.target.value))}
              dir="ltr"
              className="h-8 w-36 font-mono text-xs"
              placeholder="يبدأ من (أو توليد)"
            />
          </div>
        </Field>
        <Button type="button" variant="outline" size="sm" onClick={() => onSeq(activeSeqUnit, seqStart)}>
          تطبيق
        </Button>
      </div>
    </div>
  );
}
