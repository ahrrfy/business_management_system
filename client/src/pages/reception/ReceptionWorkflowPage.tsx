/**
 * DeliveryWorkflowPage - شاشة الإسناد والتوصيل /reception/workflow
 * ثلاثة أقسام: الإسناد، التحصيل والذمم، الإلغاء والمرتجع
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, BadgeDollarSign, Ban, BarChart3, Building2, CheckCircle2, CheckSquare, Clock, FileText, Info, Package, Printer, RefreshCcw, ScanLine, Square, Truck, User, Wallet } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import { cn } from "@/lib/utils";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { parseScan } from "@/lib/scanRouter";
import { printDeliveryDispatchSlip, type DispatchSlipData } from "@/lib/printing/printDeliveryDispatchSlip";
import { ReceptionCollectSection } from "@/components/reception/ReceptionCollectSection";
import { invoiceStatusBadgeVariant, invoiceStatusLabel } from "@shared/invoiceStatus";
import { workOrderStatusBadgeCls, workOrderStatusLabel } from "@shared/workOrderStatus";

type Section = "dispatch" | "collect" | "return";

interface ScannedOrder {
  id: number;
  kind?: "workOrder" | "invoice" | "onlineOrder";
  orderNumber: string;
  title: string | null;
  status?: string | null;
  branchId?: number | null;
  customerName: string | null;
  customerPhone: string | null;
  salePrice: string;
  deposit: string | null;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryCost: string | null;
  version: number;
  invoiceId?: number | null;
  activeConsignment?: { id: number; consignmentNumber: string; partyId: number; partyName: string | null; partyType: "INDIVIDUAL" | "COMPANY" | null; parcelStatus: string; moneyStatus: string; codAmount: string; collectedAmount: string; } | null;
}

export default function DeliveryWorkflowPage() {
  const [activeSection, setActiveSection] = useState<Section>("dispatch");
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [lastDispatchedSlip, setLastDispatchedSlip] = useState<DispatchSlipData | null>(null);
  const [dispatchScanned, setDispatchScanned] = useState<ScannedOrder | null>(null);
  const [dispatchBarcodeInput, setDispatchBarcodeInput] = useState("");
  const [dispatchFee, setDispatchFee] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [externalTrackingRef, setExternalTrackingRef] = useState("");
  const [collectScannedCode, setCollectScannedCode] = useState<string | null>(null);
  const [returnScanned, setReturnScanned] = useState<ScannedOrder | null>(null);
  const [returnBarcodeInput, setReturnBarcodeInput] = useState("");
  const [returnType, setReturnType] = useState<"FULL" | "PARTIAL">("FULL");
  const [returnReason, setReturnReason] = useState("");
  const dispatchRef = useRef<HTMLInputElement>(null);
  const returnRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId;
  // enabled: !!branchId يمنع الاستعلام حتى يصل me.data — لا سقوط صامت على فرع افتراضي (§ G3)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const shiftQ = trpc.shifts.current.useQuery({ branchId: branchId!, shiftType: "RECEPTION" }, { enabled: !!branchId });
  const shift = shiftQ.data ?? null;
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { staleTime: 60_000 });
  const allParties = partiesQ.data ?? [];
  const individualCouriers = allParties.filter((p) => p.partyType === "INDIVIDUAL");
  const companyCouriers = allParties.filter((p) => p.partyType === "COMPANY");
  const selectedPartyInfo = allParties.find((p) => p.id === selectedPartyId);

  // اختيار أول جهة توصيل افتراضياً لتفادي تعطيل الماسح أو تعليق النموذج
  useEffect(() => {
    if (!selectedPartyId && allParties.length > 0) {
      setSelectedPartyId(allParties[0]?.id ?? null);
    }
  }, [allParties, selectedPartyId]);

  const lookupWorkOrder = useCallback(async (raw: string, target: "dispatch" | "return") => {
    const r = parseScan(raw);
    const orderNumber = r.type === "workOrder" || r.type === "invoice" ? r.number : raw.trim();
    if (!orderNumber) return;
    try {
      const wo = await utils.workOrders.getByNumber.fetch({ orderNumber });
      if (!wo) { notify.err(`طلب أو فاتورة غير موجودة: ${orderNumber}`); return; }
      if (target === "dispatch") {
        if (wo.kind === "workOrder") {
          if (wo.status === "DELIVERED") { notify.info(`الطلب ${wo.orderNumber} مُسلَّم`); return; }
          if (wo.status !== "READY") { notify.warn(`الطلب غير جاهز (حالته: ${wo.status})`); return; }
        } else if (wo.kind === "invoice" && (wo.status === "CANCELLED" || wo.status === "RETURNED")) {
          notify.warn("الفاتورة ملغاة أو مرتجعة"); return;
        } else if (wo.kind === "onlineOrder") {
          if (wo.status === "CANCELLED") { notify.warn(`طلب المتجر ${wo.orderNumber} ملغى مسبقاً`); return; }
          if (wo.status === "DELIVERED") { notify.info(`طلب المتجر ${wo.orderNumber} تم تسليمه للعميل مسبقاً`); return; }
        }
      }
      const activeCn = (wo as { activeConsignment?: ScannedOrder["activeConsignment"] }).activeConsignment;
      const order: ScannedOrder = {
        id: wo.id, kind: wo.kind ?? "workOrder", orderNumber: wo.orderNumber, title: wo.title,
        status: wo.status ?? null, branchId: wo.branchId ? Number(wo.branchId) : null,
        customerName: wo.customerName, customerPhone: wo.customerPhone,
        salePrice: wo.salePrice, deposit: wo.deposit,
        deliveryAddress: wo.deliveryAddress, deliveryPhone: wo.deliveryPhone, deliveryCost: wo.deliveryCost,
        version: (wo as { version?: number }).version ?? 1,
        invoiceId: (wo as { invoiceId?: number | null }).invoiceId ?? null,
        activeConsignment: activeCn ?? null,
      };
      if (target === "dispatch") {
        if (activeCn) notify.warn(`الطلب مسند حالياً لـ ${activeCn.partyName ?? "جهة أخرى"} بالإرسالية ${activeCn.consignmentNumber}`);
        setDispatchScanned(order); setDispatchBarcodeInput("");
        setRecipientPhone(wo.deliveryPhone ?? wo.customerPhone ?? "");
        setRecipientName(wo.customerName ?? ""); setDispatchFee(wo.deliveryCost ?? "");
        setDeliveryAddress(wo.deliveryAddress ?? "");
        setDeliveryNotes((wo as { notes?: string | null }).notes ?? "");
        setExternalTrackingRef("");
      } else {
        if (order.status === "RETURNED") notify.warn(`الفاتورة #${order.orderNumber} مسترجعة بالكامل مسبقاً`);
        else if (order.status === "CANCELLED") notify.warn(`الطلب / الفاتورة #${order.orderNumber} ملغاة مسبقاً`);
        else if (order.status === "SUPERSEDED") notify.warn(`الفاتورة #${order.orderNumber} تم استبدالها بتصحيح`);
        setReturnScanned(order); setReturnBarcodeInput(""); setReturnReason("");
      }
    } catch (e) { notify.err(e, "تعذّر جلب الطلب"); }
  }, [utils]);

  const dispatchEnabled = activeSection === "dispatch" && !dispatchScanned;
  const returnEnabled = activeSection === "return" && !returnScanned;
  const collectEnabled = activeSection === "collect";

  useBarcodeScanner(
    useCallback(async (raw: string) => {
      if (dispatchEnabled) await lookupWorkOrder(raw, "dispatch");
      else if (returnEnabled) await lookupWorkOrder(raw, "return");
      else if (collectEnabled) setCollectScannedCode(raw.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dispatchEnabled, returnEnabled, collectEnabled, lookupWorkOrder]),
    { enabled: dispatchEnabled || returnEnabled || collectEnabled },
  );

  const dispatchBarcodeHook = useBarcodeInput((code) => void lookupWorkOrder(code, "dispatch"));
  const returnBarcodeHook = useBarcodeInput((code) => void lookupWorkOrder(code, "return"));

  useEffect(() => {
    if (dispatchEnabled) dispatchRef.current?.focus();
    else if (returnEnabled) returnRef.current?.focus();
  }, [dispatchEnabled, returnEnabled]);

  function onDispatchSuccess(data: { consignmentNumber: string }, kind: "workOrder" | "invoice" | "onlineOrder") {
    notify.ok((kind === "invoice" ? "أُسندت الفاتورة #" : kind === "onlineOrder" ? "أُسند طلب المتجر #" : "أُسند #") + (dispatchScanned?.orderNumber ?? ""), "إرسالية " + data.consignmentNumber);
    const chosenParty = (partiesQ.data ?? []).find((p) => p.id === selectedPartyId);
    const cod = round2(D(dispatchScanned?.salePrice ?? "0").minus(D(dispatchScanned?.deposit ?? "0"))).toFixed(2);
    const finalAddress = deliveryAddress.trim() || dispatchScanned?.deliveryAddress || "غير محدد";
    const slip: DispatchSlipData = {
      consignmentNumber: data.consignmentNumber,
      orderNumber: dispatchScanned?.orderNumber ?? "",
      orderKind: kind,
      partyName: chosenParty?.name ?? "المندوب",
      recipientName: recipientName || dispatchScanned?.customerName || "",
      recipientPhone: recipientPhone || dispatchScanned?.deliveryPhone || dispatchScanned?.customerPhone || "",
      deliveryAddress: finalAddress,
      salePrice: dispatchScanned?.salePrice ?? "0",
      deposit: dispatchScanned?.deposit ?? "0",
      codAmount: cod,
      deliveryFee: dispatchFee || "0",
      feeCollection: "COURIER",
      title: dispatchScanned?.title,
      dispatchedAt: new Date(),
    };
    setLastDispatchedSlip(slip);
    printDeliveryDispatchSlip(slip);
    setDispatchScanned(null); setDispatchBarcodeInput("");
    setRecipientPhone(""); setRecipientName(""); setDispatchFee("");
    setDeliveryAddress(""); setDeliveryNotes(""); setExternalTrackingRef("");
    void utils.workOrders.invalidate(); void utils.delivery.invalidate();
  }

  const dispatchMut = trpc.delivery.dispatch.useMutation({
    onSuccess: (data) => onDispatchSuccess(data, dispatchScanned?.kind ?? "workOrder"),
    onError: (e) => notify.err(e, "تعذّر الإسناد"),
  });

  const dispatchInvoiceMut = trpc.delivery.dispatchInvoice.useMutation({
    onSuccess: (data) => onDispatchSuccess(data, "invoice"),
    onError: (e) => notify.err(e, "تعذّر إسناد الفاتورة للتوصيل"),
  });

  const dispatchBarcodeMut = trpc.delivery.dispatchByBarcode.useMutation({
    onSuccess: (data) => onDispatchSuccess(data, "onlineOrder"),
    onError: (e) => notify.err(e, "تعذّر إسناد طلب المتجر للتوصيل"),
  });

  const cancelMut = trpc.workOrders.cancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغي الطلب " + (returnScanned?.orderNumber ?? ""));
      setReturnScanned(null); setReturnBarcodeInput(""); setReturnReason("");
      void utils.workOrders.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر الإلغاء"),
  });

  const cancelOnlineOrderMut = trpc.storeAdmin.orders.setStatus.useMutation({
    onSuccess: () => {
      notify.ok("أُلغي طلب المتجر #" + (returnScanned?.orderNumber ?? ""));
      setReturnScanned(null); setReturnBarcodeInput(""); setReturnReason("");
      void utils.workOrders.invalidate(); void utils.storeAdmin.orders.invalidate();
    },
    onError: (e: unknown) => notify.err(e, "تعذّر إلغاء طلب المتجر"),
  });

  const returnBarcodeMut = trpc.delivery.returnByBarcode.useMutation({
    onSuccess: (res) => {
      notify.ok("تم استلام مرتجع الإرسالية " + res.consignmentNumber, res.reversed ? "تم عكس الفاتورة والمخزون ذرياً" : "تم تحديث حالة الإرسالية");
      setReturnScanned(null); setReturnBarcodeInput(""); setReturnReason("");
      void utils.delivery.invalidate(); void utils.workOrders.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر استلام المرتجع"),
  });

  async function handleDispatch() {
    if (!dispatchScanned) return;
    if (!selectedPartyId) {
      notify.err("يرجى اختيار جهة التوصيل أولاً");
      return;
    }
    if (dispatchScanned.activeConsignment) {
      notify.err(
        `لا يمكن إسناد الطلب — مسند حالياً لـ ${dispatchScanned.activeConsignment.partyName ?? "جهة أخرى"} بالإرسالية ${dispatchScanned.activeConsignment.consignmentNumber}`,
        "ألغِ الإرسالية السابقة أولاً لتجنّب تداخل الذمم والطرود.",
      );
      return;
    }
    const fee = D(dispatchFee || "0");
    const docLabel = dispatchScanned.kind === "onlineOrder" ? "طلب المتجر" : dispatchScanned.kind === "invoice" ? "الفاتورة" : "الطلب";
    const finalAddress = deliveryAddress.trim() || dispatchScanned.deliveryAddress || "غير محدد";
    const ok = await confirm({
      title: "تأكيد الإسناد",
      description: `${docLabel}: #${dispatchScanned.orderNumber} — ${dispatchScanned.title ?? ""}\nالعميل: ${dispatchScanned.customerName ?? ""} ${dispatchScanned.customerPhone ?? ""}\nالعنوان: ${finalAddress}\n` +
        (fee.gt(0) ? `أجرة التوصيل: ${fmt(fee.toFixed(2))} د.ع (على الجهة)` : "بدون أجرة") +
        (deliveryNotes.trim() ? `\nالملاحظات: ${deliveryNotes.trim()}` : "") +
        (externalTrackingRef.trim() ? `\nرقم التتبع: ${externalTrackingRef.trim()}` : ""),
      confirmText: "أسند للمندوب",
    });
    if (!ok) return;

    if (dispatchScanned.kind === "onlineOrder") {
      dispatchBarcodeMut.mutate({
        barcode: dispatchScanned.orderNumber,
        partyId: selectedPartyId,
        deliveryFee: fee.gt(0) ? fee.toFixed(2) : undefined,
        deliveryAddress: deliveryAddress.trim() || undefined,
        notes: deliveryNotes.trim() || undefined,
        externalTrackingRef: externalTrackingRef.trim() || undefined,
        clientRequestId: crypto.randomUUID(),
      });
    } else if (dispatchScanned.kind === "invoice") {
      dispatchInvoiceMut.mutate({
        invoiceId: dispatchScanned.id,
        partyId: selectedPartyId,
        deliveryFee: fee.gt(0) ? fee.toFixed(2) : undefined,
        recipientName: recipientName.trim() || undefined,
        recipientPhone: recipientPhone.trim() || undefined,
        deliveryAddress: deliveryAddress.trim() || undefined,
        notes: deliveryNotes.trim() || undefined,
        externalTrackingRef: externalTrackingRef.trim() || undefined,
        clientRequestId: crypto.randomUUID(),
      });
    } else {
      dispatchMut.mutate({
        workOrderId: dispatchScanned.id,
        partyId: selectedPartyId,
        deliveryFee: fee.toFixed(2),
        recipientName: recipientName.trim() || undefined,
        recipientPhone: recipientPhone.trim() || undefined,
        deliveryAddress: deliveryAddress.trim() || undefined,
        notes: deliveryNotes.trim() || undefined,
        externalTrackingRef: externalTrackingRef.trim() || undefined,
        clientRequestId: crypto.randomUUID(),
      });
    }
  }

  async function handleFullReturn() {
    if (!returnScanned || returnReason.trim().length < 3) {
      notify.err("أدخل سبب الإلغاء (٣ أحرف على الأقل)"); return;
    }
    const isOnline = returnScanned.kind === "onlineOrder";
    const docLabel = isOnline ? "طلب متجر" : returnScanned.kind === "invoice" ? "فاتورة" : "أمر شغل";
    const ok = await confirm({
      variant: "warning", title: `إلغاء / استرجاع ${docLabel}`,
      description: `#${returnScanned.orderNumber} — ${returnScanned.customerName ?? ""}\n` +
        (returnScanned.activeConsignment ? `الإرسالية الحالية: ${returnScanned.activeConsignment.consignmentNumber}\nسيتم تسجيل مرتجع الإرسالية وعكس بيعها ومخزونها ذرياً.` :
        (D(returnScanned.deposit ?? "0").gt(0) ? `سيُردّ عربون ${fmt(returnScanned.deposit!)} د.ع من الدرج` : "لا عربون — إلغاء مباشر")),
      confirmText: "تأكيد الإلغاء / الاسترجاع",
    });
    if (!ok) return;

    if (isOnline) {
      if (returnScanned.activeConsignment) {
        returnBarcodeMut.mutate({
          barcode: returnScanned.orderNumber,
          returnReason: returnReason.trim(),
          refundShiftId: shift?.id,
          clientRequestId: crypto.randomUUID(),
        });
      } else {
        cancelOnlineOrderMut.mutate({
          id: returnScanned.id,
          status: "CANCELLED",
          cancelReason: returnReason.trim(),
        });
      }
      return;
    }

    cancelMut.mutate({
      workOrderId: returnScanned.id,
      expectedVersion: returnScanned.version,
      reason: returnReason.trim(),
      refundShiftId: shift?.id,
      clientRequestId: crypto.randomUUID(),
    });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" dir="rtl">
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <PageHeader
          title="التوصيل والإسناد"
          icon={<Truck aria-hidden className="size-5 text-primary" />}
          backHref="/pos?mode=RECEPTION"
          backLabel="الاستقبال"
          actions={
            shift ? (
              <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">وردية #{shift.id}</span>
            ) : (
              <span className="rounded-full bg-destructive/10 px-3 py-1 text-xs font-bold text-destructive">لا وردية</span>
            )
          }
        />
      </div>

      <div className="flex shrink-0 border-b bg-card">
        {([
          { key: "dispatch" as const, icon: <Truck aria-hidden className="size-4" />, label: "إسناد للمندوب" },
          { key: "collect" as const, icon: <Wallet aria-hidden className="size-4" />, label: "تحصيل وذمم" },
          { key: "return" as const, icon: <RefreshCcw aria-hidden className="size-4" />, label: "إلغاء / مرتجع" },
        ]).map(({ key, icon, label }) => (
          <button key={key} type="button" onClick={() => setActiveSection(key)}
            className={cn("flex flex-1 items-center justify-center gap-2 py-3 text-sm font-bold transition-colors",
              activeSection === key ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:bg-muted/40")}>
            {icon} {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {activeSection === "dispatch" && (
          <div className="mx-auto max-w-2xl space-y-4">
            {lastDispatchedSlip && (
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)]/20 p-3.5">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-5 text-[var(--sem-pos)] shrink-0" />
                  <div>
                    <span className="font-extrabold text-foreground">تم إسناد الطلب #{lastDispatchedSlip.orderNumber} بنجاح</span>
                    <p className="text-xs text-muted-foreground">إرسالية: {lastDispatchedSlip.consignmentNumber} · المندوب: {lastDispatchedSlip.partyName}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => printDeliveryDispatchSlip(lastDispatchedSlip)}
                  className="font-bold text-xs h-9 gap-1.5 shrink-0 bg-background"
                >
                  <Printer className="size-3.5 text-primary" />
                  إعادة طباعة البوليصة
                </Button>
              </div>
            )}

            <Card className="gap-0 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="grid size-6 place-items-center rounded-full bg-primary text-[11px] font-black text-primary-foreground">١</span>
                  <h2 className="font-extrabold">اختر جهة التوصيل</h2>
                </div>
                {selectedPartyInfo && (
                  <Badge variant="outline" className={selectedPartyInfo.partyType === "COMPANY" ? "border-blue-500 text-blue-700 font-bold" : "border-[var(--sem-pos)] text-[var(--sem-pos)] font-bold"}>
                    {selectedPartyInfo.partyType === "COMPANY" ? "شركة توصيل خارجية" : "مندوب داخلي"}
                  </Badge>
                )}
              </div>
              <AppSelect
                value={selectedPartyId ? String(selectedPartyId) : ""}
                onValueChange={(v) => { setSelectedPartyId(v ? Number(v) : null); setDispatchScanned(null); setDispatchBarcodeInput(""); }}
                className="h-12 w-full text-base font-bold"
              >
                <option value="">— اختر المندوب أو شركة التوصيل —</option>
                {individualCouriers.length > 0 && (
                  <optgroup label="── المناديب الداخليين (سائقون بعُهدة نقدية) ──">
                    {individualCouriers.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name} (مندوب)
                      </option>
                    ))}
                  </optgroup>
                )}
                {companyCouriers.length > 0 && (
                  <optgroup label="── شركات ومكاتب التوصيل (مطابقة كشوفات دورية) ──">
                    {companyCouriers.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name} (شركة)
                      </option>
                    ))}
                  </optgroup>
                )}
              </AppSelect>
            </Card>

            {selectedPartyId && !dispatchScanned && (
              <div className="rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-6 text-center">
                <ScanLine aria-hidden className="mx-auto size-10 text-primary/60" />
                <p className="mt-2 text-base font-extrabold text-primary">امسح باركود الطلب للإسناد</p>
                <p className="mt-1 text-sm text-muted-foreground">أو أدخل رقم الطلب يدوياً</p>
                <div className="mt-4 flex gap-2">
                  <Input ref={dispatchRef} value={dispatchBarcodeInput}
                    onChange={(e) => setDispatchBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      dispatchBarcodeHook.handleKeyDown(e, setDispatchBarcodeInput);
                      if (!e.defaultPrevented && e.key === "Enter" && dispatchBarcodeInput.trim())
                        void lookupWorkOrder(dispatchBarcodeInput.trim(), "dispatch");
                    }}
                    placeholder="رقم الطلب (Enter)" className="flex-1 text-center font-bold" dir="ltr" />
                  <Button variant="outline" onClick={() => void lookupWorkOrder(dispatchBarcodeInput.trim(), "dispatch")} disabled={!dispatchBarcodeInput.trim()}>بحث</Button>
                </div>
              </div>
            )}

            {dispatchScanned && (
              <Card className="overflow-hidden gap-0 py-0 shadow-sm">
                <div className="flex items-start justify-between border-b bg-muted/30 p-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Package aria-hidden className="size-5 text-primary" />
                      <span className="text-lg font-extrabold">#{dispatchScanned.orderNumber}</span>
                      <Badge variant="outline" className="border-green-500 text-green-600">جاهز</Badge>
                    </div>
                    {dispatchScanned.title && <p className="mt-1 text-sm text-muted-foreground">{dispatchScanned.title}</p>}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setDispatchScanned(null); setDispatchBarcodeInput(""); }}>مسح طلب آخر</Button>
                </div>
                <div className="space-y-3 p-4">
                  {dispatchScanned.activeConsignment && (
                    <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 space-y-1">
                      <div className="flex items-center gap-2 text-destructive font-extrabold text-sm">
                        <AlertTriangle className="size-4 shrink-0" />
                        <span>الطلب مسند مسبقاً لجهة أخرى ولا يمكن تكرار إسناده!</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        جهة التوصيل الحالية: <strong className="text-foreground">{dispatchScanned.activeConsignment.partyName ?? "غير محدد"}</strong> · إرسالية: <strong className="font-mono text-foreground">{dispatchScanned.activeConsignment.consignmentNumber}</strong> · حالة الطرد: <strong className="text-foreground">{dispatchScanned.activeConsignment.parcelStatus}</strong>
                      </p>
                      <p className="text-xs text-destructive font-bold">
                        يجب إلغاء الإرسالية السابقة أو استرجاعها أولاً لعزل الذمم ومنع التداخل المالي.
                      </p>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex items-center gap-2 rounded-xl border bg-background p-3">
                      <User aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">العميل</p>
                        <p className="font-bold">{dispatchScanned.customerName ?? "—"}</p>
                        {dispatchScanned.customerPhone && <p className="text-xs text-muted-foreground" dir="ltr">{dispatchScanned.customerPhone}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border bg-background p-3">
                      <BadgeDollarSign aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">القيمة</p>
                        <p className="font-bold">{fmt(dispatchScanned.salePrice)} د.ع</p>
                        {D(dispatchScanned.deposit ?? "0").gt(0) && (
                          <p className="text-xs text-green-600">عربون {fmt(dispatchScanned.deposit!)} · متبقٍّ {fmt(round2(D(dispatchScanned.salePrice).minus(D(dispatchScanned.deposit!))).toFixed(2))} على المندوب</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-3">
                    <p className="text-xs font-extrabold text-primary">بيانات الإسناد والتوصيل</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-bold">هاتف المستلم</label>
                        <IntlPhoneInput value={recipientPhone} onChange={setRecipientPhone} placeholder="770 123 4567" className="h-10" />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-bold">أجرة التوصيل (د.ع)</label>
                        <MoneyInput value={dispatchFee} onChange={setDispatchFee} placeholder="0" className="h-10" ariaLabel="أجرة التوصيل" />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-xs font-bold">
                        <Truck aria-hidden className="size-3.5 text-muted-foreground" />
                        عنوان التوصيل
                      </label>
                      <Input
                        value={deliveryAddress}
                        onChange={(e) => setDeliveryAddress(e.target.value)}
                        placeholder="المحافظة - المدينة - الحي - أقرب نقطة دالة..."
                        className="h-10 bg-background"
                      />
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-xs font-bold">
                        <FileText aria-hidden className="size-3.5 text-muted-foreground" />
                        ملاحظات التوصيل
                      </label>
                      <Input
                        value={deliveryNotes}
                        onChange={(e) => setDeliveryNotes(e.target.value)}
                        placeholder="أي تعليمات للمندوب أو وقت التسليم المفضل..."
                        className="h-10 bg-background"
                      />
                    </div>
                    {selectedPartyInfo?.partyType === "COMPANY" && (
                      <div>
                        <label className="mb-1 flex items-center gap-1 text-xs font-bold">
                          <Package aria-hidden className="size-3.5 text-muted-foreground" />
                          رقم تتبع / بوليصة الشركة الخارجية (اختياري)
                        </label>
                        <Input
                          value={externalTrackingRef}
                          onChange={(e) => setExternalTrackingRef(e.target.value)}
                          placeholder="رقم البوليصة أو شحنة الشركة..."
                          className="h-10 bg-background font-mono text-xs"
                          dir="ltr"
                        />
                      </div>
                    )}
                  </div>
                  <Button
                    className="w-full py-6 text-base font-extrabold"
                    onClick={() => void handleDispatch()}
                    disabled={dispatchMut.isPending || dispatchInvoiceMut.isPending || dispatchBarcodeMut.isPending || !!dispatchScanned.activeConsignment}
                  >
                    {dispatchScanned.activeConsignment
                      ? "مسند مسبقاً للإرسالية " + dispatchScanned.activeConsignment.consignmentNumber
                      : (dispatchMut.isPending || dispatchInvoiceMut.isPending || dispatchBarcodeMut.isPending)
                        ? "جارٍ الإسناد…"
                        : D(dispatchFee || "0").gt(0)
                          ? "أسند للمندوب · أجرة " + fmt(dispatchFee) + " د.ع"
                          : "أسند للمندوب"}
                  </Button>
                </div>
              </Card>
            )}
          </div>
        )}

        {activeSection === "collect" && !!branchId && (
          <ReceptionCollectSection
            branchId={branchId}
            shift={shift}
            scannedBarcode={collectScannedCode}
            onBarcodeConsumed={() => setCollectScannedCode(null)}
          />
        )}

        {activeSection === "return" && (
          <div className="mx-auto max-w-2xl space-y-4">
            <Card className="gap-0 p-4">
              <h2 className="mb-3 font-extrabold">نوع الإجراء</h2>
              <div className="grid grid-cols-2 gap-2">
                {(["FULL", "PARTIAL"] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setReturnType(t)}
                    className={cn("flex items-center justify-center gap-2 rounded-xl border-2 py-3 text-sm font-extrabold transition-colors",
                      returnType === t ? "border-destructive bg-destructive/10 text-destructive" : "text-muted-foreground hover:bg-muted/40")}>
                    {t === "FULL" ? <><Ban className="size-4" /> إلغاء / مرتجع كامل</> : <><RefreshCcw className="size-4" /> مرتجع جزئي</>}
                  </button>
                ))}
              </div>
            </Card>

            {!returnScanned && (
              <div className="rounded-2xl border-2 border-dashed border-destructive/40 bg-destructive/5 p-6 text-center">
                <ScanLine aria-hidden className="mx-auto size-10 text-destructive/60" />
                <p className="mt-2 text-base font-extrabold text-destructive">امسح باركود الطلب أو الفاتورة</p>
                <div className="mt-4 flex gap-2">
                  <Input ref={returnRef} value={returnBarcodeInput}
                    onChange={(e) => setReturnBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      returnBarcodeHook.handleKeyDown(e, setReturnBarcodeInput);
                      if (!e.defaultPrevented && e.key === "Enter" && returnBarcodeInput.trim())
                        void lookupWorkOrder(returnBarcodeInput.trim(), "return");
                    }}
                    placeholder="رقم الطلب أو الفاتورة (Enter)" className="flex-1 text-center font-bold" dir="ltr" />
                  <Button variant="outline" onClick={() => void lookupWorkOrder(returnBarcodeInput.trim(), "return")} disabled={!returnBarcodeInput.trim()}>بحث</Button>
                </div>
              </div>
            )}

            {returnScanned && returnScanned.kind === "invoice" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-xl border bg-muted/40 p-3">
                  <div className="flex items-center gap-2">
                    <Package aria-hidden className="size-5 text-primary" />
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-extrabold text-base">فاتورة بيع #{returnScanned.orderNumber}</span>
                        {returnScanned.status && (
                          <Badge variant={invoiceStatusBadgeVariant(returnScanned.status)} className="font-bold">
                            {invoiceStatusLabel(returnScanned.status)}
                          </Badge>
                        )}
                        {returnScanned.branchId && branchId && returnScanned.branchId !== branchId && (
                          <Badge variant="outline" className="border-primary text-primary font-bold">فرع #{returnScanned.branchId}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">العميل: {returnScanned.customerName || "زبون نقدي"}</p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setReturnScanned(null); setReturnBarcodeInput(""); }}>مسح فاتورة أخرى</Button>
                </div>
                {returnScanned.status === "RETURNED" && (
                  <div className="rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/30 p-3 flex items-start gap-2.5">
                    <AlertTriangle aria-hidden className="size-4 shrink-0 text-[var(--sem-warn)] mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-[var(--sem-warn)]">هذه الفاتورة تم استرجاعها بالكامل مسبقاً</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">تم استرجاع جميع بنود ومبالغ هذه الفاتورة في سجل المرتجعات ولا يمكن تكرار استرجاعها.</p>
                    </div>
                  </div>
                )}
                {returnScanned.status === "CANCELLED" && (
                  <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2.5">
                    <Ban aria-hidden className="size-4 shrink-0 text-destructive mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-destructive">هذه الفاتورة ملغاة مسبقاً</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">تم إلغاء هذه الفاتورة مسبقاً ولا يمكن تسجيل مرتجع عليها.</p>
                    </div>
                  </div>
                )}
                {returnScanned.branchId && branchId && returnScanned.branchId !== branchId && (
                  <div className="rounded-xl border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)]/20 p-3 flex items-start gap-2.5">
                    <Info aria-hidden className="size-4 shrink-0 text-[var(--sem-info)] mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-[var(--sem-info)]">الفاتورة تنتمي لفرع آخر (فرع #{returnScanned.branchId})</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">أنت تعمل حالياً في فرع #{branchId}. يتطلب إرجاعها التواجد في فرعها الأصلي أو صلاحيات إدارية.</p>
                    </div>
                  </div>
                )}
                <ReturnComposer
                  invoiceId={returnScanned.id}
                  onDone={() => {
                    notify.ok("تم تسجيل المرتجع بنجاح");
                    setReturnScanned(null);
                    setReturnBarcodeInput("");
                    void utils.workOrders.invalidate();
                    void utils.delivery.invalidate();
                  }}
                />
              </div>
            )}

            {returnScanned && returnScanned.kind !== "invoice" && returnType === "FULL" && (
              <Card className="overflow-hidden gap-0 py-0 shadow-sm">
                <div className="flex items-start justify-between border-b bg-destructive/10 p-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Package aria-hidden className="size-5 text-destructive" />
                      <span className="text-lg font-extrabold">#{returnScanned.orderNumber}</span>
                      {returnScanned.status && (
                        <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold", workOrderStatusBadgeCls(returnScanned.status))}>
                          {workOrderStatusLabel(returnScanned.status)}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm font-bold">{returnScanned.customerName}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setReturnScanned(null); setReturnBarcodeInput(""); }}>مسح طلب آخر</Button>
                </div>
                <div className="space-y-3 p-4">
                  {returnScanned.status === "CANCELLED" && (
                    <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2.5">
                      <Ban aria-hidden className="size-4 shrink-0 text-destructive mt-0.5" />
                      <div>
                        <p className="text-xs font-bold text-destructive">هذا الطلب ملغي مسبقاً</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">تم إلغاء هذا الطلب مسبقاً ولا يمكن تكرار إلغائه.</p>
                      </div>
                    </div>
                  )}
                  <div className="rounded-xl border bg-background p-3 space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">قيمة الطلب</span>
                      <span className="font-bold">{fmt(returnScanned.salePrice)} د.ع</span>
                    </div>
                    {D(returnScanned.deposit ?? "0").gt(0) && <>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">عربون مدفوع</span>
                        <span className="font-bold text-green-600">{fmt(returnScanned.deposit!)} د.ع</span>
                      </div>
                      <div className="flex justify-between text-sm border-t pt-1">
                        <span className="font-bold">يُردّ للزبون من الدرج</span>
                        <span className="font-bold text-destructive">{fmt(returnScanned.deposit!)} د.ع</span>
                      </div>
                    </>}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-bold">سبب الإلغاء <span className="text-destructive">*</span></label>
                    <Input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="مثال: طلب العميل الإلغاء، تأخر التسليم…" className="h-10" />
                  </div>
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm">
                    <p className="font-bold text-destructive">تنبيه — سيتمّ عند التأكيد:</p>
                    <ul className="mt-1 space-y-1 list-disc list-inside text-muted-foreground">
                      <li>إلغاء أمر الشغل نهائياً</li>
                      {D(returnScanned.deposit ?? "0").gt(0) && <li>ردّ {fmt(returnScanned.deposit!)} د.ع من درج الوردية #{shift?.id ?? ""}</li>}
                      <li>إعادة المواد والمخزون للرصيد</li>
                    </ul>
                  </div>
                  <Button variant="destructive" className="w-full py-6 text-base font-extrabold"
                    onClick={() => void handleFullReturn()} disabled={cancelMut.isPending || returnScanned.status === "CANCELLED" || returnReason.trim().length < 3}>
                    {cancelMut.isPending ? L.cancelling : returnScanned.status === "CANCELLED" ? "الطلب ملغي مسبقاً" : "إلغاء الطلب بالكامل"}
                  </Button>
                </div>
              </Card>
            )}

            {returnScanned && returnScanned.kind !== "invoice" && returnType === "PARTIAL" && (
              <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-6 text-center space-y-3">
                <RefreshCcw aria-hidden className="mx-auto size-10 text-primary" />
                <p className="text-base font-extrabold text-foreground">أمر شغل مخصص #{returnScanned.orderNumber}</p>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  أمر الشغل وحدة تصنيع متكاملة يُلغى بالكامل ويردّ عربونه من درج الوردية. إذا كان الطلب مسجلاً كفاتورة مبيعات، يرجى مسح رقم الفاتورة لإجراء المرتجع الجزئي للبنود والكميات.
                </p>
                <div className="flex justify-center gap-2 pt-2">
                  <Button variant="outline" className="font-bold" onClick={() => setReturnType("FULL")}>
                    التحويل إلى إلغاء كامل
                  </Button>
                  <Button variant="ghost" onClick={() => { setReturnScanned(null); setReturnBarcodeInput(""); }}>
                    مسح طلب أو فاتورة أخرى
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
