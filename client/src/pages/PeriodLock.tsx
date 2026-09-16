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
import { LoadingState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { RowActions } from "@/components/list/RowActions";
import { useState } from "react";

/** صفوفٌ مشتقّة من عقد الخادم فلا تنجرف عنه. */
type LockHistoryRow = RouterOutputs["periodLock"]["history"]["rows"][number];
type LockCertificateRow = RouterOutputs["periodLock"]["certificates"][number];

/** جداول هذه الشاشة مُضمَّنة في بطاقاتٍ تحمل عناوينها ⇒ بلا شريط حالةٍ ولا منتقي أعمدة. */
const PANEL_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

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

  async function exportCertificate(certificateId: number, certificateNumber: string) {
    await exportRows(
      async () => {
        const exported = await utils.client.periodLock.exportCertificate.query({ id: certificateId });
        return exported.rows;
      },
      {
        filename: certificateNumber,
        columns: [
          { key: "section", header: "البند" },
          { key: "value", header: "القيمة" },
        ],
      },
    );
  }

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
          <DataTable<LockHistoryRow>
            {...PANEL_TABLE}
            data={history.data?.rows ?? []}
            loading={history.isLoading}
            errorState={{ isError: history.isError, message: history.error?.message, onRetry: () => void history.refetch() }}
            emptyText="لا عمليات قفل أو فتح مسجّلة بعد."
            columns={[
              {
                id: "action",
                header: "الحدث",
                // التسمية المعروضة لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
                accessorFn: (r) => (r.action === "period.lock" ? "قفل" : "فتح"),
                cell: ({ row }) =>
                  row.original.action === "period.lock" ? (
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Lock aria-hidden className="size-3.5 text-destructive" />
                      قفل
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <LockOpen aria-hidden className="size-3.5 text-[var(--status-active)]" />
                      فتح
                    </span>
                  ),
              },
              {
                id: "cutoffDate",
                header: "تاريخ الإقفال",
                accessorFn: (r) => (r.cutoffDate ? fmtDate(r.cutoffDate) : "—"),
                meta: { kind: "date" },
                cell: ({ row }) => (row.original.cutoffDate ? fmtDate(row.original.cutoffDate) : "—"),
              },
              {
                id: "userName",
                header: "بواسطة",
                accessorFn: (r) => r.userName,
                meta: { width: "actor" },
                cell: ({ row }) => row.original.userName,
              },
              {
                id: "createdAt",
                header: "الوقت",
                accessorFn: (r) => fmtDateTime(r.createdAt),
                // kind: "datetime" يتكفّل بعزل اتّجاه الأرقام ⇒ لا dir="ltr" يدويّ.
                meta: { kind: "datetime" },
                cell: ({ row }) => <span className="text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span>,
              },
              {
                id: "notes",
                header: "ملاحظات / سبب",
                accessorFn: (r) => (r.action === "period.lock" ? (r.notes ?? "—") : (r.reason ?? "—")),
                meta: { width: "wide", wrap: true },
                cell: ({ row }) => (
                  <span className="text-muted-foreground">
                    {row.original.action === "period.lock" ? (row.original.notes ?? "—") : (row.original.reason ?? "—")}
                  </span>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="font-semibold flex-row items-center gap-2">
          <FileCheck2 aria-hidden className="size-4" />
          شهادات الإقفال غير القابلة للتعديل
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<LockCertificateRow>
            {...PANEL_TABLE}
            data={certificates.data ?? []}
            loading={certificates.isLoading}
            errorState={{ isError: certificates.isError, message: certificates.error?.message, onRetry: () => void certificates.refetch() }}
            emptyText="لا توجد شهادات بعد. الأقفال الإرثية المقر بها لا تُمنح شهادات رجعية."
            columns={[
              {
                id: "certificateNumber",
                header: "الشهادة",
                accessorFn: (r) => r.certificateNumber,
                // kind: "code" يتكفّل بالخطّ الأحاديّ وعزل الاتّجاه ⇒ لا dir="ltr" يدويّ.
                meta: { kind: "code" },
                cell: ({ row }) => row.original.certificateNumber,
              },
              {
                id: "month",
                header: "الشهر",
                accessorFn: (r) => `${r.month} / ${r.revision}`,
                cell: ({ row }) => `${row.original.month} / ${row.original.revision}`,
              },
              {
                id: "kind",
                header: "النوع",
                accessorFn: (r) => (r.kind === "YEAR_END" ? "سنوي" : "شهري"),
                meta: { kind: "status" },
                cell: ({ row }) => (row.original.kind === "YEAR_END" ? "سنوي" : "شهري"),
              },
              {
                id: "approvedAt",
                header: "الاعتماد",
                accessorFn: (r) => fmtDateTime(r.approvedAt),
                meta: { kind: "datetime" },
                cell: ({ row }) => fmtDateTime(row.original.approvedAt),
              },
              {
                id: "actions",
                header: "الإجراءات",
                enableSorting: false,
                meta: { kind: "actions" },
                cell: ({ row }) => (
                  <RowActions
                    mode="inline"
                    actions={[
                      {
                        key: "verify",
                        kind: "view",
                        label: "تحقق",
                        icon: ShieldCheck,
                        gate: { module: "reports", level: "READ" },
                        onSelect: () => setSelectedCertificateId(row.original.id),
                      },
                      {
                        key: "export",
                        kind: "export",
                        label: "Excel",
                        icon: Download,
                        gate: { module: "reports", level: "READ" },
                        onSelect: () => void exportCertificate(row.original.id, row.original.certificateNumber),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
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
