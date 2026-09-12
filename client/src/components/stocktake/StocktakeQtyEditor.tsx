import { useMemo, useState } from "react";
import { Check, Hourglass, RefreshCw } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { PortalState } from "@shared/countPortalMerge";
import type { QueuedCount } from "@/lib/countQueue";
import { fmtInt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogFooter } from "@/components/ui/dialog";

export type CountItem = PortalState["items"][number];
export type CountMode = "FIRST" | "RECOUNT" | "VERIFY";

/** اسم الوحدة الأساس (factor=1) — كل الكميات تُحفظ بها. */
export function baseUnitName(item: CountItem) {
  const base = item.units.find((u) => u.factor === 1);
  return base?.unitName ?? item.units[0]?.unitName ?? "قطعة";
}

export interface StocktakeQtyEditorProps {
  item: CountItem;
  mode: CountMode;
  recountReason?: string;
  /** عدّة محفوظة على الجهاز لم تُزامَن بعد — أحدث من `item.myCount` فتسبقها في التعبئة. */
  queued?: QueuedCount;
  focusUnit: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (qty: number, unitBreakdown: string | undefined) => void;
}

export function StocktakeQtyEditor({
  item,
  mode,
  recountReason,
  queued,
  focusUnit,
  saving,
  onCancel,
  onSave,
}: StocktakeQtyEditorProps) {
  const isVerify = mode === "VERIFY";
  const isRecount = mode === "RECOUNT";
  // من الأكبر للأصغر (كرتون ← درزن ← قطعة) — نفس ترتيب بوابة العدّ.
  const units = useMemo(() => {
    const list = item.units.map((u) => ({ unitName: u.unitName, factor: u.factor }));
    if (list.length === 0) list.push({ unitName: "قطعة", factor: 1 });
    return list.sort((a, b) => b.factor - a.factor);
  }, [item.units]);
  const baseUnit = baseUnitName(item);

  const [vals, setVals] = useState<Record<string, string>>(() => {
    // إعادة العدّ والعدّ التحقّقي عدٌّ جديد **أعمى** يبدأ من الصفر (كبوابة العدّ) — التعبئة
    // المسبقة للعدّ الأول فقط: المحفوظ محلياً أولاً (الأحدث) ثم المُزامَن.
    if (mode !== "FIRST") return {};
    const src = queued?.unitBreakdown ?? item.myCount?.unitBreakdown ?? null;
    if (src) {
      try {
        const parsed = JSON.parse(src) as Record<string, unknown>;
        const init: Record<string, string> = {};
        for (const u of item.units) {
          const v = parsed[u.unitName];
          if (typeof v === "number" && Number.isInteger(v) && v >= 0)
            init[u.unitName] = String(v);
        }
        if (Object.keys(init).length > 0) return init;
      } catch {
        /* تفصيل غير قابل للقراءة — نبدأ من الإجمالي */
      }
    }
    const fallbackQty = queued?.qty ?? item.myCount?.qty ?? null;
    if (fallbackQty != null) return { [baseUnitName(item)]: String(fallbackQty) };
    return {};
  });

  const setVal = (unitName: string, raw: string) =>
    setVals((v) => ({ ...v, [unitName]: raw.replace(/\D/g, "").slice(0, 7) }));
  const step = (unitName: string, delta: number) =>
    setVals((v) => {
      const cur = parseInt(v[unitName] || "0", 10) || 0;
      return { ...v, [unitName]: String(Math.max(0, cur + delta)) };
    });

  // الكميات أعداد صحيحة (ليست أموالاً) — حساب عددي مباشر.
  const entries: Record<string, number> = {};
  for (const u of units) {
    const raw = vals[u.unitName];
    if (raw !== undefined && raw !== "") entries[u.unitName] = parseInt(raw, 10) || 0;
  }
  const total = units.reduce((s, u) => s + (entries[u.unitName] ?? 0) * u.factor, 0);
  const anyEntered = Object.keys(entries).length > 0;
  const valid = anyEntered && Number.isSafeInteger(total) && total >= 0;

  const handleSave = () => {
    if (!valid || saving) return;
    const json = JSON.stringify(entries);
    onSave(total, units.length > 1 && json.length <= 500 ? json : undefined);
  };

  return (
    <div className="space-y-4">
      {isRecount && (
        <p className="badge-stock-low inline-flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold leading-relaxed">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            مطلوب إعادة عدّ ثانية لهذا المنتج
            {recountReason ? ` — السبب: ${recountReason}` : ""}. عُدّ من جديد
            بتمعّن.
          </span>
        </p>
      )}
      {isVerify && (
        <p className="inline-flex items-start gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold leading-relaxed text-primary">
          <span className="mt-0.5 inline-flex shrink-0 items-center -space-x-1 rtl:space-x-reverse">
            <Check className="size-3.5" aria-hidden />
            <Check className="size-3.5" aria-hidden />
          </span>
          <span>
            عدّ تحقّقي — المنتج عدّه زميلك سابقاً. عدّك لن يستبدل عدّه: إن تطابقا
            تأكّد الرقم، وإن اختلفا يُرفع تعارض يفصل فيه المسؤول. (كميته لا تُعرض
            لك — جرد أعمى)
          </span>
        </p>
      )}
      {queued && (
        <p className="inline-flex items-start gap-1.5 rounded-lg bg-muted p-3 text-xs font-semibold text-muted-foreground">
          <Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            عدّتك السابقة لهذا المنتج محفوظة على الجهاز ولم تُزامَن بعد — تعديلها
            هنا يستبدلها، وتُرسَل تلقائياً عند عودة الاتصال.
          </span>
        </p>
      )}
      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="text-muted-foreground">
          أدخل الكمية الفعلية على الرف — لكل وحدة حقلها، والإجمالي يُحتسب
          بـ«{baseUnit}».
        </p>
      </div>

      <div className="space-y-2">
        {units.map((u) => {
          const cur = vals[u.unitName] ?? "";
          return (
            <div
              key={u.unitName}
              className={cn(
                "flex items-center gap-2 rounded-xl border bg-card px-3 py-2.5",
                focusUnit === u.unitName && "border-primary ring-1 ring-primary/40",
              )}
            >
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{u.unitName}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {u.factor === 1
                    ? "وحدة الأساس"
                    : `= ${fmtInt(u.factor)} ${baseUnit}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5" dir="ltr">
                <button
                  type="button"
                  aria-label={`إنقاص ${u.unitName}`}
                  onClick={() => step(u.unitName, -1)}
                  disabled={(parseInt(cur || "0", 10) || 0) === 0}
                  className="grid size-11 place-items-center rounded-lg border bg-background text-xl font-bold active:scale-95 disabled:opacity-40"
                >
                  −
                </button>
                <Input
                  autoFocus={focusUnit ? focusUnit === u.unitName : u.factor === 1}
                  inputMode="numeric"
                  dir="ltr"
                  value={cur}
                  placeholder="0"
                  onChange={(e) => setVal(u.unitName, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                  aria-label={`كمية ${u.unitName}`}
                  className="h-11 w-20 text-center font-mono text-lg font-bold"
                />
                <button
                  type="button"
                  aria-label={`زيادة ${u.unitName}`}
                  onClick={() => step(u.unitName, 1)}
                  className="grid size-11 place-items-center rounded-lg border bg-background text-xl font-bold active:scale-95"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between rounded-xl bg-primary/5 px-4 py-3">
        <span className="text-sm font-bold">الإجمالي بالوحدة الأساس</span>
        <span
          className="font-mono text-xl font-bold tabular-nums text-primary"
          dir="ltr"
        >
          {fmtInt(total)} {baseUnit}
        </span>
      </div>

      <DialogFooter className="flex-col gap-2 sm:flex-row">
        <Button variant="outline" disabled={saving} onClick={onCancel}>
          إلغاء
        </Button>
        <Button disabled={saving || !valid} onClick={handleSave}>
          {saving
            ? ACTION_LABELS.saving
            : isVerify
              ? "تسجيل العدّ التحقّقي"
              : isRecount
                ? "تسجيل إعادة العدّ"
                : "تسجيل الكمية"}
        </Button>
      </DialogFooter>
      <p className="text-center text-[11px] text-muted-foreground">
        يُسجَّل الإدخال باسمك ووقته — يمكنك تعديل العدّ قبل التسليم.
      </p>
    </div>
  );
}
