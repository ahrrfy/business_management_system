import { Link } from "wouter";
import {
  ShieldAlert,
  ShieldCheck,
  ChevronLeft,
  ArrowLeft,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtAr, formatIqd } from "@/lib/money";

export interface RadarAlertItem {
  key: string;
  severity: "critical" | "warning" | "info";
  title: string;
  count: number;
  amount: string | null;
  href: string;
  actionLabel: string;
}

interface OperationalRadarCardProps {
  alerts: RadarAlertItem[];
  loading?: boolean;
  error?: boolean;
  sourceErrors?: string[];
}

export function OperationalRadarCard({
  alerts,
  loading,
  error = false,
  sourceErrors = [],
}: OperationalRadarCardProps) {
  if (loading) return null;

  const isDegraded = error || sourceErrors.includes("anomalyWatch");

  const radarAlerts = alerts.filter(
    (a) => a.key.startsWith("radar-") || a.key === "anomaly-watch",
  );

  if (radarAlerts.length === 0) {
    if (isDegraded) {
      return (
        <Card className="border-border/60 bg-muted/30">
          <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <AlertTriangle className="size-5" aria-hidden />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">تعذّر التحقق الكامل من رادار العمليات</p>
                <p className="text-xs text-muted-foreground">
                  تعذّر مسح بعض مؤشرات الشذوذ مؤقتاً بسبب خطأ في مصدر البيانات. يمكنك فتح رقيب الشذوذ مباشرة للتحقق.
                </p>
              </div>
            </div>
            <Link
              href="/reports/anomaly-watch"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              فتح رقيب الشذوذ
              <ArrowLeft className="size-3" aria-hidden />
            </Link>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card className="border-border/60 bg-card/60">
        <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-money-positive/10 text-money-positive">
              <ShieldCheck className="size-5" aria-hidden />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">رادار العمليات سليم</p>
              <p className="text-xs text-muted-foreground">
                لم يُرصد أي شذوذ في الحسومات، التكاليف التاريخية، المرتجعات، أو تسلسل الترقيم.
              </p>
            </div>
          </div>
          <Link
            href="/reports/anomaly-watch"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            فتح رقيب الشذوذ
            <ArrowLeft className="size-3" aria-hidden />
          </Link>
        </CardContent>
      </Card>
    );
  }

  const criticalCount = radarAlerts.filter((a) => a.severity === "critical").length;

  return (
    <Card className="border-destructive/30 bg-destructive/5 shadow-xs">
      <CardHeader className="p-4 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <ShieldAlert className="size-5" aria-hidden />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-semibold text-foreground">
                  رادار الذكاء التشغيلي ومنع التلاعب
                </CardTitle>
                <span className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                  {fmtAr(radarAlerts.length)} مؤشرات
                </span>
                {criticalCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-destructive/20 px-2 py-0.5 text-[11px] font-medium text-destructive">
                    <AlertTriangle className="size-3" aria-hidden />
                    {fmtAr(criticalCount)} حرج
                  </span>
                )}
                {isDegraded && (
                  <span
                    className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                    title="تعذّر استكمال بعض مصادر الرادار"
                  >
                    فحص جزئي
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                كواشف حتمية رصدت إشارات شذوذ في العمليات النقدية أو البيعية تستوجب تدقيق الإدارة.
              </p>
            </div>
          </div>

          <Link
            href="/reports/anomaly-watch"
            className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-background/80 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10"
          >
            فتح لوحة رقيب الشذوذ الشاملة
            <ArrowLeft className="size-3.5" aria-hidden />
          </Link>
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-2">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {radarAlerts.map((item) => {
            const isCritical = item.severity === "critical";
            return (
              <Link key={item.key} href={item.href}>
                <div
                  className={`group flex h-full cursor-pointer flex-col justify-between rounded-lg border p-3 transition ${
                    isCritical
                      ? "border-destructive/30 bg-background/90 hover:border-destructive hover:bg-background"
                      : "border-[var(--sem-warn)]/30 bg-background/90 hover:border-[var(--sem-warn)] hover:bg-background"
                  }`}
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          isCritical
                            ? "bg-destructive/10 text-destructive"
                            : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                        }`}
                      >
                        {isCritical ? "عالي الأولوية" : "متابعة"}
                      </span>
                      <span className="text-xs text-muted-foreground group-hover:text-foreground">
                        <ChevronLeft className="size-3.5 transition group-hover:-translate-x-0.5" aria-hidden />
                      </span>
                    </div>
                    <p className="text-xs font-medium text-foreground line-clamp-2">
                      {item.title}
                    </p>
                  </div>

                  <div className="mt-2.5 flex items-center justify-between border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
                    <div>
                      الحالات:{" "}
                      <span className="font-semibold text-foreground tabular-nums" dir="ltr">
                        {fmtAr(item.count)}
                      </span>
                    </div>
                    {item.amount && Number(item.amount) > 0 && (
                      <div className="font-semibold text-destructive tabular-nums" dir="ltr">
                        {formatIqd(item.amount)}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
