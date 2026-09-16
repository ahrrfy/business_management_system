import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ListPlus, RefreshCw } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { PortalState } from "@shared/countPortalMerge";
import type { QueuedCount } from "@/lib/countQueue";
import { fmtInt } from "@/lib/money";
import { cn } from "@/lib/utils";

export type CountItem = PortalState["items"][number];
export type CountMode = "FIRST" | "RECOUNT" | "VERIFY";

function baseUnitName(item: CountItem): string {
  const base = item.units.find((u) => u.factor === 1);
  return base?.unitName ?? item.units[0]?.unitName ?? "قطعة";
}

export interface CountPortalQtySheetProps {
  item: CountItem;
  mode: CountMode;
  recountReason?: string;
  queued?: QueuedCount;
  saving: boolean;
  tally?: boolean;
  bump?: { unit: string; token: number } | null;
  onCancel: () => void;
  onSave: (qty: number, unitBreakdown: string | undefined) => void;
}

export function CountPortalQtySheet({
  item,
  mode,
  recountReason,
  queued,
  saving,
  tally = false,
  bump = null,
  onCancel,
  onSave,
}: CountPortalQtySheetProps) {
  // وحدات مرتّبة من الأكبر للأصغر (كرتون ← درزن ← قطعة) بنسخة محلية مستقلة النوع.
  const units = useMemo(() => {
    const us = item.units.map((u) => ({ unitName: u.unitName, factor: u.factor, barcode: u.barcode ?? null }));
    if (us.length === 0) us.push({ unitName: "قطعة", factor: 1, barcode: null });
    return us.sort((a, b) => b.factor - a.factor);
  }, [item.units]);
  const baseUnit = baseUnitName(item);

  const [vals, setVals] = useState<Record<string, string>>(() => {
    // في وضع التجميع نبدأ فارغين دائماً (عدٌّ طازجٌ يتراكم بالمسح).
    // وإلا: تعبئة مسبقة عند تعديل عدّي السابق فقط — إعادة العدّ/التحقّقي عدٌّ جديد أعمى من الصفر.
    if (!tally && mode === "FIRST") {
      const src = queued?.unitBreakdown ?? item.myCount?.unitBreakdown ?? null;
      if (src) {
        try {
          const parsed = JSON.parse(src) as Record<string, unknown>;
          const init: Record<string, string> = {};
          for (const u of item.units) {
            const v = parsed[u.unitName];
            if (typeof v === "number" && Number.isInteger(v) && v >= 0) init[u.unitName] = String(v);
          }
          if (Object.keys(init).length > 0) return init;
        } catch {
          /* تفصيل غير قابل للقراءة — نبدأ فارغين */
        }
      }
    }
    return {};
  });

  // وضع التجميع: كل زيادةٍ من الأب (token جديد) تضيف ١ للوحدة الممسوحة.
  // ⚠️ الشرط `tally` إلزاميّ: قد تُفتح بطاقةٌ في الوضع العاديّ و`bump` ما زال يحمل قيمةً قديمة من
  // جلسة تجميعٍ سابقة (لا يُصفَّر إلا عند الإغلاق)، فبدونه يُطبَّق +١ وهميّ عند التركيب.
  const lastBump = useRef(0);
  useEffect(() => {
    if (!tally || !bump || bump.token <= lastBump.current) return;
    lastBump.current = bump.token;
    setVals((v) => {
      const cur = parseInt(v[bump.unit] || "0", 10) || 0;
      return { ...v, [bump.unit]: String(Math.min(cur + 1, 9_999_999)) };
    });
  }, [bump, tally]);

  const setVal = (unitName: string, raw: string) => {
    setVals((v) => ({ ...v, [unitName]: raw.replace(/\D/g, "").slice(0, 7) }));
  };
  const step = (unitName: string, delta: number) => {
    setVals((v) => {
      const cur = parseInt(v[unitName] || "0", 10) || 0;
      const next = Math.max(0, cur + delta);
      return { ...v, [unitName]: String(next) };
    });
  };

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
    onSave(total, json.length <= 500 ? json : undefined);
  };

  const isVerify = mode === "VERIFY";
  const isRecount = mode === "RECOUNT";

  return (
    <div className="flex flex-col">
      <button type="button" onClick={onCancel} className="self-start py-2 text-sm font-bold text-primary">
        → رجوع للقائمة
      </button>

      {tally && (
        <div className="mb-2 inline-flex items-start gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold leading-relaxed text-primary">
          <ListPlus aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>وضع التجميع: كل مسحةٍ لهذا الصنف تزيد وحدتها +1. احفظ عند الانتهاء ثم امسح الصنف التالي.</span>
        </div>
      )}
      {isRecount && (
        <div className="mb-2 inline-flex items-start gap-1.5 rounded-lg bg-[var(--sem-warn-bg)] px-3 py-2 text-xs font-semibold leading-relaxed text-[var(--sem-warn)]">
          <RefreshCw aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>مطلوب إعادة عدّ ثانية لهذا المنتج{recountReason ? ` — السبب: ${recountReason}` : ""}. عُدّ من جديد بتمعّن.</span>
        </div>
      )}
      {isVerify && (
        <div className="mb-2 inline-flex items-start gap-1.5 rounded-lg bg-violet-50 px-3 py-2 text-xs font-semibold leading-relaxed text-violet-800 dark:bg-violet-950/50 dark:text-violet-300">
          <span className="mt-0.5 inline-flex shrink-0 items-center -space-x-1 rtl:space-x-reverse">
            <Check aria-hidden className="size-3.5" />
            <Check aria-hidden className="size-3.5" />
          </span>
          <span>عدّ تحقّقي — المنتج عدّه زميلك سابقاً. عدّك لن يستبدل عدّه: إن تطابقا تأكّد الرقم، وإن اختلفا يُرفع
          تعارض يفصل فيه المسؤول. (كميته لا تُعرض لك — جرد أعمى)</span>
        </div>
      )}
      {!item.isMine && !isVerify && (
        <div className="mb-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold leading-relaxed text-muted-foreground">
          المنتج من منطقة زميل ولم يُعدّ بعد — سيُسجَّل العدّ الأول باسمك.
        </div>
      )}

      <p className="mb-2 mt-3 text-sm font-bold">الكمية المعدودة فعلياً على الرف:</p>
      <div className="space-y-2">
        {units.map((u) => {
          const cur = vals[u.unitName] ?? "";
          return (
            <div key={u.unitName} className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{u.unitName}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {u.factor === 1 ? "وحدة الأساس" : `= ${fmtInt(u.factor)} ${baseUnit}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5" dir="ltr">
                <button
                  type="button"
                  aria-label={`إنقاص ${u.unitName}`}
                  onClick={() => step(u.unitName, -1)}
                  disabled={(parseInt(cur || "0", 10) || 0) === 0}
                  className="grid size-11 place-items-center rounded-lg border border-border bg-background text-xl font-bold active:scale-95 disabled:opacity-40"
                >
                  −
                </button>
                <input
                  inputMode="numeric"
                  dir="ltr"
                  value={cur}
                  placeholder="0"
                  onChange={(e) => setVal(u.unitName, e.target.value)}
                  className="h-11 w-20 rounded-lg border border-border bg-background text-center font-mono text-lg font-bold focus:border-primary focus:outline-none"
                  aria-label={`كمية ${u.unitName}`}
                />
                <button
                  type="button"
                  aria-label={`زيادة ${u.unitName}`}
                  onClick={() => step(u.unitName, 1)}
                  className="grid size-11 place-items-center rounded-lg border border-border bg-background text-xl font-bold active:scale-95"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-primary/5 px-4 py-3">
        <span className="text-sm font-bold">الإجمالي بالوحدة الأساس</span>
        <span className="font-mono text-xl font-bold tabular-nums text-primary" dir="ltr">
          {fmtInt(total)} {baseUnit}
        </span>
      </div>

      <button
        type="button"
        disabled={!valid || saving}
        onClick={handleSave}
        className={cn(
          "mt-4 h-12 w-full rounded-xl text-base font-bold text-white transition-colors",
          valid && !saving
            ? isVerify
              ? "bg-violet-600 active:bg-violet-700"
              : "bg-primary active:bg-primary/90"
            : "cursor-not-allowed bg-muted text-muted-foreground",
        )}
      >
        {saving ? ACTION_LABELS.saving : isVerify ? "تسجيل العدّ التحقّقي" : isRecount ? "تسجيل إعادة العدّ" : "تسجيل الكمية"}
      </button>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        يُسجَّل الإدخال باسمك ووقته — يمكنك تعديل العدّ قبل التسليم.
      </p>
    </div>
  );
}
