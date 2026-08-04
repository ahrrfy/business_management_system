/**
 * إقفال الفترات المالية — adminProcedure.
 * يعرض الـlock النشِط ويوفّر آلية إنشاء/فتح (admin فقط).
 */
import { AlertTriangle, Lock, LockOpen } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

export default function PeriodLockPage() {
  const utils = trpc.useUtils();
  const status = trpc.periodLock.status.useQuery();
  const history = trpc.periodLock.history.useQuery();
  const [cutoffDate, setCutoffDate] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [unlockReason, setUnlockReason] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");

  const lockMut = trpc.periodLock.lock.useMutation({
    onSuccess: () => {
      notify.ok("تم قفل الفترة بنجاح");
      utils.periodLock.status.invalidate();
      utils.periodLock.history.invalidate();
      setCutoffDate("");
      setNotes("");
    },
    onError: (e) => notify.err(e),
  });

  const unlockMut = trpc.periodLock.unlock.useMutation({
    onSuccess: () => {
      notify.ok("تم فتح أحدث قفل");
      utils.periodLock.status.invalidate();
      utils.periodLock.history.invalidate();
      setUnlockReason("");
      setUnlockPassword("");
    },
    onError: (e) => notify.err(e),
  });

  const lock = status.data?.lock;

  return (
    <div className="container mx-auto p-4 space-y-4">
      <PageHeader title="إقفال الفترات المالية" />

      <div className="grid gap-4 lg:grid-cols-2 items-start">
      <Card>
        <CardHeader className="font-semibold">القفل النشِط</CardHeader>
        <CardContent>
          {status.isLoading ? (
            <LoadingState />
          ) : lock ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-muted-foreground">تاريخ الإقفال:</div>
                <div className="font-medium">{fmtDate(lock.cutoffDate)}</div>
                <div className="text-muted-foreground">تاريخ التطبيق:</div>
                <div>{fmtDate(lock.lockedAt)}</div>
                <div className="text-muted-foreground">ملاحظات:</div>
                <div>{lock.notes ?? "—"}</div>
              </div>
              <p className="text-sm badge-stock-low rounded p-2 flex items-center gap-2">
                <AlertTriangle aria-hidden className="size-4" />
                <span>أي قيد محاسبي بتاريخ ≤ {fmtDate(lock.cutoffDate)} سيُرفَض.</span>
              </p>
              <div className="grid gap-2">
                <label className="text-sm font-medium">سبب فتح الفترة</label>
                <input
                  value={unlockReason}
                  onChange={(e) => setUnlockReason(e.target.value)}
                  maxLength={500}
                  placeholder="اذكر سبب التصحيح والمستند أو التذكرة المرتبطة"
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
                <label className="text-sm font-medium">كلمة مرور المدير</label>
                <input
                  type="password"
                  value={unlockPassword}
                  onChange={(e) => setUnlockPassword(e.target.value)}
                  autoComplete="current-password"
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
              </div>
              <Button
                variant="destructive"
                onClick={async () => {
                  if (unlockReason.trim().length < 10 || !unlockPassword) {
                    notify.err("أدخل سبباً واضحاً وكلمة مرور المدير قبل فتح الفترة");
                    return;
                  }
                  if (await confirm({ title: "فتح القفل", description: "هل أنت متأكد من فتح أحدث قفل؟ هذا يسمح بكتابة قيود تاريخية.", variant: "danger" })) {
                    unlockMut.mutate({ reason: unlockReason.trim(), password: unlockPassword });
                  }
                }}
                disabled={unlockMut.isPending}
              >
                فتح أحدث قفل
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">لا قفل نشِط — كل التواريخ مفتوحة للكتابة.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="font-semibold">إنشاء قفل جديد</CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-2">
            <label className="text-sm font-medium">تاريخ الإقفال</label>
            <input
              type="date"
              value={cutoffDate}
              onChange={(e) => setCutoffDate(e.target.value)}
              className="h-9 px-3 rounded-md border bg-transparent text-sm"
            />
            <p className="text-xs text-muted-foreground">القيود بتاريخ ≤ هذا التاريخ ستُرفَض.</p>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">ملاحظات (اختياري)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={255}
              placeholder="مثل: إقفال شهر يناير ٢٠٢٦"
              className="h-9 px-3 rounded-md border bg-transparent text-sm"
            />
          </div>
          </div>
          <Button
            onClick={async () => {
              if (!cutoffDate) {
                notify.err("اختر تاريخ الإقفال");
                return;
              }
              if (
                !(await confirm({
                  variant: "danger",
                  title: "تطبيق قفل الفترة",
                  description: `سيُمنع التعديل لكل تاريخ ≤ ${fmtDate(cutoffDate)}. متابعة؟`,
                  confirmText: "إقفال",
                }))
              )
                return;
              lockMut.mutate({ cutoffDate, notes: notes.trim() || undefined });
            }}
            disabled={lockMut.isPending}
          >
            تطبيق القفل
          </Button>
        </CardContent>
      </Card>
      </div>

      <Card>
        <CardHeader className="font-semibold">سجل الإقفال والفتح</CardHeader>
        <CardContent className="p-0">
          {history.isLoading ? (
            <div className="p-4"><LoadingState /></div>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-right">الإجراء</th>
                    <th className="p-2 text-right">تاريخ الإقفال</th>
                    <th className="p-2 text-right">بواسطة</th>
                    <th className="p-2 text-right">الوقت</th>
                    <th className="p-2 text-right">ملاحظات / سبب</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data?.rows.length ?? 0) === 0 ? (
                    <TableEmptyRow colSpan={5} message="لا عمليات قفل أو فتح مسجّلة بعد." />
                  ) : (
                    history.data!.rows.map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="p-2">
                          {r.action === "period.lock" ? (
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <Lock aria-hidden className="size-3.5 text-destructive" />
                              قفل
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <LockOpen aria-hidden className="size-3.5 text-[var(--status-active)]" />
                              فتح
                            </span>
                          )}
                        </td>
                        <td className="p-2">{r.cutoffDate ? fmtDate(r.cutoffDate) : "—"}</td>
                        <td className="p-2">{r.userName}</td>
                        <td className="p-2 text-muted-foreground" dir="ltr">{fmtDateTime(r.createdAt)}</td>
                        <td className="p-2 text-muted-foreground">{r.action === "period.lock" ? (r.notes ?? "—") : (r.reason ?? "—")}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
