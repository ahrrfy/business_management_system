// حوارات عمليات المحفظة (ش٩): إيداع/سحب، طلب تعديل، كشف حساب، مطابقة يومية.
// مفصولةٌ عن شاشة المحافظ كي تبقى الأخيرة قائمةً بسيطة.
import { MoneyInput } from "@/components/form/MoneyInput";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useState } from "react";

export type WalletRow = RouterOutputs["digitalCards"]["wallets"]["list"][number];

const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

const TX_TYPE: Record<string, string> = {
  OPENING: "رصيد افتتاحي",
  DEPOSIT: "إيداع",
  WITHDRAWAL: "سحب",
  ADJUSTMENT: "تعديل",
  SALE_CONSUMPTION: "استهلاك بيع",
  SALE_REVERSAL: "عكس بيع",
};
const TX_STATUS: Record<string, string> = {
  ACTIVE: "نافذة",
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

  function done(msg: string) {
    void utils.digitalCards.wallets.list.invalidate();
    void utils.digitalCards.wallets.statement.invalidate();
    void utils.digitalCards.wallets.lowBalance.invalidate();
    setAmount(""); setNotes("");
    notify.ok(msg);
    onClose();
  }
  const dep = trpc.digitalCards.wallets.deposit.useMutation({
    onSuccess: (r) => done(`أُودع المبلغ — الرصيد ${fmtAr(r.balanceAfter)}`),
    onError: (e) => notify.err(e),
  });
  const wdr = trpc.digitalCards.wallets.withdraw.useMutation({
    onSuccess: (r) => done(`سُحب المبلغ — الرصيد ${fmtAr(r.balanceAfter)}`),
    onError: (e) => notify.err(e),
  });

  function submit() {
    if (!wallet) return;
    if (!amount || Number(amount) <= 0) return notify.err("أدخِل مبلغاً أكبر من صفر");
    const payload = {
      walletId: wallet.id, amount, paymentMethod: method,
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
            <select id="wm-method" className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as "CASH" | "TRANSFER")}>
              <option value="CASH">نقداً من الخزينة</option>
              <option value="TRANSFER">تحويل بنكي</option>
            </select>
          </div>
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
            التعديل اليدويّ باب تغطية العجز، فلا يُنفَّذ بفاعلٍ واحد: الطلب هنا، والاعتماد من مديرٍ آخر.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="wa-dir">اتجاه التعديل</label>
            <select id="wa-dir" className={selectCls} value={direction} onChange={(e) => setDirection(e.target.value as "IN" | "OUT")}>
              <option value="OUT">خفض الرصيد (عجز)</option>
              <option value="IN">رفع الرصيد (زيادة)</option>
            </select>
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
            {req.isPending ? "جارٍ الإرسال…" : "إرسال للاعتماد"}
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
            <input id="wr-date" type="date" className={selectCls} value={date} onChange={(e) => setDate(e.target.value)} dir="ltr" />
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

  return (
    <Dialog open={wallet != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>كشف حساب — {wallet?.name}</DialogTitle>
          <DialogDescription>
            كل حركة تحمل الرصيد بعدها؛ الرصيد الحاليّ هو حاصل جمع الحركات النافذة.
          </DialogDescription>
        </DialogHeader>
        <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">النوع</th>
                <th className="p-2 text-start">المبلغ</th>
                <th className="p-2 text-start">الرصيد بعدها</th>
                <th className="p-2 text-start">الحالة</th>
                <th className="p-2 text-start">ملاحظة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{TX_TYPE[r.type] ?? r.type}</td>
                  <td className={`p-2 tabular-nums ${r.direction === "IN" ? "" : "text-muted-foreground"}`}>
                    {r.direction === "IN" ? "+" : "−"}{fmtAr(r.amount)}
                  </td>
                  <td className="p-2 tabular-nums font-medium">
                    {r.status === "PENDING_APPROVAL" ? "—" : fmtAr(r.balanceAfter)}
                  </td>
                  <td className="p-2 text-muted-foreground">{TX_STATUS[r.status] ?? r.status}</td>
                  <td className="p-2 text-muted-foreground">{r.notes || "—"}</td>
                  <td className="p-2 text-center">
                    {r.status === "PENDING_APPROVAL" ? (
                      <div className="flex justify-center gap-2">
                        <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate({ transactionId: r.id })}>
                          اعتماد
                        </Button>
                        <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => reject.mutate({ transactionId: r.id })}>
                          رفض
                        </Button>
                      </div>
                    ) : "—"}
                  </td>
                </tr>
              ))}
              {q.isLoading && <tr><td colSpan={6}><LoadingState /></td></tr>}
              {!q.isLoading && rows.length === 0 && <TableEmptyRow colSpan={6} message="لا حركات بعد." />}
            </tbody>
          </table>
        </ScrollTableShell>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
