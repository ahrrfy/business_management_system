// DateRangeFilter — فلتر مدى تاريخي موحّد (من–إلى) + اختصارات سريعة، للجداول المعاملاتية
// (فواتير/مشتريات/حركات/مصاريف/سندات/مرتجعات/أوامر شغل…).
//
// لماذا موحّد: كان كل صفحة تُعيد بناء حقلَي تاريخ يدوياً (أو تغفلهما)، فاختلف الشكل والسلوك.
// هذا المكوّن يُوحّدهما + يضيف اختصارات (اليوم/الأسبوع/الشهر/الكل) التي يطلبها التشغيل اليومي.
//
// التواريخ بصيغة YYYY-MM-DD **محلّياً** (لا UTC — تجنّب انزياح يوم مع توقيت العراق +3)،
// وتُمرَّر كما هي لحمولة الـAPI (الخادم يفلتر بها). "" = غير محدّد.
//
// الاستعمال:
//   const [range, setRange] = useState({ from: "", to: "" });
//   <DateRangeFilter value={range} onChange={(r) => { setRange(r); setPage(0); }} />
//   …useQuery({ from: range.from || undefined, to: range.to || undefined })
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type DateRange = { from: string; to: string };

/** YYYY-MM-DD محلّياً (لا toISOString — ذاك UTC وقد ينزاح يوماً). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DateRangeFilter({
  value,
  onChange,
  showPresets = true,
  className,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  showPresets?: boolean;
  className?: string;
}) {
  const { from, to } = value;

  function applyPreset(preset: "today" | "week" | "month" | "all") {
    if (preset === "all") {
      onChange({ from: "", to: "" });
      return;
    }
    const now = new Date();
    const todayStr = ymd(now);
    if (preset === "today") {
      onChange({ from: todayStr, to: todayStr });
      return;
    }
    if (preset === "week") {
      // بداية الأسبوع = الأحد (نمط التقويم المحلّي). من بداية الأسبوع إلى اليوم.
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      onChange({ from: ymd(start), to: todayStr });
      return;
    }
    // month: من أوّل الشهر إلى اليوم.
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    onChange({ from: ymd(start), to: todayStr });
  }

  return (
    <div className={cn("flex flex-wrap items-end gap-2", className)}>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">من تاريخ</Label>
        <Input
          type="date"
          dir="ltr"
          className="h-8 w-40"
          value={from}
          max={to || undefined}
          onChange={(e) => onChange({ from: e.target.value, to })}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">إلى تاريخ</Label>
        <Input
          type="date"
          dir="ltr"
          className="h-8 w-40"
          value={to}
          min={from || undefined}
          onChange={(e) => onChange({ from, to: e.target.value })}
        />
      </div>
      {showPresets && (
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => applyPreset("today")}>
            اليوم
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => applyPreset("week")}>
            الأسبوع
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => applyPreset("month")}>
            الشهر
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => applyPreset("all")}>
            الكل
          </Button>
        </div>
      )}
    </div>
  );
}
