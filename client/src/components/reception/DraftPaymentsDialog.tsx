// ش٤ — سجلّ عرابين الطلب المحفوظ: القبض/التطبيق/الردّ + تنفيذ الردّ من هنا.
// الردّ بطريقة القبض حتماً (يفرضها الخادم — I17؛ استثناء ش٥: رصيد زين يُردّ نقداً من
// الدرج لأنّ الرصيد المشحون لا يُعاد) وبسقف المتبقّي من كل قبض؛ السبب إلزاميّ
// (يوثَّق على الإيصال وسجلّ التدقيق). المطبَّق على فاتورة لا يُردّ من هنا — مساره مرتجعها.
import { useState } from "react";
import Decimal from "decimal.js";
import { Banknote, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";

const D = (v: string | number) => new Decimal(v || 0);
const fmt = (n: number | string) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const KIND_AR: Record<string, string> = {
  COLLECTION: "قبض عربون",
  APPLICATION: "طُبِّق على مستند",
  REFUND: "ردّ",
};
const METHOD_AR: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل", WALLET: "محفظة", TELECOM: "رصيد زين",
};
const STATUS_AR: Record<string, string> = {
  HELD: "محتجز", APPLIED: "مُطبَّق", REFUNDED: "مردود كاملاً",
};

export default function DraftPaymentsDialog({
  draftId,
  draftNumber,
  branchId,
  onClose,
  onChanged,
}: {
  draftId: number;
  draftNumber: string;
  branchId: number;
  onClose: () => void;
  /** بعد ردٍّ ناجح — يمرّر صافي المحتجز الجديد لتحديث الشاشة الأم. */
  onChanged: (heldNet: string) => void;
}) {
  const q = trpc.reception.paymentsOf.useQuery({ draftId }, { staleTime: 0 });
  const [refundFor, setRefundFor] = useState<number | null>(null);
  const [refundMethodFor, setRefundMethodFor] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  // مراجعة ش٤: الردّ النقديّ مع أكثر من درجٍ مفتوح بالفرع يتطلّب تحديد أيّ درجٍ يخرج منه
  // النقد فعلاً (نمط شاشة المرتجعات حرفياً) — بلا المنتقي كان الردّ ميتاً طوال ساعات العمل.
  // ش٥: عربون رصيد زين يُردّ **نقداً من الدرج** (الخادم يفرضه — لا سكّة ردٍّ لرصيدٍ شُحن) ⇒
  // منتقي الدرج يشمله كما يشمل النقد.
  const cashRefundOpen = refundFor != null && (refundMethodFor === "CASH" || refundMethodFor === "TELECOM");
  const openShiftsQ = trpc.treasury.getOpenShifts.useQuery({ branchId }, { enabled: cashRefundOpen });
  const drawerShifts = openShiftsQ.data ?? [];
  const needShiftPick = cashRefundOpen && drawerShifts.length > 1;

  const refundM = trpc.reception.refundDeposit.useMutation({
    onSuccess: async () => {
      notify.ok("رُدَّ المبلغ", "والسند مسجَّل — رصيد زين يُردّ نقداً من الدرج، وغيره بطريقة قبضه");
      setRefundFor(null);
      setRefundMethodFor(null);
      setAmount("");
      setReason("");
      setRefundShiftId(null);
      setClientRequestId(crypto.randomUUID());
      const fresh = await q.refetch();
      onChanged(String(fresh.data?.heldNet ?? "0.00"));
    },
    onError: (e) => notify.err(e),
  });

  const rows = q.data?.rows ?? [];
  const refundedOf = new Map<number, Decimal>();
  for (const r of rows) {
    if (r.kind === "REFUND" && r.parentPaymentId != null) {
      const k = Number(r.parentPaymentId);
      refundedOf.set(k, (refundedOf.get(k) ?? D(0)).plus(D(String(r.amount))));
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="inline-flex items-center gap-1.5 text-sm font-extrabold">
          <Banknote aria-hidden className="size-4" /> عرابين الطلب — {draftNumber}
        </h3>
        {q.isLoading ? (
          <div className="py-6 text-center text-xs text-muted-foreground">جارٍ التحميل…</div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">لا عرابين على هذا الطلب بعد.</div>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {rows.map((r) => {
              const isColl = r.kind === "COLLECTION";
              const remaining = isColl
                ? D(String(r.amount)).minus(refundedOf.get(Number(r.id)) ?? D(0))
                : D(0);
              const canRefund = isColl && r.status === "HELD" && remaining.gt(0);
              return (
                <div key={String(r.id)} className={cn("rounded-lg border px-2.5 py-1.5 text-xs", r.kind === "REFUND" && "opacity-75")}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold">
                      {KIND_AR[r.kind] ?? r.kind}
                      {r.method ? ` · ${METHOD_AR[String(r.method)] ?? r.method}` : ""}
                      {isColl && r.status ? ` · ${STATUS_AR[String(r.status)] ?? r.status}` : ""}
                    </span>
                    <span className="font-extrabold tabular-nums" dir="ltr">{fmt(String(r.amount))} د.ع</span>
                  </div>
                  {isColl && refundedOf.has(Number(r.id)) && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      مردودٌ منه: {fmt(refundedOf.get(Number(r.id))!.toNumber())} د.ع — المتبقّي {fmt(remaining.toNumber())} د.ع
                    </div>
                  )}
                  {canRefund && refundFor !== Number(r.id) && (
                    <Button
                      size="sm" variant="outline" className="mt-1 h-7 px-2 text-[10px]"
                      onClick={() => {
                        setRefundFor(Number(r.id));
                        setRefundMethodFor(String(r.method ?? "CASH"));
                        setAmount(remaining.toFixed(2));
                        setReason("");
                        setRefundShiftId(null);
                        // مفتاح idempotency جديد لكل فتح نموذج ردّ — ردّان متتاليان لقبضين
                        // مختلفين بنفس المفتاح كانا يعيدان نتيجة الأول (replay) صامتاً.
                        setClientRequestId(crypto.randomUUID());
                      }}
                    >
                      <RotateCcw aria-hidden className="size-3 me-1" /> ردّ من هذا القبض
                    </Button>
                  )}
                  {refundFor === Number(r.id) && (
                    <div className="mt-1.5 space-y-1.5 rounded-md border bg-muted/30 p-2">
                      <MoneyInput value={amount} onChange={setAmount} ariaLabel="مبلغ الردّ" className="h-8 text-xs font-bold" />
                      <Input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="سبب الردّ (إلزامي — يُوثَّق على السند)"
                        className="h-8 text-xs"
                      />
                      {needShiftPick && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-muted-foreground">أكثر من درجٍ مفتوح — من أيّ درجٍ يخرج النقد؟</div>
                          <select
                            aria-label="درج الردّ النقدي"
                            className="h-8 w-full rounded-md border bg-card px-2 text-[11px] font-bold"
                            value={refundShiftId != null ? String(refundShiftId) : ""}
                            onChange={(e) => setRefundShiftId(e.target.value ? Number(e.target.value) : null)}
                          >
                            <option value="">اختر الدرج…</option>
                            {drawerShifts.map((s) => (
                              <option key={s.shiftId} value={String(s.shiftId)}>
                                {s.userName} — وردية #{s.shiftId}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="ghost" className="h-7 flex-1 text-[10px]" onClick={() => { setRefundFor(null); setRefundMethodFor(null); }}>إلغاء</Button>
                        <Button
                          size="sm" className="h-7 flex-1 text-[10px]"
                          disabled={refundM.isPending || D(amount || 0).lte(0) || D(amount || 0).gt(remaining) || reason.trim().length < 5 || (needShiftPick && refundShiftId == null)}
                          onClick={() =>
                            refundM.mutate({
                              paymentId: Number(r.id),
                              amount: D(amount).toFixed(2),
                              reason: reason.trim(),
                              refundShiftId: refundShiftId ?? undefined,
                              clientRequestId,
                            })
                          }
                        >
                          {refundM.isPending
                            ? "جارٍ الردّ…"
                            : String(r.method) === "TELECOM"
                              ? "ردّ نقداً (أصله رصيد زين)"
                              : `ردّ ${METHOD_AR[String(r.method)] ?? ""}`}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between border-t pt-2 text-xs">
          <span className="font-bold text-muted-foreground">صافي المحتجز</span>
          <span className="font-extrabold tabular-nums" dir="ltr">{fmt(String(q.data?.heldNet ?? "0"))} د.ع</span>
        </div>
        <Button variant="outline" className="w-full" onClick={onClose}>إغلاق</Button>
      </div>
    </div>
  );
}
