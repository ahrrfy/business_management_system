// فلتر فترة موحّد لكل تقرير زمني — فترات جاهزة (اليوم/الأسبوع/الشهر/الربع/السنة/الشهر الماضي/مخصّص)
// + تبديل اختياري للمقارنة (مقابل الفترة السابقة / السنة الماضية). نمط عالمي أساسي في التقارير.
// مكوّن متحكَّم به: يستقبل value ويُصدر onChange بصيغة YYYY-MM-DD ليوم المحاسبة UTC.
// يطابق businessDay الخادمي، بصرف النظر عن المنطقة الزمنية لجهاز المستخدم.
import { useId, useMemo } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import {
  REPORT_PERIOD_LABELS,
  REPORT_COMPARE_LABELS,
} from "@shared/reportPeriod";

export type PresetKey = keyof typeof REPORT_PERIOD_LABELS;
export type CompareMode = keyof typeof REPORT_COMPARE_LABELS;

export interface PeriodValue {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  preset: PresetKey;
}

/** يوم المحاسبة UTC؛ العرض المحلي للساعة لا يغيّر يوم القيد. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** يحسب نطاق [from,to] لفترة جاهزة بالنسبة لليوم الحالي. */
export function presetRange(
  preset: PresetKey,
  today = new Date(),
): { from: string; to: string } {
  const t = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const to = ymd(t);
  switch (preset) {
    case "today":
      return { from: to, to };
    case "week": {
      const f = new Date(t);
      f.setUTCDate(t.getUTCDate() - 6); // آخر ٧ أيام شاملةً اليوم
      return { from: ymd(f), to };
    }
    case "mtd":
      return {
        from: ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))),
        to,
      };
    case "qtd": {
      const q = Math.floor(t.getUTCMonth() / 3) * 3;
      return { from: ymd(new Date(Date.UTC(t.getUTCFullYear(), q, 1))), to };
    }
    case "ytd":
      return { from: ymd(new Date(Date.UTC(t.getUTCFullYear(), 0, 1))), to };
    case "lastMonth": {
      const first = new Date(
        Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1),
      );
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
      return { from: ymd(first), to: ymd(last) };
    }
    default:
      return {
        from: ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))),
        to,
      };
  }
}

/** النطاق المقارَن: السابق (نفس الطول، ينتهي قبل from بيوم) أو السنة الماضية (نفس التواريخ −سنة). */
export function comparativeRange(
  from: string,
  to: string,
  mode: CompareMode,
): { from: string; to: string } | null {
  if (mode === "none") return null;
  const f = new Date(from + "T00:00:00Z");
  const t = new Date(to + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    isNaN(f.getTime()) ||
    isNaN(t.getTime()) ||
    ymd(f) !== from ||
    ymd(t) !== to ||
    f > t
  )
    return null;
  if (mode === "yoy") {
    const pf = new Date(f);
    pf.setUTCDate(1);
    pf.setUTCFullYear(f.getUTCFullYear() - 1);
    pf.setUTCDate(
      Math.min(
        f.getUTCDate(),
        new Date(
          Date.UTC(pf.getUTCFullYear(), pf.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    );
    const pt = new Date(t);
    pt.setUTCDate(1);
    pt.setUTCFullYear(t.getUTCFullYear() - 1);
    pt.setUTCDate(
      Math.min(
        t.getUTCDate(),
        new Date(
          Date.UTC(pt.getUTCFullYear(), pt.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    );
    return { from: ymd(pf), to: ymd(pt) };
  }
  // prev: نطاقٌ بنفس عدد الأيام ينتهي في اليوم السابق لـfrom.
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000);
  const pt = new Date(f);
  pt.setUTCDate(f.getUTCDate() - 1);
  const pf = new Date(pt);
  pf.setUTCDate(pt.getUTCDate() - days);
  return { from: ymd(pf), to: ymd(pt) };
}

/** React lazy initializer: يلتقط اليوم عند فتح التقرير، لا عند تحميل حزمة التطبيق. */
export const DEFAULT_PERIOD = (): PeriodValue => ({
  ...presetRange("mtd"),
  preset: "mtd",
});

const inputCls = "h-8 w-32 min-w-0 text-xs";

export function PeriodFilter({
  value,
  onChange,
  compare,
  onCompareChange,
}: {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  /** عند تمريره يظهر اختيار المقارنة. */
  compare?: CompareMode;
  onCompareChange?: (m: CompareMode) => void;
}) {
  const presetId = useId();
  const setPreset = (preset: PresetKey) => {
    if (preset === "custom") {
      onChange({ ...value, preset: "custom" });
      return;
    }
    onChange({ ...presetRange(preset), preset });
  };

  const compareLabel = useMemo(() => {
    if (!compare || compare === "none") return null;
    const r = comparativeRange(value.from, value.to, compare);
    return r ? `${r.from} — ${r.to}` : null;
  }, [compare, value.from, value.to]);

  return (
    <div
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
      role="group"
      aria-label="فترة التقرير"
    >
      <label className="sr-only" htmlFor={presetId}>
        الفترة الجاهزة
      </label>
      <AppSelect
        id={presetId}
        size="sm"
        className="w-32 text-xs"
        value={value.preset}
        onValueChange={(next) => setPreset(next as PresetKey)}
        aria-label="الفترة الجاهزة"
      >
        {(Object.keys(REPORT_PERIOD_LABELS) as PresetKey[]).map((preset) => (
          <option key={preset} value={preset}>
            {REPORT_PERIOD_LABELS[preset]}
          </option>
        ))}
      </AppSelect>

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-2xs text-muted-foreground">من</span>
        <Input
          type="date"
          value={value.from}
          onChange={(e) =>
            onChange({ ...value, from: e.target.value, preset: "custom" })
          }
          className={inputCls}
          aria-label="من تاريخ"
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-2xs text-muted-foreground">إلى</span>
        <Input
          type="date"
          value={value.to}
          onChange={(e) =>
            onChange({ ...value, to: e.target.value, preset: "custom" })
          }
          className={inputCls}
          aria-label="إلى تاريخ"
        />
      </div>
      {compare !== undefined && onCompareChange && (
        <AppSelect
          size="sm"
          className="w-32 text-xs"
          value={compare}
          onValueChange={(next) => onCompareChange(next as CompareMode)}
          aria-label="المقارنة"
        >
          {(Object.keys(REPORT_COMPARE_LABELS) as CompareMode[]).map((m) => (
            <option key={m} value={m}>
              {REPORT_COMPARE_LABELS[m]}
            </option>
          ))}
        </AppSelect>
      )}
      {compareLabel && <span className="sr-only">{compareLabel}</span>}
    </div>
  );
}
