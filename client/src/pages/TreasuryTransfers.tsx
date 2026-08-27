import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { DataTable } from "@/components/data-table/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { trpc } from "@/lib/trpc";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  Check,
  X,
  Plus,
  ArrowRight,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { RowActions } from "@/components/list";

type Tab = "outgoing" | "incoming" | "all";
type Status = "" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";

const STATUS_AR: Record<string, string> = {
  IN_TRANSIT: "في الطريق",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

const STATUS_CLS: Record<string, string> = {
  IN_TRANSIT: "badge-stock-low",
  RECEIVED: "badge-status-active",
  CANCELLED: "badge-stock-out",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const fmtDT = (d: string | number | Date | null | undefined) => fmtDateTime(d);

interface TransferRow {
  id: number;
  transferNumber: string;
  fromBranchId: number;
  fromBranchName: string;
  toBranchId: number;
  toBranchName: string;
  amount: string;
  status: "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  sentBy: number;
  sentByName: string | null;
  sentAt: string;
  receivedBy: number | null;
  receivedByName: string | null;
  receivedAt: string | Date | null;
  cancelledBy: number | null;
  cancelledByName: string | null;
  cancelledAt: string | Date | null;
  sentReceiptId: number | null;
  receivedReceiptId: number | null;
  reversalReceiptId: number | null;
  notes: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
  integrityWarnings: string[];
}

const TRANSFER_WARNING_LABEL: Record<string, string> = {
  SENT_RECEIPT_MISSING: "إيصال الإرسال مفقود",
  SENDER_MISSING: "المرسل غير موثق",
  RECEIVED_RECEIPT_MISSING: "إيصال الاستلام مفقود",
  RECEIVER_MISSING: "المستلم أو وقت الاستلام غير موثق",
  REVERSAL_RECEIPT_MISSING: "إيصال عكس الإلغاء مفقود",
  CANCELLER_MISSING: "منفذ الإلغاء غير موثق",
  CANCELLATION_REASON_MISSING: "سبب الإلغاء غير موثق",
};

const PAGE = 50;

export default function TreasuryTransfers() {
  const [tab, setTab] = useState<Tab>("outgoing");
  const [status, setStatus] = useState<Status>("");
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [receivingId, setReceivingId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [exporting, setExporting] = useState(false);
  // ترقيم فعلي — كان offset مثبَّتاً على صفر صامتاً (٥٠ الأحدث فقط بلا تصفّح لما قبلها).
  // limit+1 يكشف hasMore دون تعديل عقد الراوتر (يعيد مصفوفة صرفة كما هو).
  const [page, setPage] = useState(0);

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const list = trpc.cashTransfers.list.useQuery({
    direction:
      tab === "all" ? "ALL" : tab === "incoming" ? "INCOMING" : "OUTGOING",
    status: status || undefined,
    limit: PAGE + 1,
    offset: page * PAGE,
  });
  const rows = ((list.data ?? []) as TransferRow[]).slice(0, PAGE);
  const hasMore = (list.data?.length ?? 0) > PAGE;
  useEffect(() => {
    setPage(0);
  }, [tab, status]);

  const cancelMut = trpc.cashTransfers.cancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغي التحويل");
      setCancellingId(null);
      setCancelReason("");
      void utils.cashTransfers.list.invalidate();
      void utils.treasury.getDashboard.invalidate();
    },
    onError: (e) => notify.err(e.message),
  });
  const receiveMut = trpc.cashTransfers.receive.useMutation({
    onSuccess: () => {
      notify.ok("استُلم التحويل");
      setReceivingId(null);
      void utils.cashTransfers.list.invalidate();
      void utils.treasury.getDashboard.invalidate();
    },
    onError: (e) => notify.err(e.message),
  });

  const userRole = me.data?.role ?? "";
  const isAdmin = userRole === "admin";

  const cols: ColumnDef<TransferRow>[] = useMemo(
    () => [
      {
        header: "التحويل / الإيصالات",
        accessorKey: "transferNumber",
        cell: ({ row }) => (
          <div className="min-w-44 space-y-0.5 text-[11px]" dir="ltr">
            <div className="font-mono font-semibold">
              {row.original.transferNumber}
            </div>
            <div className="flex flex-wrap gap-x-2 text-muted-foreground">
              <span>إرسال R#{row.original.sentReceiptId ?? "—"}</span>
              {row.original.receivedReceiptId && (
                <span>استلام R#{row.original.receivedReceiptId}</span>
              )}
              {row.original.reversalReceiptId && (
                <span>عكس R#{row.original.reversalReceiptId}</span>
              )}
            </div>
          </div>
        ),
      },
      {
        header: "من",
        accessorKey: "fromBranchName",
        cell: ({ row }) => (
          <span className="text-xs">
            <ArrowUpRight className="inline h-3 w-3 ml-1 text-[var(--sem-neg)]" />
            {row.original.fromBranchName}
          </span>
        ),
      },
      {
        header: "إلى",
        accessorKey: "toBranchName",
        cell: ({ row }) => (
          <span className="text-xs">
            <ArrowDownLeft className="inline h-3 w-3 ml-1 text-[var(--sem-pos)]" />
            {row.original.toBranchName}
          </span>
        ),
      },
      {
        header: "المبلغ",
        accessorKey: "amount",
        cell: ({ row }) => (
          <span className="tabular-nums font-medium" dir="ltr">
            {fmtAr(row.original.amount)}
          </span>
        ),
      },
      {
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => (
          <span
            className={`text-[11px] rounded-full px-2 py-0.5 ${STATUS_CLS[row.original.status]}`}
          >
            {STATUS_AR[row.original.status]}
          </span>
        ),
      },
      {
        header: "الإرسال / الاستلام",
        accessorKey: "sentAt",
        cell: ({ row }) => (
          <div className="min-w-48 space-y-1 text-xs">
            <div>
              أرسل:{" "}
              <span className="font-medium">
                {row.original.sentByName ?? `#${row.original.sentBy}`}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground" dir="ltr">
              {fmtDT(row.original.sentAt)}
            </div>
            <div>
              استلم:{" "}
              {row.original.receivedByName ??
                (row.original.receivedBy ? `#${row.original.receivedBy}` : "—")}
            </div>
            {row.original.receivedAt && (
              <div className="text-[11px] text-muted-foreground" dir="ltr">
                {fmtDT(row.original.receivedAt)}
              </div>
            )}
          </div>
        ),
      },
      {
        header: "البيان / الإلغاء",
        accessorKey: "notes",
        cell: ({ row }) => (
          <div className="max-w-64 space-y-1 text-xs">
            <p
              className={
                row.original.notes ? "line-clamp-2" : "text-muted-foreground"
              }
            >
              {row.original.notes || "لا توجد ملاحظات"}
            </p>
            {row.original.status === "CANCELLED" && (
              <>
                <p
                  className={
                    row.original.cancellationReason
                      ? ""
                      : "font-medium text-destructive"
                  }
                >
                  السبب: {row.original.cancellationReason || "غير موثق"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  ألغى:{" "}
                  {row.original.cancelledByName ??
                    (row.original.cancelledBy
                      ? `#${row.original.cancelledBy}`
                      : "—")}
                </p>
                {row.original.cancelledAt && (
                  <p className="text-[11px] text-muted-foreground" dir="ltr">
                    {fmtDT(row.original.cancelledAt)}
                  </p>
                )}
              </>
            )}
          </div>
        ),
      },
      {
        header: "التدقيق",
        accessorKey: "integrityWarnings",
        cell: ({ row }) => (
          <div className="flex max-w-52 flex-wrap gap-1">
            {row.original.integrityWarnings.length ? (
              row.original.integrityWarnings.map((warning) => (
                <span
                  key={warning}
                  className="rounded-full badge-status-cancelled px-2 py-0.5 text-[10px]"
                >
                  {TRANSFER_WARNING_LABEL[warning] ?? warning}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">سليم</span>
            )}
          </div>
        ),
      },
      {
        header: "إجراء",
        id: "actions",
        cell: ({ row }) => {
          const r = row.original;
          if (r.status !== "IN_TRANSIT")
            return <span className="text-muted-foreground">—</span>;
          return (
            <RowActions
              mode="inline"
              actions={[
                {
                  key: "receive",
                  kind: "approve",
                  label: "استلام",
                  icon: Check,
                  onSelect: () => setReceivingId(r.id),
                  gate: {
                    roles: ["manager", "accountant"],
                    module: "treasury",
                    level: "FULL",
                  },
                },
                {
                  key: "cancel",
                  kind: "reverse",
                  label: "إلغاء",
                  icon: X,
                  variant: "destructive",
                  onSelect: () => setCancellingId(r.id),
                  gate: {
                    roles: ["manager", "accountant"],
                    module: "treasury",
                    level: "FULL",
                  },
                },
              ]}
            />
          );
        },
      },
    ],
    [],
  );

  async function exportTransfers() {
    setExporting(true);
    try {
      const allRows = await fetchAllPaged<TransferRow>(
        (offset, limit) =>
          utils.cashTransfers.list
            .fetch({
              direction:
                tab === "all"
                  ? "ALL"
                  : tab === "incoming"
                    ? "INCOMING"
                    : "OUTGOING",
              status: status || undefined,
              limit,
              offset,
            })
            .then((result) => ({ rows: result as TransferRow[] })),
        { pageSize: 200 },
      );
      exportRows(allRows, {
        filename: "التحويلات-النقدية",
        columns: [
          { key: "transferNumber", header: "رقم التحويل" },
          { key: "fromBranchName", header: "من فرع" },
          { key: "toBranchName", header: "إلى فرع" },
          { key: "amount", header: "المبلغ", map: (row) => Number(row.amount) },
          {
            key: "status",
            header: "الحالة",
            map: (row) => STATUS_AR[row.status] ?? row.status,
          },
          {
            key: "sentReceiptId",
            header: "إيصال الإرسال",
            map: (row) => row.sentReceiptId ?? "",
          },
          {
            key: "receivedReceiptId",
            header: "إيصال الاستلام",
            map: (row) => row.receivedReceiptId ?? "",
          },
          {
            key: "reversalReceiptId",
            header: "إيصال العكس",
            map: (row) => row.reversalReceiptId ?? "",
          },
          {
            key: "sentByName",
            header: "أرسل",
            map: (row) => row.sentByName ?? `#${row.sentBy}`,
          },
          {
            key: "sentAt",
            header: "وقت الإرسال",
            map: (row) => fmtDT(row.sentAt),
          },
          {
            key: "receivedByName",
            header: "استلم",
            map: (row) =>
              row.receivedByName ??
              (row.receivedBy ? `#${row.receivedBy}` : ""),
          },
          {
            key: "receivedAt",
            header: "وقت الاستلام",
            map: (row) => (row.receivedAt ? fmtDT(row.receivedAt) : ""),
          },
          {
            key: "cancelledByName",
            header: "ألغى",
            map: (row) =>
              row.cancelledByName ??
              (row.cancelledBy ? `#${row.cancelledBy}` : ""),
          },
          {
            key: "cancelledAt",
            header: "وقت الإلغاء",
            map: (row) => (row.cancelledAt ? fmtDT(row.cancelledAt) : ""),
          },
          {
            key: "cancellationReason",
            header: "سبب الإلغاء",
            map: (row) => row.cancellationReason ?? "",
          },
          { key: "notes", header: "الملاحظات", map: (row) => row.notes ?? "" },
          {
            key: "integrityWarnings",
            header: "ملاحظات التدقيق",
            map: (row) =>
              row.integrityWarnings
                .map((warning) => TRANSFER_WARNING_LABEL[warning] ?? warning)
                .join("؛ "),
          },
        ],
      });
    } catch (error) {
      notify.err(error);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4" dir="rtl">
      {/* Header */}
      <PageHeader
        icon={<Send className="h-5 w-5 text-primary" />}
        title="تحويلات نقدية بين الفروع"
        description="نقل نقد من خزينة فرع إلى خزينة فرع آخر بتدفّق ثنائي ذرّي."
        actions={
          <>
            <Link href="/treasury">
              <Button size="sm" variant="ghost" className="gap-1">
                <ArrowRight className="h-3 w-3" />
                عودة للوحة الخزينة
              </Button>
            </Link>
            <Button
              size="sm"
              variant="outline"
              disabled={exporting || rows.length === 0}
              onClick={() => void exportTransfers()}
            >
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
            <Button
              size="sm"
              onClick={() => setShowSendDialog(true)}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              إرسال تحويل جديد
            </Button>
          </>
        }
      />

      {/* Tabs + filter */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md border bg-background p-0.5">
            {(
              ["outgoing", "incoming", isAdmin ? "all" : null].filter(
                Boolean,
              ) as Tab[]
            ).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  tab === t
                    ? "px-3 py-1.5 rounded-sm bg-primary text-primary-foreground text-sm"
                    : "px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground text-sm"
                }
              >
                {t === "outgoing"
                  ? "صادر"
                  : t === "incoming"
                    ? "وارد"
                    : "الكلّ"}
              </button>
            ))}
          </div>
          <select
            className={selectCls}
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
          >
            <option value="">كل الحالات</option>
            <option value="IN_TRANSIT">في الطريق</option>
            <option value="RECEIVED">مُستلَم</option>
            <option value="CANCELLED">ملغى</option>
          </select>
        </div>
      </Card>

      {/* Table */}
      <Card className="p-4">
        <div className="overflow-x-auto">
          <DataTable
            data={rows}
            columns={cols}
            loading={list.isLoading}
            emptyText={
              tab === "incoming"
                ? "لا تحويلات واردة."
                : tab === "outgoing"
                  ? "لا تحويلات صادرة."
                  : "لا تحويلات."
            }
            searchable={false}
            pageSize={PAGE}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span dir="ltr">
            {rows.length === 0
              ? "لا صفوف"
              : `${page * PAGE + 1}–${page * PAGE + rows.length}`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              السابق
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              التالي
            </Button>
          </div>
        </div>
      </Card>

      {/* Send Dialog */}
      {showSendDialog && (
        <SendDialog
          branches={branches.data ?? []}
          userRole={userRole}
          userBranchId={me.data?.branchId ?? null}
          onClose={() => setShowSendDialog(false)}
          onSuccess={() => {
            setShowSendDialog(false);
            void utils.cashTransfers.list.invalidate();
            void utils.treasury.getDashboard.invalidate();
          }}
        />
      )}

      {/* Receive confirm */}
      {receivingId !== null && (
        <ConfirmDialog
          title="تأكيد استلام التحويل"
          message="هل تَستلم النقد فعلياً وتُؤكّد إتمام التحويل؟ ستُضاف القيمة لخزينة فرعك."
          onCancel={() => setReceivingId(null)}
          onConfirm={() => receiveMut.mutate({ transferId: receivingId })}
          loading={receiveMut.isPending}
          confirmText="تأكيد الاستلام"
          variant="default"
        />
      )}

      {/* Cancel dialog */}
      {cancellingId !== null && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md p-5">
            <h3 className="text-lg font-semibold mb-2">إلغاء التحويل</h3>
            <p className="text-sm text-muted-foreground mb-3">
              سيُكتب إيصال تعويضي يُعيد النقد لخزينة فرع الإرسال. اشرح السبب (لا
              يَقلّ عن ٣ أحرف):
            </p>
            <Input
              placeholder="سبب الإلغاء…"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="mb-3"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setCancellingId(null);
                  setCancelReason("");
                }}
              >
                تراجع
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  cancelMut.mutate({
                    transferId: cancellingId,
                    reason: cancelReason,
                  })
                }
                disabled={cancelReason.trim().length < 3 || cancelMut.isPending}
              >
                {cancelMut.isPending ? "جارٍ…" : "تأكيد الإلغاء"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ─── Send dialog ─── */
function SendDialog({
  branches,
  userRole,
  userBranchId,
  onClose,
  onSuccess,
}: {
  branches: Array<{ id: number; name: string }>;
  userRole: string;
  userBranchId: number | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isAdmin = userRole === "admin";
  const defaultFrom = userBranchId ?? branches[0]?.id ?? 0;
  const [fromBranchId, setFromBranchId] = useState<number>(defaultFrom);
  const [toBranchId, setToBranchId] = useState<number>(
    branches.find((b) => b.id !== defaultFrom)?.id ?? 0,
  );
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const clientRequestId = useMemo(() => {
    return (
      "ct-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
    );
  }, []);
  const [pendingConfirm, setPendingConfirm] = useState<{
    available: string;
    requested: string;
  } | null>(null);

  const mut = trpc.cashTransfers.send.useMutation({
    onSuccess: () => {
      notify.ok("أُرسل التحويل");
      onSuccess();
    },
    onError: (e) => {
      if (e.data?.code === "PRECONDITION_FAILED") {
        const cause = (
          e.shape?.data as {
            cause?: {
              balanceWarning?: { available: string; requested: string };
            };
          }
        )?.cause;
        const warn = cause?.balanceWarning;
        if (warn) {
          setPendingConfirm(warn);
          return;
        }
      }
      notify.err(e.message);
    },
  });

  const submit = (confirmNegative = false) => {
    if (fromBranchId === toBranchId) {
      notify.err("اختر فرعَين مختلفَين");
      return;
    }
    if (!amount || !/^\d+(\.\d{1,2})?$/.test(amount)) {
      notify.err("أدخل مبلغاً صحيحاً");
      return;
    }
    mut.mutate({
      fromBranchId,
      toBranchId,
      amount,
      notes: notes || undefined,
      clientRequestId,
      confirmNegative,
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      dir="rtl"
    >
      <Card className="w-full max-w-2xl p-5">
        <h3 className="text-lg font-semibold mb-3">إرسال تحويل نقدي جديد</h3>

        <div className="grid gap-4 sm:grid-cols-2 items-start">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              من فرع
            </label>
            <select
              className={`${selectCls} w-full`}
              value={fromBranchId}
              onChange={(e) => setFromBranchId(Number(e.target.value))}
              disabled={!isAdmin}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {!isAdmin && (
              <div className="text-[11px] text-muted-foreground mt-1">
                يُسمح للمدير بالإرسال من فرعه فقط
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              إلى فرع
            </label>
            <select
              className={`${selectCls} w-full`}
              value={toBranchId}
              onChange={(e) => setToBranchId(Number(e.target.value))}
            >
              <option value={0}>—</option>
              {branches
                .filter((b) => b.id !== fromBranchId)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              المبلغ (د.ع)
            </label>
            <MoneyInput
              value={amount}
              onChange={setAmount}
              placeholder="0.00"
              className="tabular-nums"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              ملاحظات (اختياري)
            </label>
            <Input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="مثال: إيداع لتسديد رواتب…"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>
            تراجع
          </Button>
          <Button onClick={() => submit(false)} disabled={mut.isPending}>
            {mut.isPending ? "جارٍ…" : "إرسال"}
          </Button>
        </div>

        {pendingConfirm && (
          <div className="mt-4 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
            <div className="text-sm font-semibold text-[var(--sem-warn)] mb-1">
              تحذير: الرصيد قد يَصبح سالباً
            </div>
            <div className="text-xs text-[var(--sem-warn)] mb-3">
              المتاح في خزينة الفرع:{" "}
              <span dir="ltr" className="tabular-nums">
                {fmtAr(pendingConfirm.available)}
              </span>{" "}
              د.ع
              <br />
              المطلوب:{" "}
              <span dir="ltr" className="tabular-nums">
                {fmtAr(pendingConfirm.requested)}
              </span>{" "}
              د.ع
              <br />
              قد يَكون سبب الفرق وجود نقد لم يُسلَّم بعد من ورديات سابقة.
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingConfirm(null)}
              >
                إلغاء
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  setPendingConfirm(null);
                  submit(true);
                }}
                disabled={mut.isPending}
              >
                متابعة على أيّ حال
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ─── Generic confirm dialog ─── */
function ConfirmDialog({
  title,
  message,
  onCancel,
  onConfirm,
  loading,
  confirmText,
  variant,
}: {
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  loading?: boolean;
  confirmText: string;
  variant?: "default" | "destructive";
}) {
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      dir="rtl"
    >
      <Card className="w-full max-w-sm p-5">
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            تراجع
          </Button>
          <Button
            variant={variant ?? "default"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "جارٍ…" : confirmText}
          </Button>
        </div>
      </Card>
    </div>
  );
}
