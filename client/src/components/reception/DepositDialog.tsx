// ش٤ — حوار قبض عربون على طلبٍ محفوظ (م٢: أيّ طريقة، والربح يبقى عند التسليم).
// المرآة الشاشيّة لخدمة reception.collectDeposit: وردية استقبالٍ مُلزَمة («سيدخل درجك أنت»
// للنقد وحده — I15: غير النقد يُسجَّل على الوردية للمحاسبة ولا يدخل الدرج)،
// مرجعٌ لغير النقد، مفتاح idempotency لكل فتح، وسند قبضٍ مطبوعٌ للزبون (ليس إيصال بيع).
import { useState } from "react";
import Decimal from "decimal.js";
import { Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { printDepositReceipt } from "@/lib/printing/draftTicket";

const D = (v: string | number) => new Decimal(v || 0);
const round2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fmt = (n: number | string) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const METHOD_LABEL: Record<"CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM", string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  TELECOM: "رصيد زين",
};

export default function DepositDialog({
  draftId,
  draftNumber,
  contactName,
  orderTotal,
  heldTotal,
  suggestedAmount,
  currentShiftId,
  branchName,
  cashierName,
  onClose,
  onCollected,
}: {
  draftId: number;
  draftNumber: string;
  contactName?: string | null;
  orderTotal: string;
  heldTotal: string;
  suggestedAmount: string;
  currentShiftId: number | null;
  branchName: string;
  cashierName?: string | null;
  onClose: () => void;
  /** النجاح يعيد صافي المقبوض الجديد على الطلب — الشاشة تحدّث «مقبوض سلفاً» فوراً. */
  onCollected: (collectedTotal: string) => void;
}) {
  const [amount, setAmount] = useState(suggestedAmount);
  const [method, setMethod] = useState<"CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM">("CASH");
  const [reference, setReference] = useState("");
  // ش٥: رصيد زين — تأكيدٌ ثانٍ صريح (لا مُثبِت خارجيّ) + هاتف مُرسِلٍ اختياريّ للتحويل المباشر.
  const [telecomConfirmed, setTelecomConfirmed] = useState(false);
  const [senderPhone, setSenderPhone] = useState("");
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const remainingCap = round2(D(orderTotal).minus(D(heldTotal)));

  const collect = trpc.reception.collectDeposit.useMutation({
    onSuccess: (r) => {
      // I15: غير النقد لا يدخل الدرج — الوردية للمحاسبة فقط (مراجعة عدائية ٦/٨).
      const shiftNo = "shiftId" in r && r.shiftId ? r.shiftId : currentShiftId ?? "";
      notify.ok(
        `قُبض عربون ${fmt(amount)} د.ع على ${draftNumber}`,
        `إجمالي المقبوض على الطلب: ${fmt(r.collectedTotal)} د.ع — ${method === "CASH" ? `دخل درج وردية #${shiftNo}` : `سُجِّل على وردية #${shiftNo} (لا يدخل درج النقد)`}`,
      );
      onCollected(String(r.collectedTotal));
      void printDepositReceipt({
        draftNumber,
        date: new Date().toLocaleString("ar-IQ"),
        contactName,
        amount: round2(D(amount)).toFixed(2),
        methodLabel: METHOD_LABEL[method],
        reference: method === "CASH" ? null : reference.trim(),
        collectedTotal: String(r.collectedTotal),
        orderTotal,
        cashierName,
      }).catch(() => notify.warn("تعذّرت طباعة سند القبض", "العملية مسجّلة — أعد الطباعة من سجلّ العرابين"));
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  const needRef = method !== "CASH";
  const amountD = D(amount || 0);
  const exceeds = amountD.gt(remainingCap);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-extrabold">قبض عربون — {draftNumber}</h3>
        <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">قيمة الطلب</span>
          <span className="font-extrabold tabular-nums" dir="ltr">{fmt(orderTotal)} د.ع</span>
        </div>
        {D(heldTotal).gt(0) && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-xs">
            <span className="font-bold text-[var(--sem-warn)]">مقبوض سلفاً</span>
            <span className="font-extrabold tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(heldTotal)} د.ع</span>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-[11px]">مبلغ العربون</Label>
          <MoneyInput value={amount} onChange={setAmount} ariaLabel="مبلغ العربون" className="h-10 text-sm font-bold" />
          {exceeds && (
            <p className="text-[11px] font-bold text-destructive" role="alert">
              يتجاوز المتبقّي من قيمة الطلب ({fmt(remainingCap.toNumber())} د.ع)
            </p>
          )}
        </div>
        <div className="flex gap-1.5">
          {(Object.keys(METHOD_LABEL) as Array<keyof typeof METHOD_LABEL>).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => { setMethod(v); setTelecomConfirmed(false); }}
              className={cn(
                "min-h-[40px] flex-1 rounded-lg border-2 text-xs font-extrabold",
                method === v ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
              )}
            >
              {METHOD_LABEL[v]}
            </button>
          ))}
        </div>
        {needRef && (
          <Input
            value={reference}
            onChange={(e) => { setReference(e.target.value); if (method === "TELECOM") setTelecomConfirmed(false); }}
            placeholder={
              method === "CARD" ? "رقم عملية البطاقة"
              : method === "WALLET" ? "رقم عملية المحفظة"
              : method === "TELECOM" ? "أرقام كارت شحن زين (الكود)"
              : "رقم مرجع التحويل"
            }
            className="h-9 text-xs"
            dir="ltr"
          />
        )}
        {method === "TELECOM" && (
          <>
            <Input
              value={senderPhone}
              onChange={(e) => setSenderPhone(e.target.value)}
              placeholder="هاتف المُرسِل (اختياري — لتحويل الرصيد المباشر)"
              className="h-9 text-xs"
              dir="ltr"
            />
            <label className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--sem-warn)]">
              <input
                type="checkbox"
                checked={telecomConfirmed}
                onChange={(e) => setTelecomConfirmed(e.target.checked)}
                className="mt-0.5 size-3.5"
              />
              <span>تحقّقتُ أن الرصيد وصل فعلاً — الكود يُقبل مرّةً واحدة ولا يدخل درج النقد.</span>
            </label>
          </>
        )}
        {/* I15: «سيدخل درجك» للنقد وحده — لغيره الوردية للمحاسبة ولا يدخل الدرج (لا تناقض مع سطر زين). */}
        <p className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--sem-warn)]">
          <Banknote aria-hidden className="me-1 inline size-3.5" />
          {method === "CASH" ? (
            <>
              سيدخل المبلغ <span className="underline">درجك أنت</span>
              {currentShiftId ? ` — وردية #${currentShiftId}` : " (لا وردية استقبال مفتوحة — سيُرفض)"} · {branchName}
            </>
          ) : (
            <>
              يُسجَّل على ورديتك{currentShiftId ? ` #${currentShiftId}` : " (لا وردية استقبال مفتوحة — سيُرفض)"} للمحاسبة — لا يدخل درج النقد · {branchName}
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
          <Button
            className="flex-1"
            disabled={collect.isPending || amountD.lte(0) || exceeds || (needRef && !reference.trim()) || (method === "TELECOM" && !telecomConfirmed)}
            onClick={() =>
              collect.mutate({
                draftId,
                amount: round2(amountD).toFixed(2),
                method,
                reference: needRef ? reference.trim() : undefined,
                telecomSenderPhone: method === "TELECOM" && senderPhone.trim() ? senderPhone.trim() : undefined,
                clientRequestId,
              })
            }
          >
            {collect.isPending ? "جارٍ القبض…" : "قبض وطباعة سند"}
          </Button>
        </div>
      </div>
    </div>
  );
}
