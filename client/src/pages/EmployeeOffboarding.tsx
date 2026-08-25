// تصفية خروج الموظف — شاشة قراءةٍ فقط تجمع ذمّة الموظّف عبر ستّ وحدات قبل إنهاء خدمته.
//
// عمداً بلا أزرار إجراء: كل بندٍ يوجّه للشاشة المخوَّلة بمعالجته بحوكمتها وSODها. إضافةُ
// «أغلق الوردية من هنا» تخلق باباً ثانياً بلا الحوكمة نفسها — وهذا ما تتجنّبه الشاشة.
import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ExternalLink, ShieldAlert, UserMinus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmt } from "@/lib/money";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { cn } from "@/lib/utils";

export default function EmployeeOffboarding() {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const list = trpc.employees.list.useQuery({ limit: 500 } as never, { staleTime: 60_000 });
  const clearance = trpc.employees.clearance.useQuery(
    { employeeId: employeeId ?? 0 },
    { enabled: employeeId != null && employeeId > 0 },
  );

  const rows = (list.data as { rows?: Array<{ id: number; firstName: string; lastName: string }> } | undefined)?.rows ?? [];

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="تصفية خروج الموظف"
        description="كل ما يربط الموظّف بالنظام قبل إنهاء خدمته — وردية، عهدة، سلفة، عمولة، توصيل، جلسات."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">اختر الموظّف</CardTitle>
        </CardHeader>
        <CardContent className="max-w-md space-y-1">
          <Label className="text-xs">الموظّف</Label>
          <AppSelect
            value={employeeId == null ? "" : String(employeeId)}
            onValueChange={(v) => setEmployeeId(v ? Number(v) : null)}
            className="h-10"
          >
            <option value="">— اختر —</option>
            {rows.map((e) => (
              <option key={e.id} value={e.id}>{`${e.firstName} ${e.lastName}`.trim()}</option>
            ))}
          </AppSelect>
        </CardContent>
      </Card>

      {clearance.isLoading && employeeId != null && <LoadingState />}
      {clearance.error && <ErrorState message={clearance.error.message} />}

      {clearance.data && (
        <>
          <Card
            className={cn(
              "border-2",
              clearance.data.clearedToExit
                ? "border-[var(--sem-pos)]/50 bg-[var(--sem-pos-bg)]"
                : "border-destructive/50 bg-destructive/5",
            )}
          >
            <CardContent className="flex items-start gap-3 p-4">
              {clearance.data.clearedToExit ? (
                <CheckCircle2 aria-hidden className="mt-0.5 size-6 shrink-0 text-[var(--sem-pos)]" />
              ) : (
                <ShieldAlert aria-hidden className="mt-0.5 size-6 shrink-0 text-destructive" />
              )}
              <div className="space-y-1">
                <div className="text-base font-extrabold">
                  {clearance.data.employeeName}
                  {!clearance.data.isActive && (
                    <span className="mr-2 rounded-md bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">
                      معطَّل
                    </span>
                  )}
                </div>
                <div className="text-sm font-bold">
                  {clearance.data.clearedToExit
                    ? "لا يوجد ما يمنع إنهاء الخدمة."
                    : `${clearance.data.blockingCount} بند يمنع إنهاء الخدمة — عالِجها أولاً.`}
                </div>
                {clearance.data.userId == null && (
                  <div className="text-xs text-muted-foreground">
                    هذا الموظّف بلا حساب دخول — بنود الوردية والجلسات والتوصيل والعمولة لا تنطبق عليه.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {clearance.data.items.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                لا ذمّة مفتوحة على هذا الموظّف في أيٍّ من الوحدات الستّ.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {clearance.data.items.map((item) => {
                const blocking = item.severity === "BLOCKING";
                return (
                  <Card
                    key={item.key}
                    className={cn("border-r-4", blocking ? "border-r-destructive" : "border-r-[var(--sem-warn)]")}
                  >
                    <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                      <CardTitle className="flex items-center gap-2 text-sm font-extrabold">
                        <AlertTriangle
                          aria-hidden
                          className={cn("size-4", blocking ? "text-destructive" : "text-[var(--sem-warn)]")}
                        />
                        {item.label}
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums">{item.count}</span>
                      </CardTitle>
                      <span
                        className={cn(
                          "shrink-0 rounded-md px-2 py-0.5 text-[10px] font-extrabold",
                          blocking ? "bg-destructive/15 text-destructive" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
                        )}
                      >
                        {blocking ? "يمنع الخروج" : "تنبيه"}
                      </span>
                    </CardHeader>
                    <CardContent className="space-y-2 pt-0">
                      {item.amount != null && (
                        <div className="text-lg font-extrabold tabular-nums" dir="ltr">
                          {fmt(item.amount)} <span className="text-xs font-normal text-muted-foreground">د.ع</span>
                        </div>
                      )}
                      <ul className="space-y-0.5 text-xs text-muted-foreground">
                        {item.details.map((d) => (
                          <li key={d}>• {d}</li>
                        ))}
                      </ul>
                      <p className="text-xs font-semibold">{item.resolveHint}</p>
                      <Link
                        href={item.resolvePath}
                        className="inline-flex items-center gap-1 text-xs font-extrabold text-primary hover:underline"
                      >
                        <ExternalLink aria-hidden className="size-3" /> اذهب للمعالجة
                      </Link>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <UserMinus aria-hidden className="size-3.5" />
            هذه الشاشة تشخّص ولا تُنفّذ — كل بند يُعالَج من شاشته المخوَّلة بحوكمتها.
          </p>
        </>
      )}
    </div>
  );
}
