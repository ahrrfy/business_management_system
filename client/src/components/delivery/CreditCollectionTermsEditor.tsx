import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreditCollectionChoice } from "./CreditCollectionChoice";

interface CreditConsignment {
  id: number;
  partyId: number;
  status: string;
  parcelStatus: string;
  collectedAmount: string;
  counterSettledAmount?: string | null;
  returnDeclaredAt?: unknown;
  courierDeliveredAt?: unknown;
  remittanceId?: number | null;
  feeSettledAt?: unknown;
  deliveryFee: string;
  feeCollection: string;
  invoicePaymentMode?: string | null;
  invoiceRemainingAmount?: string | null;
  collectCreditOnDelivery?: boolean;
  codClaimVersion?: number;
  fulfillmentRequestId?: number | null;
}

/** A changed instruction requires a reason and the claim version that the employee reviewed. */
export function CreditCollectionTermsEditor({ consignment, canEdit, collectionStarted = false, grouped = false }: {
  consignment: CreditConsignment;
  canEdit: boolean;
  collectionStarted?: boolean;
  grouped?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<boolean>();
  const [reason, setReason] = useState("");
  const request = useRef({ fingerprint: "", key: crypto.randomUUID() });
  const utils = trpc.useUtils();
  const update = trpc.delivery.reassignConsignment.useMutation({
    onSuccess: async () => {
      setEditing(false);
      notify.ok("تم تحديث تعليمات التحصيل؛ يلزم إقرار المندوب بالمطالبة الجديدة");
      await Promise.all([utils.delivery.invalidate(), utils.sales.invalidate()]);
    },
    onError: (error) => notify.err(error),
  });
  useEffect(() => {
    setEditing(false); setChoice(undefined); setReason("");
    request.current = { fingerprint: "", key: crypto.randomUUID() };
  }, [consignment.id, consignment.codClaimVersion]);
  const hasCredit = consignment.invoicePaymentMode === "CREDIT" && D(consignment.invoiceRemainingAmount).gt(0);
  if (canEdit && hasCredit && (grouped || consignment.fulfillmentRequestId != null)) return <p className="text-xs leading-6 text-muted-foreground">تعديل تحصيل الآجل بعد الإسناد متاح للإرسالية المفردة فقط. تُحدد تعليمات طلب التجهيز أو الشحنة المجمعة عند إرسالها.</p>;
  const eligible = canEdit && hasCredit
    && consignment.status === "DISPATCHED" && ["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY", "FAILED"].includes(consignment.parcelStatus)
    && consignment.returnDeclaredAt == null && consignment.courierDeliveredAt == null && consignment.remittanceId == null
    && D(consignment.collectedAmount).isZero() && D(consignment.counterSettledAmount).isZero()
    && !collectionStarted && (consignment.codClaimVersion ?? 0) > 0;
  if (!eligible) return null;
  if (!editing) return <Button variant="outline" size="sm" onClick={() => { setChoice(undefined); setReason(""); setEditing(true); }}>تعديل تحصيل الرصيد الآجل</Button>;
  const invalid = choice == null || choice === consignment.collectCreditOnDelivery || reason.trim().length < 3 || update.isPending;
  const submit = () => {
    if (invalid) return;
    const terms = {
      partyId: consignment.partyId,
      consignmentId: consignment.id,
      collectCreditOnDelivery: choice,
      expectedClaimVersion: consignment.codClaimVersion,
      collectionReason: reason.trim(),
    };
    const fingerprint = JSON.stringify(terms);
    if (fingerprint !== request.current.fingerprint) request.current = { fingerprint, key: crypto.randomUUID() };
    update.mutate({ ...terms, clientRequestId: request.current.key });
  };
  return (
    <section className="space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-bold">تعليمات تحصيل الرصيد الآجل · المطالبة {consignment.codClaimVersion}</h3>
      <CreditCollectionChoice creditAmount={consignment.invoiceRemainingAmount ?? "0"} fee={consignment.deliveryFee} feeCollection={consignment.feeCollection} value={choice} onChange={setChoice} disabled={update.isPending} />
      <label className="block space-y-1 text-sm">سبب تعديل التحصيل<Input aria-label="سبب تعديل تحصيل الآجل" value={reason} maxLength={255} onChange={(event) => setReason(event.target.value)} disabled={update.isPending} /></label>
      <p className="text-xs leading-6 text-muted-foreground">تعديل المطالبة لا يسجل قبضاً ولا يغيّر سائق الطرد أو موقعه. يُثبت السداد عند القبض الفعلي.</p>
      <div className="flex gap-2"><Button size="sm" disabled={invalid} onClick={submit}>حفظ تعليمات التحصيل</Button><Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => setEditing(false)}>تراجع</Button></div>
    </section>
  );
}
