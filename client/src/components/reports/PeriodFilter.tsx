// فلتر فترة موحّد لكل تقرير زمني — فترات جاهزة (اليوم/الأسبوع/الشهر/الربع/السنة/الشهر الماضي/مخصّص)
// + تبديل اختياري للمقارنة (مقابل الفترة السابقة / السنة الماضية). نمط عالمي أساسي في التقارير.
// مكوّن متحكَّم به (controlled): يستقبل value ويُصدر onChange بـ{from,to} بصيغة YYYY-MM-DD محلية
// (تطابق localDayStart الخادمي). يصدّر أيضاً دوال حساب النطاقات لإعادة استعمالها في الصفحات.
import { useMemo } from "react";

export type PresetKey = "today" | "week" | "mtd" | "qtd" | "ytd" | "lastMonth" | "custom";
export type CompareMode = "none" | "prev" | "yoy";

export interface PeriodValue {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  preset: PresetKey;
}

/** YYYY-MM-DD **محلي** (لا UTC) — يطابق منتصف الليل المحلي الذي يتوقّعه الخادم. */
export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** يحسب نطاق [from,to] لفترة جاهزة بالنسبة لليوم الحالي. */
export function presetRange(preset: PresetKey, today = new Date()): { from: string; to: string } {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const to = ymd(t);
  switch (preset) {
    case "today":
      return { from: to, to };
    case "week": {
      const f = new Date(t);
      f.setDate(t.getDate() - 6); // آخر ٧ أيام شاملةً اليوم
      return { from: ymd(f), to };
    }
    case "mtd":
      return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to };
    case "qtd": {
      const q = Math.floor(t.getMonth() / 3) * 3;
      return { from: ymd(new Date(t.getFullYear(), q, 1)), to };
    }
    case "ytd":
      return { from: ymd(new Date(t.getFullYear(), 0, 1)), to };
    case "lastMonth": {
      const first = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const last = new Date(t.getFullYear(), t.getMonth(), 0); // اليوم ٠ من الشهر الحالي = آخر يوم سابق
      return { from: ymd(first), to: ymd(last) };
    }
    default:
      return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to };
  }
}

/** النطاق المقارَن: السابق (نفس الطول، ينتهي قبل from بيوم) أو السنة الماضية (نفس التواريخ −سنة). */
export function comparativeRange(
  from: string,
  to: string,
  mode: CompareMode,
): { from: string; to: string } | null {
  if (mode === "none") return null;
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return null;
  if (mode === "yoy") {
    const pf = new Date(f); pf.setFullYear(f.getFullYear() - 1);
    const pt = new Date(t); pt.setFullYear(t.getFullYear() - 1);
    return { from: ymd(pf), to: ymd(pt) };
  }
  // prev: نطاقٌ بنفس عدد الأيام ينتهي في اليوم السابق لـfrom.
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000);
  const pt = new Date(f); pt.setDate(f.getDate() - 1);
  const pf = new Date(pt); pf.setDate(pt.getDate() - days);
  return { from: ymd(pf), to: ymd(pt) };
}

export const DEFAULT_PERIOD: PeriodValue = { ...presetRange("mtd"), preset: "mtd" };

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "اليوم" },
  { key: "week", label: "آخر ٧ أيام" },
  { key: "mtd", label: "هذا الشهر" },
  { key: "qtd", label: "هذا الربع" },
  { key: "ytd", label: "هذه السنة" },
  { key: "lastMonth", label: "الشهر الماضي" },
];

const COMPARE_LABELS: Record<CompareMode, string> = {
  none: "بلا مقارنة",
  prev: "الفترة السابقة",
  yoy: "السنة الماضية",
};

const inputCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

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
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPreset(p.key)}
            className={`rounded-md px-2.5 py-1.5 text-xs transition ${
              value.preset === p.key
                ? "bg-primary text-primary-foreground font-medium"
                : "bg-muted/60 text-foreground/70 hover:bg-accent"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">من</label>
          <input
            type="date"
            value={value.from}
            onChange={(e) => onChange({ ...value, from: e.target.value, preset: "custom" })}
            className={inputCls}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">إلى</label>
          <input
            type="date"
            value={value.to}
            onChange={(e) => onChange({ ...value, to: e.target.value, preset: "custom" })}
            className={inputCls}
          />
        </div>
      </div>
      {compare !== undefined && onCompareChange && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">مقارنة</label>
          <select
            className={inputCls}
            value={compare}
            onChange={(e) => onCompareChange(e.target.value as CompareMode)}
          >
            {(Object.keys(COMPARE_LABELS) as CompareMode[]).map((m) => (
              <option key={m} value={m}>{COMPARE_LABELS[m]}</option>
            ))}
          </select>
          {compareLabel && <span className="text-[10px] text-muted-foreground tabular-nums" dir="ltr">{compareLabel}</span>}
        </div>
      )}
    </div>
  );
}
