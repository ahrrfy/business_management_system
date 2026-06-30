import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { type ColumnDef } from "@tanstack/react-table";
import { ArrowDownLeft, ArrowUpRight, Send, Check, X, Plus, ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

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

const fmtDT = (d: string | number | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" }) : "—";

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
  sentAt: string;
  receivedBy: number | null;
  receivedAt: string | Date | null;
  notes: string | null;
}

export default function TreasuryTransfers() {
  const [tab, setTab] = useState<Tab>("outgoing");
  const [status, setStatus] = useState<Status>("");
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [receivingId, setReceivingId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const list = trpc.cashTransfers.list.useQuery({
    direction: tab === "all" ? "ALL" : tab === "incoming" ? "INCOMING" : "OUTGOING",
    status: status || undefined,
    limit: 50,
    offset: 0,
  });

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
      { header: "الرقم", accessorKey: "transferNumber" },
      {
        header: "من",
        accessorKey: "fromBranchName",
        cell: ({ row }) => (
          <span className="text-xs">
            <ArrowUpRight className="inline h-3 w-3 ml-1 text-rose-600" />
            {row.original.fromBranchName}
          </span>
        ),
      },
      {
        header: "إلى",
        accessorKey: "toBranchName",
        cell: ({ row }) => (
          <span className="text-xs">
            <ArrowDownLeft className="inline h-3 w-3 ml-1 text-emerald-600" />
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
          <span className={`text-[11px] rounded-full px-2 py-0.5 ${STATUS_CLS[row.original.status]}`}>
            {STATUS_AR[row.original.status]}
          </span>
        ),
      },
      {
        header: "تاريخ الإرسال",
        accessorKey: "sentAt",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground" dir="ltr">
            {fmtDT(row.original.sentAt)}
          </span>
        ),
      },
      {
        header: "تاريخ الاستلام",
        accessorKey: "receivedAt",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground" dir="ltr">
            {row.original.receivedAt ? fmtDT(row.original.receivedAt) : "—"}
          </span>
        ),
      },
      {
        header: "إجراء",
        id: "actions",
        cell: ({ row }) => {
          const r = row.original;
          if (r.status !== "IN_TRANSIT") return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="default"
                className="h-7 gap-1"
                onClick={() => setReceivingId(r.id)}
              >
                <Check className="h-3 w-3" />
                استلام
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1"
                onClick={() => setCancellingId(r.id)}
              >
                <X className="h-3 w-3" />
                إلغاء
              </Button>
            </div>
          );
        },
      },
    ],
    [],
  );

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
            <Button size="sm" onClick={() => setShowSendDialog(true)} className="gap-1.5">
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
            {(["outgoing", "incoming", isAdmin ? "all" : null].filter(Boolean) as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  tab === t
                    ? "px-3 py-1.5 rounded-sm bg-primary text-primary-foreground text-sm"
                    : "px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground text-sm"
                }
              >
                {t === "outgoing" ? "صادر" : t === "incoming" ? "وارد" : "الكلّ"}
              </button>
            ))}
          </div>
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
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
            data={(list.data ?? []) as TransferRow[]}
            columns={cols}
            loading={list.isLoading}
            emptyText={tab === "incoming" ? "لا تحويلات واردة." : tab === "outgoing" ? "لا تحويلات صادرة." : "لا تحويلات."}
            showFilter={false}
            pageSize={20}
          />
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
              سيُكتب إيصال تعويضي يُعيد النقد لخزينة فرع الإرسال. اشرح السبب (لا يَقلّ عن ٣ أحرف):
            </p>
            <Input
              placeholder="سبب الإلغاء…"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="mb-3"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setCancellingId(null); setCancelReason(""); }}>
                تراجع
              </Button>
              <Button
                variant="destructive"
                onClick={() => cancelMut.mutate({ transferId: cancellingId, reason: cancelReason })}
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
  const defaultFrom = userBranchId ?? (branches[0]?.id ?? 0);
  const [fromBranchId, setFromBranchId] = useState<number>(defaultFrom);
  const [toBranchId, setToBranchId] = useState<number>(
    branches.find((b) => b.id !== defaultFrom)?.id ?? 0,
  );
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const clientRequestId = useMemo(() => {
    return "ct-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
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
        const cause = (e.shape?.data as { cause?: { balanceWarning?: { available: string; requested: string } } })?.cause;
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
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir="rtl">
      <Card className="w-full max-w-2xl p-5">
        <h3 className="text-lg font-semibold mb-3">إرسال تحويل نقدي جديد</h3>

        <div className="grid gap-4 sm:grid-cols-2 items-start">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">من فرع</label>
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
            <label className="text-xs text-muted-foreground mb-1 block">إلى فرع</label>
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
            <label className="text-xs text-muted-foreground mb-1 block">المبلغ (د.ع)</label>
            <Input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="tabular-nums"
              dir="ltr"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">ملاحظات (اختياري)</label>
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
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3">
            <div className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">
              تحذير: الرصيد قد يَصبح سالباً
            </div>
            <div className="text-xs text-amber-700 dark:text-amber-400 mb-3">
              المتاح في خزينة الفرع: <span dir="ltr" className="tabular-nums">{fmtAr(pendingConfirm.available)}</span> د.ع
              <br />
              المطلوب: <span dir="ltr" className="tabular-nums">{fmtAr(pendingConfirm.requested)}</span> د.ع
              <br />
              قد يَكون سبب الفرق وجود نقد لم يُسلَّم بعد من ورديات سابقة.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPendingConfirm(null)}>
                إلغاء
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => { setPendingConfirm(null); submit(true); }}
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
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir="rtl">
      <Card className="w-full max-w-sm p-5">
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            تراجع
          </Button>
          <Button variant={variant ?? "default"} onClick={onConfirm} disabled={loading}>
            {loading ? "جارٍ…" : confirmText}
          </Button>
        </div>
      </Card>
    </div>
  );
}
