/**
 * UsagePanel — يعرض ملخّص نشاط كيان (مستخدم/موظف) عبر النظام.
 *
 * يخدم غرضين: (١) إظهار «البيانات الفعلية» لما فعله الكيان (يُستعمل أيضاً عند مسح كوده)،
 * و(٢) توضيح سبب منع الحذف النهائي حين يكون غير نظيف.
 */

export interface UsageSummaryView {
  clean: boolean;
  total: number;
  categories: { key: string; label: string; count: number }[];
}

export function UsagePanel({
  usage,
  cleanText = "✓ لا نشاط مسجّل — نظيف، يمكن حذفه نهائياً.",
}: {
  usage?: UsageSummaryView;
  cleanText?: string;
}) {
  if (!usage) return <p className="text-xs text-muted-foreground">جارٍ حساب النشاط…</p>;
  if (usage.clean) return <p className="text-sm text-emerald-600">{cleanText}</p>;
  const active = usage.categories.filter((c) => c.count > 0);
  return (
    <div className="space-y-1">
      <p className="text-sm text-amber-600">مرتبط بسجلّات في النظام (لا يمكن الحذف النهائي):</p>
      <div className="flex flex-wrap gap-1">
        {active.map((c) => (
          <span key={c.key} className="text-[11px] rounded bg-muted px-1.5 py-0.5">
            {c.label}: <span dir="ltr" className="tabular-nums font-medium">{c.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
