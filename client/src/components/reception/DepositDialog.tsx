// ش٤ — حوار قبض عربون على طلبٍ محفوظ (م٢: أيّ طريقة، والربح يبقى عند التسليم).
// المرآة الشاشيّة لخدمة reception.collectDeposit: وردية استقبالٍ مُلزَمة («سيدخل درجك أنت»)،
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

const METHOD_LABEL: Record<"CASH" | "CARD" | "TRANSFER" | "WALLET", string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
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
  const [method, setMethod] = useState<"CASH" | "CARD" | "TRANSFER" | "WALLET">("CASH");
  const [reference, setReference] = useState("");
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const remainingCap = round2(D(orderTotal).minus(D(heldTotal)));

  const collect = trpc.reception.collectDeposit.useMutation({
    onSuccess: (r) => {
      notify.ok(
        `قُبض عربون ${fmt(amount)} د.ع على ${draftNumber}`,
        `إجمالي المقبوض على الطلب: ${fmt(r.collectedTotal)} د.ع — دخل درج وردية #${"shiftId" in r && r.shiftId ? r.shiftId : currentShiftId ?? ""}`,
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
              onClick={() => setMethod(v)}
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
            onChange={(e) => setReference(e.target.value)}
            placeholder={method === "CARD" ? "رقم عملية البطاقة" : method === "WALLET" ? "رقم عملية المحفظة" : "رقم مرجع التحويل"}
            className="h-9 text-xs"
            dir="ltr"
          />
        )}
        <p className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--sem-warn)]">
          <Banknote aria-hidden className="me-1 inline size-3.5" />
          سيدخل المبلغ <span className="underline">درجك أنت</span>
          {currentShiftId ? ` — وردية #${currentShiftId}` : " (لا وردية استقبال مفتوحة — سيُرفض)"} · {branchName}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
          <Button
            className="flex-1"
            disabled={collect.isPending || amountD.lte(0) || exceeds || (needRef && !reference.trim())}
            onClick={() =>
              collect.mutate({
                draftId,
                amount: round2(amountD).toFixed(2),
                method,
                reference: needRef ? reference.trim() : undefined,
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
