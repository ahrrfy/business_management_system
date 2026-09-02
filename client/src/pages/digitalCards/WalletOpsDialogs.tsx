// حوارات عمليات المحفظة (ش٩): إيداع/سحب، طلب تعديل، كشف حساب، مطابقة يومية.
// مفصولةٌ عن شاشة المحافظ كي تبقى الأخيرة قائمةً بسيطة.
import { MoneyInput } from "@/components/form/MoneyInput";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { RowActions } from "@/components/list/RowActions";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmtDateTime, toDate, type DateInput } from "@/lib/date";
import { D, fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { inboundPaymentRejectionMessage, isInboundPaymentMethodEnabled } from "@shared/inboundPaymentPolicy";
import { useEffect, useMemo, useState } from "react";

export type WalletRow = RouterOutputs["digitalCards"]["wallets"]["list"][number];
/** صفُّ كشف حساب المحفظة — مشتقٌّ من عقد `digitalCards.wallets.statement`. */
type WalletTxRow = RouterOutputs["digitalCards"]["wallets"]["statement"][number];

/** مبلغ الحركة موقَّعاً باتّجاهها — أساسُ فرزٍ رقميّ صادق بدل نصّ «+1,234». */
const signedAmount = (r: WalletTxRow) => (r.direction === "IN" ? D(r.amount) : D(r.amount).neg());
/** الطلب المعلّق بلا رصيدٍ بعده — يُرتَّب أدنى الجميع بدل أن يُقرأ صفراً. */
const balanceOrder = (r: WalletTxRow) => (r.status === "PENDING_APPROVAL" ? D(-Infinity) : D(r.balanceAfter ?? 0));
const cmpTime = (a: DateInput, b: DateInput) => {
  const ta = toDate(a)?.getTime() ?? -Infinity;
  const tb = toDate(b)?.getTime() ?? -Infinity;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
};

const TX_TYPE: Record<string, string> = {
  OPENING: "رصيد افتتاحي",
  DEPOSIT: "إيداع",
  WITHDRAWAL: "سحب",
  ADJUSTMENT: "تعديل",
  SALE_CONSUMPTION: "استهلاك بيع",
  SALE_REVERSAL: "عكس بيع",
  WRITEOFF: "كرت صدر دون إكمال البيع",
};
const TX_STATUS: Record<string, string> = {
  ACTIVE: "معتمدة",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  REVERSED: "مرفوضة",
};

/** إيداع أو سحب — كلاهما يُنشئ سنداً في الخزينة وقيد حركة أصل. */
export function WalletMoveDialog({
  wallet, mode, onClose,
}: { wallet: WalletRow | null; mode: "deposit" | "withdraw"; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "TRANSFER">("CASH");
  const [notes, setNotes] = useState("");
  const [reference, setReference] = useState("");

  useEffect(() => {
    if (mode === "withdraw") setMethod("CASH");
  }, [mode, wallet?.id]);

  function done(msg: string) {
    void utils.digitalCards.wallets.list.invalidate();
    void utils.digitalCards.wallets.statement.invalidate();
    void utils.digitalCards.wallets.lowBalance.invalidate();
    setAmount(""); setNotes("");
    notify.ok(msg);
    onClose();
  }
  const dep = trpc.digitalCards.wallets.deposit.useMutation({
    onSuccess: (r) => done(
      r.pendingApproval
        ? "رُفع طلب إيداع نقدي بلا أثر على الخزينة أو رصيد المحفظة — ينفّذه مالكٌ آخر من سندات الصرف"
        : `أُودع المبلغ — الرصيد ${fmtAr(r.balanceAfter)}`,
    ),
    onError: (e) => notify.err(e),
  });
  const wdr = trpc.digitalCards.wallets.withdraw.useMutation({
    onSuccess: (r) => done(`سُحب المبلغ — الرصيد ${fmtAr(r.balanceAfter)}`),
    onError: (e) => notify.err(e),
  });

  function submit() {
    if (!wallet) return;
    if (!amount || Number(amount) <= 0) return notify.err("أدخِل مبلغاً أكبر من صفر");
    if (!isInboundPaymentMethodEnabled(method)) return notify.err(inboundPaymentRejectionMessage(method));
    // التحويل بلا مرجعٍ من كشف البنك = حركة خزينة بلا أثرٍ قابلٍ للمطابقة.
    if (method !== "CASH" && !reference.trim()) return notify.err("مرجع الحوالة مطلوب للتحويل البنكي.");
    const payload = {
      walletId: wallet.id, amount, paymentMethod: method,
      ...(method === "CASH" ? {} : { referenceNumber: reference.trim() }),
      clientRequestId: crypto.randomUUID(), notes: notes.trim() || null,
    };
    if (mode === "deposit") dep.mutate(payload); else wdr.mutate(payload);
  }

  const busy = dep.isPending || wdr.isPending;
  const isDep = mode === "deposit";

  return (
    <Dialog open={wallet != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDep ? "إيداع رصيد" : "سحب رصيد"} — {wallet?.name}</DialogTitle>
          <DialogDescription>
            {isDep
              ? "النقد يخرج من الخزينة إلى جهاز المزوّد. حركة أصل لا مشتريات — لا تدخل الإيراد ولا المصروف."
              : "الرصيد يعود من جهاز المزوّد إلى الخزينة. لا يمكن السحب تحت الرصيد المحجوز لعمليات بيع جارية."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-muted p-3 text-sm">
            الرصيد الحالي: <span className="font-bold tabular-nums">{fmtAr(wallet?.currentBalance ?? "0")}</span>
            {" · "}المحجوز: <span className="tabular-nums">{fmtAr(wallet?.reservedBalance ?? "0")}</span>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">المبلغ</label>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel="المبلغ" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="wm-method">وسيلة الحركة</label>
            <AppSelect id="wm-method" value={method} onValueChange={(next) => { setMethod(next as "CASH" | "TRANSFER"); setReference(""); }}>
              <option value="CASH">{isDep ? "نقداً من الخزينة" : "نقداً إلى الخزينة"}</option>
              <option value="TRANSFER">تحويل بنكي</option>
            </AppSelect>
          </div>
          {method !== "CASH" && (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="wm-reference">مرجع الحوالة <span className="text-destructive">*</span></label>
              <Input
                id="wm-reference"
                dir="ltr"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={100}
                placeholder="رقم الحوالة كما في كشف البنك"
              />
              <p className="text-[11px] text-muted-foreground">يُحفَظ على السند ليُطابَق بكشف البنك.</p>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium">ملاحظات (اختياري)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="رقم الحوالة، اسم المستلم…" dir="auto" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إلغاء</Button>
          <Button size="sm" onClick={submit} disabled={busy}>{busy ? "جارٍ التنفيذ…" : isDep ? "إيداع" : "سحب"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** طلب تعديل رصيد — لا يمسّ الرصيد؛ يعتمده مديرٌ آخر. */
export function WalletAdjustDialog({ wallet, onClose }: { wallet: WalletRow | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [reason, setReason] = useState("");

  const req = trpc.digitalCards.wallets.requestAdjustment.useMutation({
    onSuccess: () => {
      void utils.digitalCards.wallets.statement.invalidate();
      setAmount(""); setReason("");
      notify.ok("سُجّل طلب التعديل", "لن يتغيّر الرصيد قبل اعتماد مديرٍ آخر.");
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <Dialog open={wallet != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>طلب تعديل رصيد — {wallet?.name}</DialogTitle>
          <DialogDescription>
            هذا الطلب لا يغيّر الرصيد. ينفّذه مدير آخر بعد المراجعة؛ مالك النظام يستطيع اعتماد طلبه بصفته المرجع النهائي.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="wa-dir">اتجاه التعديل</label>
            <AppSelect id="wa-dir" value={direction} onValueChange={(next) => setDirection(next as "IN" | "OUT")}>
              <option value="OUT">خفض الرصيد (عجز)</option>
              <option value="IN">رفع الرصيد (زيادة)</option>
            </AppSelect>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">المبلغ</label>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel="مبلغ التعديل" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">السبب (إلزامي)</label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="فرق مطابقة، خطأ إدخال…" dir="auto" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إلغاء</Button>
          <Button
            size="sm"
            disabled={req.isPending}
            onClick={() => {
              if (!wallet) return;
              if (!amount || Number(amount) <= 0) return notify.err("أدخِل مبلغاً أكبر من صفر");
              if (reason.trim().length < 3) return notify.err("اكتب سبباً واضحاً للتعديل");
              req.mutate({ walletId: wallet.id, amount, direction, reason: reason.trim(), clientRequestId: crypto.randomUUID() });
            }}
          >
            {req.isPending ? ACTION_LABELS.sending : "إرسال للاعتماد"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** المطابقة اليومية: تسجّل الفعليّ وتحسب الفرق — ولا تعدّل الرصيد. */
export function WalletReconcileDialog({ wallet, onClose }: { wallet: WalletRow | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [actual, setActual] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  const rec = trpc.digitalCards.wallets.reconcile.useMutation({
    onSuccess: (r) => {
      void utils.digitalCards.wallets.reconciliations.invalidate();
      setActual(""); setNotes("");
      if (r.status === "MATCHED") notify.ok("مطابقة تامّة — لا فرق");
      else notify.warn(`فرقٌ مفتوح ${fmtAr(r.variance)}`, "الرصيد لم يُعدَّل. عالِج الفرق بطلب تعديل يعتمده مديرٌ آخر.");
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <Dialog open={wallet != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>مطابقة يومية — {wallet?.name}</DialogTitle>
          <DialogDescription>
            أدخِل الرصيد الظاهر فعلاً على جهاز المزوّد. المطابقة تُسجّل الفرق فقط ولا تُعدّل رصيد النظام.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-muted p-3 text-sm">
            رصيد النظام المتوقَّع: <span className="font-bold tabular-nums">{fmtAr(wallet?.currentBalance ?? "0")}</span>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="wr-date">تاريخ يوم العمل</label>
            <Input id="wr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} dir="ltr" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">الرصيد الفعليّ على الجهاز</label>
            <MoneyInput value={actual} onChange={setActual} ariaLabel="الرصيد الفعليّ" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">ملاحظات (اختياري)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} dir="auto" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إلغاء</Button>
          <Button
            size="sm"
            disabled={rec.isPending}
            onClick={() => {
              if (!wallet) return;
              if (actual === "") return notify.err("أدخِل الرصيد الفعليّ");
              rec.mutate({ walletId: wallet.id, businessDate: date, actualBalance: actual, notes: notes.trim() || null });
            }}
          >
            {rec.isPending ? "جارٍ التسجيل…" : "تسجيل المطابقة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** كشف حساب المحفظة + اعتماد/رفض طلبات التعديل المعلّقة. */
export function WalletStatementDialog({ wallet, onClose }: { wallet: WalletRow | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const q = trpc.digitalCards.wallets.statement.useQuery(
    { walletId: wallet?.id ?? 0 },
    { enabled: wallet != null },
  );

  function refresh() {
    void utils.digitalCards.wallets.statement.invalidate();
    void utils.digitalCards.wallets.list.invalidate();
  }
  const approve = trpc.digitalCards.wallets.approveAdjustment.useMutation({
    onSuccess: (r) => { refresh(); notify.ok(`اعتُمد التعديل — الرصيد ${fmtAr(r.balanceAfter)}`); },
    onError: (e) => notify.err(e),
  });
  const reject = trpc.digitalCards.wallets.rejectAdjustment.useMutation({
    onSuccess: () => { refresh(); notify.ok("رُفض التعديل — لم يتغيّر الرصيد"); },
    onError: (e) => notify.err(e),
  });

  const rows = q.data ?? [];

  // أعمدة كشف الحساب — داخل المكوّن لأنّ عمود الإجراء يستدعي الطفرات وحالة المستخدم الحالي.
  const statementColumns = useMemo<ColumnDef<WalletTxRow, unknown>[]>(() => [
    { id: "type", header: "النوع", accessorFn: (r) => TX_TYPE[r.type] ?? r.type, cell: ({ row }) => TX_TYPE[row.original.type] ?? row.original.type },
    {
      id: "amount",
      header: "المبلغ",
      // نصُّ العرض للنسخ، والفرز على القيمة الخامّ موقَّعةً بالاتّجاه: الفرز النصّيّ يقرأ
      // «+1,234» أصغر من «+999» ويخلط الوارد بالصادر.
      accessorFn: (r) => `${r.direction === "IN" ? "+" : "−"}${fmtAr(r.amount)}`,
      meta: { kind: "money" },
      sortingFn: (a, b) => signedAmount(a.original).cmp(signedAmount(b.original)),
      cell: ({ row }) => (
        <span className={row.original.direction === "IN" ? undefined : "text-muted-foreground"}>
          {row.original.direction === "IN" ? "+" : "−"}{fmtAr(row.original.amount)}
        </span>
      ),
    },
    {
      id: "balanceAfter",
      header: "الرصيد بعدها",
      // الطلب المعلّق لم ينفذ بعد ⇒ لا رصيد بعده (شرطة لا صفر يُقرأ رصيداً).
      accessorFn: (r) => (r.status === "PENDING_APPROVAL" ? "—" : fmtAr(r.balanceAfter)),
      meta: { kind: "money" },
      sortingFn: (a, b) => balanceOrder(a.original).cmp(balanceOrder(b.original)),
      cell: ({ row }) => <span className="font-medium">{row.original.status === "PENDING_APPROVAL" ? "—" : fmtAr(row.original.balanceAfter)}</span>,
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (r) => TX_STATUS[r.status] ?? r.status,
      meta: { kind: "status" },
      cell: ({ row }) => <span className="text-muted-foreground">{TX_STATUS[row.original.status] ?? row.original.status}</span>,
    },
    {
      id: "createdBy",
      header: "من قام بها",
      accessorFn: (r) => r.createdByName || `حساب #${r.createdBy}`,
      meta: { kind: "actor", wrap: true },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="text-start">
            <p className="font-medium">{r.createdByName || `حساب #${r.createdBy}`}</p>
            {r.createdByUsername && <p className="text-xs text-muted-foreground" dir="ltr">@{r.createdByUsername}</p>}
            {r.approvedBy && (
              <p className="mt-1 text-xs text-muted-foreground">
                اعتمدها {r.approvedByName || `حساب #${r.approvedBy}`}
                {r.approvedByUsername ? <span dir="ltr"> {`@${r.approvedByUsername}`}</span> : null}
              </p>
            )}
          </div>
        );
      },
    },
    // التاريخ يُعرض «21/06/2026، 14:30» — والفرز النصّيّ عليه يفرز باليوم لا بالزمن، وكشف
    // الحساب ترتيبُه الزمنيّ هو معناه؛ فالفرز على الطابع الخامّ.
    { id: "createdAt", header: "التاريخ والوقت", accessorFn: (r) => fmtDateTime(r.createdAt), meta: { kind: "datetime" }, sortingFn: (a, b) => cmpTime(a.original.createdAt, b.original.createdAt), cell: ({ row }) => <span className="text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span> },
    { id: "notes", header: "ملاحظة", accessorFn: (r) => r.notes || "—", meta: { wrap: true, width: "wide" }, cell: ({ row }) => <span className="text-muted-foreground">{row.original.notes || "—"}</span> },
    {
      id: "actions",
      header: "إجراء",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const r = row.original;
        if (r.status !== "PENDING_APPROVAL") return "—";
        const selfRequest = !me.data?.isOwner && Number(r.createdBy) === Number(me.data?.id);
        return (
          <RowActions
            mode="inline"
            actions={[
              {
                key: "approve",
                kind: "approve",
                label: "اعتماد",
                gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                disabled: approve.isPending || selfRequest,
                disabledReason: selfRequest ? "طلبك يحتاج مديراً آخر؛ مالك النظام وحده مستثنى" : "جارٍ اعتماد الحركة",
                onSelect: () => approve.mutate({ transactionId: r.id }),
              },
              {
                key: "reject",
                kind: "reverse",
                label: "رفض",
                variant: "destructive",
                gate: { roles: ["manager"], module: "digital_cards", level: "FULL" },
                disabled: reject.isPending,
                disabledReason: "جارٍ رفض الحركة",
                onSelect: () => reject.mutate({ transactionId: r.id }),
              },
            ]}
          />
        );
      },
    },
  ], [approve, reject, me.data?.isOwner, me.data?.id]);

  return (
    <Dialog open={wallet != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>كشف حساب — {wallet?.name}</DialogTitle>
          <DialogDescription>
            كل حركة تحمل الرصيد بعدها؛ الرصيد الحاليّ هو حاصل جمع الحركات النافذة.
          </DialogDescription>
        </DialogHeader>
        {/*
          * مُضمَّن داخل حوار: العنوان في رأس الحوار، والحوار نفسه يمرّر عمودياً
          * (`max-h-[85vh] overflow-y-auto`) ⇒ `bounded={false}` بلا حاويتَي تمرير متداخلتين،
          * و`pageSize={Infinity}` لأنّ `embedded` يكتم شريط الترقيم (ترقيمٌ بلا أزرار يُخفي حركات).
          */}
        <DataTable<WalletTxRow>
          embedded
          searchable={false}
          bounded={false}
          pageSize={Infinity}
          columns={statementColumns}
          data={rows}
          loading={q.isLoading}
          errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => q.refetch() }}
          emptyText="لا حركات بعد."
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
