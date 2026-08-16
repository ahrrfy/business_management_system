/**
 * إقفال الفترات المالية — adminProcedure.
 * يعرض القفل النشِط ويوفّر آلية الفتح الموثّق (admin فقط).
 * إنشاء القفل الشهري محصورٌ بطلب الإقفال واعتماده من تبويب «الإقفال الشهري».
 */
import {
  AlertTriangle,
  Download,
  FileCheck2,
  Lock,
  LockOpen,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

export default function PeriodLockPage() {
  const utils = trpc.useUtils();
  const status = trpc.periodLock.status.useQuery();
  const history = trpc.periodLock.history.useQuery();
  const certificates = trpc.periodLock.certificates.useQuery({ limit: 50 });
  const [unlockReason, setUnlockReason] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [bootstrapMonth, setBootstrapMonth] = useState("");
  const [bootstrapReason, setBootstrapReason] = useState("");
  const [bootstrapReference, setBootstrapReference] = useState("");
  const [selectedCertificateId, setSelectedCertificateId] = useState<
    number | null
  >(null);
  const certificate = trpc.periodLock.certificate.useQuery(
    { id: selectedCertificateId ?? 1 },
    { enabled: selectedCertificateId != null },
  );
  const verification = trpc.periodLock.verifyCertificate.useQuery(
    { id: selectedCertificateId ?? 1 },
    { enabled: selectedCertificateId != null },
  );

  const bootstrapMut = trpc.periodLock.bootstrapSequence.useMutation({
    onSuccess: () => {
      notify.ok("تم اعتماد نقطة بداية تسلسل الإقفال");
      void utils.periodLock.status.invalidate();
      void utils.periodLock.sequenceEvents.invalidate();
      setBootstrapReason("");
      setBootstrapReference("");
    },
    onError: (e) => notify.err(e),
  });

  const unlockMut = trpc.periodLock.unlock.useMutation({
    onSuccess: () => {
      notify.ok("تم فتح أحدث قفل");
      void utils.periodLock.status.invalidate();
      void utils.periodLock.history.invalidate();
      void utils.periodLock.closeRequests.invalidate();
      void utils.periodLock.closeActionReadiness.invalidate();
      void utils.periodLock.certificates.invalidate();
      void utils.periodLock.sequenceEvents.invalidate();
      setUnlockReason("");
      setUnlockPassword("");
    },
    onError: (e) => notify.err(e),
  });

  const lock = status.data?.lock;
  const sequence = status.data?.sequence;

  return (
    <div className="container mx-auto p-4 space-y-4">
      <PageHeader
        title="إقفال الفترات المالية"
        description="القفل الشهري يُنشأ حصراً بعد طلب الإقفال واعتماده؛ هذه الشاشة للمتابعة والفتح الموثّق."
      />

      {sequence?.status === "NEEDS_BOOTSTRAP" ? (
        <Card>
          <CardHeader className="font-semibold">تهيئة تسلسل الإقفال</CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              هذه خطوة مالك لمرة واحدة. إن وُجد قفل إرثي فسيُقرّ به دون ادعاء
              وجود شهادة تاريخية؛ وإن لم يوجد يبدأ التسلسل من الشهر المحدد.
            </p>
            {!lock ? (
              <div className="grid gap-2">
                <label className="text-sm font-medium">
                  أول شهر مطلوب إقفاله
                </label>
                <input
                  type="month"
                  value={bootstrapMonth}
                  onChange={(event) => setBootstrapMonth(event.target.value)}
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
              </div>
            ) : (
              <p className="rounded border p-2 text-sm">
                سيُعتمد القفل الإرثي #{lock.id} حتى {fmtDate(lock.cutoffDate)}{" "}
                دون إنشاء شهادة رجعية.
              </p>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="text-sm font-medium">سبب التهيئة</label>
                <input
                  value={bootstrapReason}
                  onChange={(event) => setBootstrapReason(event.target.value)}
                  maxLength={500}
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">مرجع القرار</label>
                <input
                  value={bootstrapReference}
                  onChange={(event) =>
                    setBootstrapReference(event.target.value)
                  }
                  maxLength={255}
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
              </div>
            </div>
            <Button
              disabled={
                bootstrapMut.isPending ||
                bootstrapReason.trim().length < 10 ||
                bootstrapReference.trim().length < 3 ||
                (!lock && !bootstrapMonth)
              }
              onClick={() => {
                if (lock) {
                  bootstrapMut.mutate({
                    mode: "ACKNOWLEDGE_LEGACY_LOCK",
                    expectedPeriodId: lock.id,
                    reason: bootstrapReason.trim(),
                    reference: bootstrapReference.trim(),
                  });
                } else {
                  bootstrapMut.mutate({
                    mode: "START_FRESH",
                    firstCloseMonth: bootstrapMonth,
                    reason: bootstrapReason.trim(),
                    reference: bootstrapReference.trim(),
                  });
                }
              }}
            >
              اعتماد نقطة البداية
            </Button>
          </CardContent>
        </Card>
      ) : sequence ? (
        <Card>
          <CardHeader className="font-semibold">
            تسلسل الإقفال الشهري
          </CardHeader>
          <CardContent className="grid gap-2 text-sm md:grid-cols-3">
            <div>
              <span className="text-muted-foreground">البداية: </span>
              {sequence.sequenceStartMonth}
            </div>
            <div>
              <span className="text-muted-foreground">مقفل حتى: </span>
              {sequence.activeThroughMonth ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">الشهر التالي: </span>
              <strong>{sequence.nextRequiredMonth}</strong>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
                <span>
                  أي قيد محاسبي بتاريخ ≤ {fmtDate(lock.cutoffDate)} سيُرفَض.
                </span>
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
                    notify.err(
                      "أدخل سبباً واضحاً وكلمة مرور المدير قبل فتح الفترة",
                    );
                    return;
                  }
                  if (
                    await confirm({
                      title: "فتح القفل",
                      description:
                        "هل أنت متأكد من فتح أحدث قفل؟ هذا يسمح بكتابة قيود تاريخية.",
                      variant: "danger",
                    })
                  ) {
                    unlockMut.mutate({
                      expectedPeriodId: lock.id,
                      reason: unlockReason.trim(),
                      password: unlockPassword,
                    });
                  }
                }}
                disabled={unlockMut.isPending}
              >
                فتح أحدث قفل
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">
              لا قفل نشِط — كل التواريخ مفتوحة للكتابة.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="font-semibold">سجل الإقفال والفتح</CardHeader>
        <CardContent className="p-0">
          {history.isLoading ? (
            <div className="p-4">
              <LoadingState />
            </div>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-right">الحدث</th>
                    <th className="p-2 text-right">تاريخ الإقفال</th>
                    <th className="p-2 text-right">بواسطة</th>
                    <th className="p-2 text-right">الوقت</th>
                    <th className="p-2 text-right">ملاحظات / سبب</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data?.rows.length ?? 0) === 0 ? (
                    <TableEmptyRow
                      colSpan={5}
                      message="لا عمليات قفل أو فتح مسجّلة بعد."
                    />
                  ) : (
                    history.data!.rows.map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="p-2">
                          {r.action === "period.lock" ? (
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <Lock
                                aria-hidden
                                className="size-3.5 text-destructive"
                              />
                              قفل
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <LockOpen
                                aria-hidden
                                className="size-3.5 text-[var(--status-active)]"
                              />
                              فتح
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          {r.cutoffDate ? fmtDate(r.cutoffDate) : "—"}
                        </td>
                        <td className="p-2">{r.userName}</td>
                        <td className="p-2 text-muted-foreground" dir="ltr">
                          {fmtDateTime(r.createdAt)}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {r.action === "period.lock"
                            ? (r.notes ?? "—")
                            : (r.reason ?? "—")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="font-semibold flex-row items-center gap-2">
          <FileCheck2 aria-hidden className="size-4" />
          شهادات الإقفال غير القابلة للتعديل
        </CardHeader>
        <CardContent className="p-0">
          {certificates.isLoading ? (
            <div className="p-4">
              <LoadingState />
            </div>
          ) : (certificates.data?.length ?? 0) === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              لا توجد شهادات بعد. الأقفال الإرثية المقر بها لا تُمنح شهادات
              رجعية.
            </p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-right">الشهادة</th>
                    <th className="p-2 text-right">الشهر</th>
                    <th className="p-2 text-right">النوع</th>
                    <th className="p-2 text-right">الاعتماد</th>
                    <th className="p-2 text-right">الإجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {certificates.data!.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="p-2 font-mono" dir="ltr">
                        {row.certificateNumber}
                      </td>
                      <td className="p-2">
                        {row.month} / {row.revision}
                      </td>
                      <td className="p-2">
                        {row.kind === "YEAR_END" ? "سنوي" : "شهري"}
                      </td>
                      <td className="p-2">{fmtDateTime(row.approvedAt)}</td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedCertificateId(row.id)}
                          >
                            <ShieldCheck aria-hidden className="size-3.5" />
                            تحقق
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              exportRows(
                                async () => {
                                  const exported =
                                    await utils.client.periodLock.exportCertificate.query(
                                      { id: row.id },
                                    );
                                  return exported.rows;
                                },
                                {
                                  filename: row.certificateNumber,
                                  columns: [
                                    { key: "section", header: "البند" },
                                    { key: "value", header: "القيمة" },
                                  ],
                                },
                              )
                            }
                          >
                            <Download aria-hidden className="size-3.5" />
                            Excel
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
          {selectedCertificateId != null ? (
            <div className="border-t p-4 text-sm space-y-2">
              {certificate.isLoading || verification.isLoading ? (
                <LoadingState />
              ) : verification.data && certificate.data ? (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <strong>{certificate.data.row.certificateNumber}</strong>
                    <span
                      className={
                        verification.data.integrity === "VERIFIED"
                          ? "text-[var(--status-active)]"
                          : "text-destructive"
                      }
                    >
                      {verification.data.integrity === "VERIFIED"
                        ? "البصمات سليمة"
                        : "فشل التحقق"}
                    </span>
                    <span>الحالة: {verification.data.lifecycle}</span>
                  </div>
                  <div className="font-mono break-all" dir="ltr">
                    {verification.data.certificateHash}
                  </div>
                  {verification.data.reasons.length > 0 ? (
                    <p className="text-destructive">
                      {verification.data.reasons.join("، ")}
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
