// بطاقة «أدائي» في صفحة حسابي — عرض ذاتي بحت لأداء الموظف الشهري (وحدة الأهداف والعمولات، S5).
// تختفي كلياً لمن لا موظف/خطة/هدف له (myStatus يعيد null). لا تكشف أي زميل ولا تكلفة/ربحاً.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { iqd } from "@/lib/hr/ui";
import { trpc } from "@/lib/trpc";
import { TrendingUp } from "lucide-react";

const STATUS_LABEL: Record<string, string> = { draft: "قيد المراجعة", approved: "معتمدة" };

export function MyPerformanceCard() {
  const status = trpc.commissions.performance.myStatus.useQuery(undefined, { staleTime: 60_000 });
  const d = status.data;
  if (!d) return null; // لا موظف مرتبط / لا خطة ولا هدف — لا بطاقة.

  const pct = d.achievementPct != null ? Number(d.achievementPct) : null;
  const reached = pct != null && pct >= 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="size-4" aria-hidden /> أدائي — {d.period}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs text-muted-foreground">صافي مبيعاتي هذا الشهر (بعد المرتجعات)</div>
            <div className="text-2xl font-bold tabular-nums" dir="ltr">{iqd(d.effectiveBase)} <span className="text-xs font-normal">د.ع</span></div>
            {Number(d.carryIn) !== 0 && (
              <div className="text-[11px] text-money-negative tabular-nums" dir="ltr">مرحَّل سابق: {iqd(d.carryIn)}</div>
            )}
          </div>
          <div className="text-start">
            <div className="text-xs text-muted-foreground">{d.target != null ? "الهدف الشهري" : "لا هدف محدَّداً لهذا الشهر"}</div>
            {d.target != null && <div className="text-lg font-bold tabular-nums" dir="ltr">{iqd(d.target)}</div>}
          </div>
        </div>

        {pct != null && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">نسبة تحقيق الهدف</span>
              <span className={`font-bold tabular-nums ${reached ? "text-money-positive" : ""}`} dir="ltr">{pct.toFixed(1)}%</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`h-full rounded-full ${reached ? "bg-[var(--money-positive,#059669)]" : "bg-primary"}`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-accent/50 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {d.settled ? `عمولة الشهر (${STATUS_LABEL[d.settled.status]})` : "عمولتي المتوقّعة (تقديرية — تُعتمد بتشغيلة الشهر)"}
          </span>
          <span className="font-bold tabular-nums text-money-positive" dir="ltr">
            {iqd(d.settled ? d.settled.commissionAmount : d.projectedCommission)} د.ع
          </span>
        </div>
        {d.planName && <div className="text-[11px] text-muted-foreground">الخطة: {d.planName}</div>}

        {d.history.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">الأشهر السابقة</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 text-start font-normal">الشهر</th>
                  <th className="py-1 text-end font-normal">صافي المبيعات</th>
                  <th className="py-1 text-end font-normal">العمولة</th>
                  <th className="py-1 text-center font-normal">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {d.history.map((h) => (
                  <tr key={h.period} className="border-t">
                    <td className="py-1 tabular-nums" dir="ltr">{h.period}</td>
                    <td className="py-1 text-end tabular-nums" dir="ltr">{iqd(h.effectiveBase)}</td>
                    <td className="py-1 text-end tabular-nums font-medium" dir="ltr">{iqd(h.commissionAmount)}</td>
                    <td className="py-1 text-center">{STATUS_LABEL[h.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
