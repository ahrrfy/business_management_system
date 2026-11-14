/**
 * client/src/components/offers/OfferKpiSummary.tsx
 *
 * Top KPI metrics, order of promotion application rules, and operational alerts.
 */

import { Card, CardContent } from "@/components/ui/card";
import { TriangleAlert } from "lucide-react";
import { formatIqd } from "@/lib/money";
import type { OfferOperationalSignals, OfferPerformanceSummary } from "./offersTypes";

export interface OfferKpiSummaryProps {
  summary?: OfferPerformanceSummary;
  signals: OfferOperationalSignals;
  canSeeCost?: boolean;
  isLoading?: boolean;
}

function Kpi({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
        {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

export function OfferKpiSummary({ summary, signals, canSeeCost = false }: OfferKpiSummaryProps) {
  const showProfit = canSeeCost && summary?.grossProfit !== null;
  const hasAlerts =
    (showProfit && signals.negative.length > 0) ||
    signals.unusedActive.length > 0 ||
    signals.expiredActive.length > 0;

  return (
    <div className="space-y-4">
      {/* 1. Core KPI Metric Cards */}
      <div className={`grid gap-3 sm:grid-cols-2 ${showProfit ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
        <Kpi
          label="العروض الفعّالة الآن"
          value={signals.activeNow.length}
          note={`${signals.scheduled.length} تبدأ قريباً`}
        />
        <Kpi
          label="فواتير شملتها العروض"
          value={summary?.invoiceCount ?? 0}
        />
        <Kpi
          label="مبيعات العروض الصافية"
          value={formatIqd(summary?.netSales ?? "0")}
        />
        <Kpi
          label="مجموع الخصومات الممنوحة"
          value={formatIqd(summary?.discount ?? "0")}
        />
        {showProfit && (
          <Kpi
            label="صافي الربح من العروض"
            value={formatIqd(summary?.grossProfit ?? "0")}
            note="بعد الكلفة والراجع"
          />
        )}
      </div>

      {/* 2. Order of Application Rule Guide */}
      <Card>
        <CardContent className="p-4 text-sm">
          <div className="font-medium">كيف يطبّق النظام العروض على الفاتورة؟</div>
          <ol className="mt-2 grid gap-1 text-muted-foreground md:grid-cols-2">
            <li>
              <span className="font-medium text-foreground">1.</span> السعر الخاص المتفق عليه مع الزبون يتقدم دائماً ولا يدخل عليه خصم إضافي.
            </li>
            <li>
              <span className="font-medium text-foreground">2.</span> يشتغل العرض تلقائياً إذا كان مفعّلاً وضمن تاريخه ومكانه والحد الأدنى للفاتورة.
            </li>
            <li>
              <span className="font-medium text-foreground">3.</span> العروض التلقائية تنزل مباشرة بالسلة، وعروض الكوبونات تشتغل عند إدخال كود الكوبون.
            </li>
            <li>
              <span className="font-medium text-foreground">4.</span> إذا اجتمع عرضان على نفس المادة: يتقدم الأعلى أولوية، ثم الأوفر للزبون تلقائياً.
            </li>
          </ol>
        </CardContent>
      </Card>

      {/* 3. Operational Alerts Requiring Action */}
      {hasAlerts && (
        <Card className="border-[var(--sem-warn)]/40">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-[var(--sem-warn)]" />
            <div>
              <div className="font-medium">ملاحظات تحتاج متابعة</div>
              <div className="mt-1 text-muted-foreground">
                {showProfit && signals.negative.length > 0 && (
                  <span>{signals.negative.length} عروض تبيع بخسارة (أقل من الكلفة). </span>
                )}
                {signals.unusedActive.length > 0 && (
                  <span>{signals.unusedActive.length} عروض فعّالة لم تُستخدم بأي فاتورة بعد. </span>
                )}
                {signals.expiredActive.length > 0 && (
                  <span>{signals.expiredActive.length} عروض انتهت مدتها وبقيت مفعّلة.</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
