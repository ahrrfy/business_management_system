import React, { useRef, useState } from "react";
import Decimal from "decimal.js";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { RefundRailPicker, type RefundRailPickerState } from "@/components/ui/RefundRailPicker";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { fmt, moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { InvoiceDispatchDialog } from "./InvoiceDispatchDialog";
import { CollectConsignmentDialog } from "./CollectConsignmentDialog";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { useWorkflowDocumentPrinter } from "@/hooks/useWorkflowDocumentPrinter";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { printAssignmentCancelReceipt, printInvoicePaymentReceipt } from "@/lib/printing/cashierLifecycleReceipts";

type Shipment = NonNullable<RouterOutputs["delivery"]["consignmentTimeline"]["shipment"]>;
const ACTIONS = [
  { value: "confirm", label: "تأكيد تسليم وتحصيل الشحنة", path: "delivery.staffConfirm" },
  { value: "fail", label: "تعذر تسليم الشحنة", path: "delivery.staffMarkFailed" },
  { value: "driver", label: "تغيير سائق الشحنة", path: "delivery.reassignConsignment" },
  { value: "cancel", label: "إلغاء الإسناد وتحرير الطلب", path: "delivery.cancelAssignment" },
  { value: "declare", label: "إعلان رجوع الشحنة قبل وصولها", path: "delivery.declareReturn" },
  { value: "return", label: "استلام وإرجاع الشحنة كاملة", path: "delivery.returnConsignment" },
] as const;

/** Physical actions always cover the entire shipment; invoice balances remain separate. */
export function ShipmentDetailsPanel({ shipment }: { shipment: Shipment }) {
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [driver, setDriver] = useState("");
  const [rail, setRail] = useState<RefundRailPickerState | null>(null);
  const [redispatchOpen, setRedispatchOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [physicalHeld, setPhysicalHeld] = useState(false);
  const request = useRef({ fingerprint: "", key: crypto.randomUUID() });
  const leader = shipment.members.find((row) => row.id === shipment.leaderConsignmentId)!;
  const remaining = new Decimal(shipment.collectibleAmount);
  const invoiceRemaining = new Decimal(shipment.remainingAmount);
  const legacy = !!me.data && moduleAccessAllowed(me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null, "store", "FULL", ["cashier", "manager"]);
  const operational = shipment.members.filter((row) => row.operational);
  const open = operational.length > 0 && operational.every((row) => row.status === "DISPATCHED"
    && !["DELIVERED", "RETURNED", "CANCELLED"].includes(row.parcelStatus));
  const returnDeclared = operational.length > 0 && operational.every((row) => row.returnDeclaredAt != null);
  const live = open && operational.every((row) => row.returnDeclaredAt == null);
  const unpaidToParty = operational.every((row) => new Decimal(row.collectedAmount ?? "0").isZero());
  const redispatchAnchor = shipment.members.find(row => row.invoiceId != null && row.invoiceStatus != null && !isDeadInvoiceStatus(row.invoiceStatus));
  const cancelled = !!redispatchAnchor && shipment.members.every((row) => ["CANCELLED", "RETURNED"].includes(row.parcelStatus));
  const actions = ACTIONS.filter((item) => lifecycleActionAllowed(me.data, item.path, legacy) && (live || (open && item.value === "return"))
    && (item.value === "confirm" || item.value === "driver" || unpaidToParty));
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { enabled: action === "driver", staleTime: 60_000 });
  const drivers = partiesQ.data?.find((party) => party.id === leader.partyId)?.drivers ?? [];
  const workflowPrinter = useWorkflowDocumentPrinter(Number(leader.branchId));
  const actionWinsRef = useRef<{ kind: string; pack: Window | null; label: Window | null; amount: string; reason: string } | null>(null);
  const closeActionWins = () => {
    const wins = actionWinsRef.current; actionWinsRef.current = null;
    if (wins?.pack && !wins.pack.closed) wins.pack.close();
    if (wins?.label && !wins.label.closed) wins.label.close();
  };
  const onSuccess = async () => {
    const wins = actionWinsRef.current; actionWinsRef.current = null;
    notify.ok("تم تحديث الشحنة بكامل فواتيرها");
    if (wins) {
      if (wins.kind === "driver") {
        void workflowPrinter.printShipmentAndLabel(shipment.leaderConsignmentId, wins.pack, wins.label, Number(leader.branchId));
      } else if (wins.kind === "confirm") {
        void printInvoicePaymentReceipt({
          invoiceNumber: shipment.consignmentNumber,
          customerName: leader.recipientName,
          customerPhone: leader.recipientPhone,
          amountPaid: new Decimal(wins.amount || 0).toFixed(2),
          reference: operational.map((m) => m.invoiceNumber).join("، ") || null,
          cashierName: me.data?.name ?? null,
        }, { into: wins.pack });
      } else if (wins.kind === "cancel" || wins.kind === "declare" || wins.kind === "return") {
        void printAssignmentCancelReceipt({
          action: wins.kind === "declare" ? "declareReturn" : "cancelAssignment",
          consignmentNumber: shipment.consignmentNumber,
          sourceRef: operational.map((m) => m.invoiceNumber).join("، ") || shipment.consignmentNumber,
          recipientName: leader.recipientName,
          codAmount: shipment.collectibleAmount,
          reason: wins.reason,
          cashierName: me.data?.name ?? null,
        }, { into: wins.pack });
      } else if (wins.pack && !wins.pack.closed) wins.pack.close();
    }
    setAction(""); setReason(""); setPhysicalHeld(false);
    request.current = { fingerprint: "", key: crypto.randomUUID() };
    await Promise.all([utils.delivery.invalidate(), utils.sales.invalidate(), utils.reception.invalidate()]);
  };
  const options = { onSuccess, onError: (error: { message: string }) => { closeActionWins(); notify.err(error.message); } };
  const confirmMutation = trpc.delivery.staffConfirm.useMutation(options);
  const cancelMutation = trpc.delivery.cancelAssignment.useMutation(options);
  const returnMutation = trpc.delivery.returnConsignment.useMutation(options);
  const failMutation = trpc.delivery.staffMarkFailed.useMutation(options);
  const driverMutation = trpc.delivery.reassignConsignment.useMutation(options);
  const declareMutation = trpc.delivery.declareReturn.useMutation(options);
  const pending = confirmMutation.isPending || cancelMutation.isPending || returnMutation.isPending || failMutation.isPending || driverMutation.isPending || declareMutation.isPending;
  const amountValid = /^(?:\d+|\d*\.\d{1,2})$/.test(amount);
  const invalid = !action || pending || (action !== "driver" && reason.trim().length < 3)
    || (action === "cancel" && !physicalHeld)
    || (action === "confirm" && (!amountValid || !moneyInput(amount).eq(remaining)))
    || (action === "return" && (!rail || rail.loading || !!rail.error || !!rail.blockReason));

  async function submit() {
    if (invalid) return;
    if ((action === "return" || action === "cancel" || action === "declare") && !await confirm({
      title: action === "return" ? "إرجاع جميع فواتير الشحنة؟" : action === "declare" ? "إعلان رجوع الشحنة كاملة؟" : "إلغاء إسناد الشحنة وتحرير الطلب؟",
      description: `يشمل الإجراء ${operational.length} فواتير متبقية في الشحنة ${shipment.consignmentNumber}. ${reason.trim()}`,
      variant: "warning", confirmText: "تأكيد على كامل الشحنة",
    })) return;
    const fingerprint = JSON.stringify({ action, reason, amount, driver, physicalHeld, shift: rail?.selection?.refundShiftId });
    if (request.current.fingerprint !== fingerprint) request.current = { fingerprint, key: crypto.randomUUID() };
    actionWinsRef.current = action === "fail" ? null : {
      kind: action,
      pack: preopenDocumentWindow(),
      label: action === "driver" ? preopenShippingLabelWindow() : null,
      amount,
      reason: reason.trim(),
    };
    const base = { consignmentId: shipment.leaderConsignmentId, wholeShipment: true, clientRequestId: request.current.key };
    if (action === "confirm") confirmMutation.mutate({ ...base, collectedAmount: new Decimal(amount).toFixed(2), evidence: reason.trim() });
    if (action === "cancel") cancelMutation.mutate({ ...base, reason: reason.trim(), physicalHeldConfirmed: true });
    if (action === "fail") failMutation.mutate({ ...base, reason: reason.trim() });
    if (action === "driver") driverMutation.mutate({ ...base, partyId: leader.partyId, assignedUserId: driver ? Number(driver) : null });
    if (action === "return") returnMutation.mutate({ ...base, returnReason: reason.trim(), refundShiftId: rail?.selection?.refundShiftId });
    if (action === "declare") declareMutation.mutate({ ...base, reason: reason.trim() });
  }

  return (
    <section className="space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-bold">شحنة واحدة · {shipment.memberCount} فواتير</h3>
      <div className="divide-y text-sm">
        {shipment.members.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-2 py-2">
            <a href={`/invoices/${row.invoiceId}`} className="font-mono text-primary hover:underline" dir="ltr">{row.invoiceNumber}</a>
            {!row.operational && <span className="text-xs text-muted-foreground">{row.parcelStatus === "RETURNED" ? "مرتجعة" : "ملغاة"} · خارج إجراءات الشحنة</span>}
            <span className="tabular-nums" dir="ltr">{fmt(row.invoiceRemaining)} د.ع</span>
          </div>
        ))}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">{returnDeclared ? "قيمة الفواتير بانتظار استلام المرتجع" : "المتبقي لتحصيل الشحنة"}: <b className="text-foreground">{fmt((returnDeclared ? invoiceRemaining : remaining).toFixed(2))} د.ع</b> · أجرة الشحنة مرة واحدة: {fmt(shipment.deliveryFee)} د.ع · البوليصة: <span dir="ltr">{leader.externalTrackingRef ?? "—"}</span></p>
      {!returnDeclared && !cancelled && remaining.gt(0) && (lifecycleActionAllowed(me.data, "delivery.recordRemittance", legacy) || lifecycleActionAllowed(me.data, "delivery.recordCompanyStatement", legacy)) && (
        <Button size="sm" variant="default" className="font-bold" onClick={() => setCollectOpen(true)}>
          قبض وتوريد الشحنة للدرج
        </Button>
      )}
      {collectOpen && (
        <CollectConsignmentDialog
          consignment={{
            id: shipment.leaderConsignmentId,
            consignmentNumber: shipment.consignmentNumber,
            partyId: Number(leader.partyId),
            customerName: leader.recipientName,
            recipientPhone: leader.recipientPhone,
            codDue: shipment.collectibleAmount,
            codAmount: shipment.collectibleAmount,
            parcelStatus: leader.parcelStatus,
            shipmentLeaderConsignmentId: shipment.leaderConsignmentId,
            shipmentInvoiceCount: shipment.memberCount,
            shipmentNumber: shipment.consignmentNumber,
            shipmentTrackingRef: leader.externalTrackingRef,
          }}
          open={collectOpen}
          onOpenChange={setCollectOpen}
          onCompleted={() => {
            setCollectOpen(false);
            void Promise.all([utils.delivery.invalidate(), utils.sales.invalidate(), utils.reception.invalidate()]);
          }}
        />
      )}
      {returnDeclared && open && <p className="text-sm text-muted-foreground">أُعلن رجوع الشحنة وتوقف توقع تحصيلها. بعد وصولها وفحصها نفّذ «استلام وإرجاع الشحنة كاملة» لإعادة المخزون ومعالجة الفواتير.</p>}
      {cancelled && lifecycleActionAllowed(me.data, "delivery.dispatchInvoice", legacy) && <Button size="sm" variant="outline" onClick={() => setRedispatchOpen(true)}>إعادة إسناد الشحنة كاملة</Button>}
      <InvoiceDispatchDialog invoice={redispatchOpen && redispatchAnchor ? { id: Number(redispatchAnchor.invoiceId), invoiceNumber: redispatchAnchor.invoiceNumber, branchId: Number(leader.branchId), total: redispatchAnchor.codAmount, customerName: leader.recipientName, customerPhone: leader.recipientPhone, deliveryAddress: leader.deliveryAddress } : null} open={redispatchOpen} onOpenChange={setRedispatchOpen} />
      {actions.length > 0 && <AppSelect aria-label="إجراء على كامل الشحنة" value={action} disabled={pending} onValueChange={(value) => {
        setAction(value); setReason(""); setAmount(remaining.toFixed(2)); setRail(null); setPhysicalHeld(false); setDriver(leader.assignedUserId ? String(leader.assignedUserId) : "");
      }}><option value="">إجراء على كامل الشحنة…</option>{actions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</AppSelect>}
      {action && <div className="space-y-3">
        {action === "declare" && <p className="text-xs leading-6 text-muted-foreground">إعلان الرجوع يوقف توقع التحصيل فقط. لا يعيد المخزون ولا يعكس الفواتير أو يرد أي مبلغ قبل وصول الشحنة واستلامها.</p>}
        {action === "cancel" && <label className="flex items-center gap-2 text-sm"><Checkbox checked={physicalHeld} onCheckedChange={(checked) => setPhysicalHeld(checked === true)} disabled={pending} />تحققت فعلياً أن كامل الشحنة عادت إلى عهدة المكتبة</label>}
        {action === "driver" ? <AppSelect value={driver} onValueChange={setDriver} aria-label="سائق الشحنة"><option value="">طابور الجهة</option>{drivers.map((item) => <option key={item.userId} value={String(item.userId)}>{item.name}</option>)}</AppSelect> : <div className="space-y-1"><Label htmlFor="shipment-evidence">{action === "confirm" ? "مصدر تأكيد التسليم والتحصيل" : "السبب"}</Label><Input id="shipment-evidence" value={reason} maxLength={255} onChange={(event) => setReason(event.target.value)} /></div>}
        {action === "confirm" && <div className="space-y-2"><Label>المبلغ المطلوب لجميع الفواتير</Label><MoneyInput ariaLabel="مبلغ تحصيل الشحنة" value={amount} onChange={setAmount} disabled /></div>}
        {action === "return" && <RefundRailPicker context={{ sourceDocType: "CONSIGNMENT_RETURN", sourceDocId: shipment.leaderConsignmentId }} mode="embedded" onStateChange={setRail} submitting={pending} />}
        <div className="flex gap-2"><Button size="sm" disabled={invalid} onClick={() => void submit()}>{action === "declare" ? "إعلان الرجوع على كامل الشحنة" : "تنفيذ على كامل الشحنة"}</Button><Button variant="ghost" size="sm" disabled={pending} onClick={() => setAction("")}>تراجع</Button></div>
      </div>}
    </section>
  );
}
