import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  RefreshCcw,
  Wifi,
  WifiOff,
} from "lucide-react";

interface BiometricReadinessBannerProps {
  period: string;
}

export function BiometricReadinessBanner({
  period,
}: BiometricReadinessBannerProps) {
  const readiness = trpc.payroll.biometricReadiness.useQuery(
    { period },
    { enabled: Boolean(period && /^\d{4}-\d{2}$/.test(period)) },
  );

  const utils = trpc.useUtils();
  const processFolds = trpc.hrDevices.processFolds.useMutation({
    onSuccess: async (res) => {
      notify.ok(`تمت معالجة البصمات: ${res.days} يوماً محدثاً`);
      await Promise.all([
        readiness.refetch(),
        utils.payroll.biometricReadiness.invalidate({ period }),
      ]);
    },
    onError: (err) => notify.err(err),
  });

  if (readiness.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-muted p-2.5 text-xs text-muted-foreground animate-pulse">
        <Fingerprint className="size-4 animate-spin" />
        <span>جارٍ التحقق من جاهزية جسر البصمات لشهر {period}…</span>
      </div>
    );
  }

  if (readiness.isError) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
      >
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="size-4 shrink-0" />
          تعذّر فحص جاهزية البصمات؛ لا يمكن افتراض خلو الشهر من بصمات معلقة.
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={() => void readiness.refetch()}
        >
          <RefreshCcw className="size-3" /> إعادة
        </Button>
      </div>
    );
  }

  const data = readiness.data;
  if (!data) return null;

  if (data.ready) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs text-emerald-800 dark:text-emerald-300">
        <span className="flex items-center gap-1.5">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
          حضور الشهر جاهز للمراجعة النهائية عند التوليد (لا توجد بصمات معلقة أو
          مجهولة أو أيام مفتوحة).
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {data.connectedDevicesCount > 0 ? (
            <>
              <Wifi className="size-3 text-emerald-600" />
              {data.connectedDevicesCount}/{data.totalDevicesCount} أجهزة متصلة
            </>
          ) : (
            <>
              <WifiOff className="size-3 text-muted-foreground" />
              {data.totalDevicesCount} أجهزة مسجلة
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-900 dark:text-amber-200"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="size-4 shrink-0 text-amber-600" />
          تنبيه جاهزية البصمات لشهر {period}:
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs border-amber-500/40 text-amber-900 dark:text-amber-200 hover:bg-amber-500/10"
          onClick={() => processFolds.mutate()}
          disabled={processFolds.isPending}
        >
          <RefreshCcw
            className={`size-3 ${processFolds.isPending ? "animate-spin" : ""}`}
          />
          {processFolds.isPending ? "جارٍ المعالجة…" : "مزامنة البصمات الآن"}
        </Button>
      </div>

      <ul className="space-y-1 pr-5 list-disc text-[11px] text-amber-800 dark:text-amber-300">
        {data.pendingPunchesCount > 0 && (
          <li>
            يوجد <b>{data.pendingPunchesCount}</b> بصمة من هذا الشهر بانتظار
            المزامنة إلى سجل الحضور.
          </li>
        )}
        {data.unmappedPunchesCount > 0 && (
          <li>
            يوجد <b>{data.unmappedPunchesCount}</b> بصمة واردة في هذا الشهر
            لمستخدمين غير مربوطين بموظفين.{" "}
            <a className="underline underline-offset-2" href="/hr?tab=devices">
              مراجعة ربط مستخدمي الأجهزة
            </a>
          </li>
        )}
        {data.openDaysCount > 0 && (
          <li>
            يوجد <b>{data.openDaysCount}</b> يوم عمل مفتوح لدى{" "}
            <b>{data.openEmployeesCount}</b> موظف.
          </li>
        )}
      </ul>
      {data.openDays.length > 0 && (
        <div className="space-y-2">
          <ul
            aria-label="الموظفون وأيام الحضور المفتوحة"
            className="max-h-48 space-y-2 overflow-y-auto rounded border border-current/20 p-2"
          >
            {data.openDays.map((day) => (
              <li key={day.attendanceId} className="space-y-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <b>{day.employeeName}</b>
                  <time dateTime={day.date} dir="ltr" className="tabular-nums">
                    {day.date}
                  </time>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span>{day.reason}</span>
                  <a
                    className="underline underline-offset-2"
                    href={`/hr?tab=attendance&employeeId=${day.employeeId}&period=${encodeURIComponent(period)}&range=month`}
                    aria-label={`مراجعة حضور ${day.employeeName} بتاريخ ${day.date}`}
                  >
                    مراجعة الحضور
                  </a>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[11px]">
            صحّح أوقات الانصراف من سجل الحضور، ثم أعد التوليد. يُعاد فحص الشهر
            بعد مزامنة البصمات.
          </p>
        </div>
      )}
    </div>
  );
}
