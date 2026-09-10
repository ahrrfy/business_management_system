/**
 * DeliveryWorkflowPage - شاشة الإسناد والتوصيل /reception/workflow
 * ثلاثة أقسام: الإسناد، التحصيل والذمم، الإلغاء والمرتجع
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, BadgeDollarSign, Ban, BarChart3, Building2, CheckCircle2, CheckSquare, Clock, FileText, Package, Printer, RefreshCcw, ScanLine, Square, Truck, User, Wallet } from "lucide-react";
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
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";
import { printCompanyStatementReceipt } from "@/lib/printing/printCompanyStatementReceipt";

type Section = "dispatch" | "collect" | "return";
type PartyObligation = RouterOutputs["delivery"]["obligations"][number];

interface ScannedOrder {
  id: number;
  kind?: "workOrder" | "invoice";
  orderNumber: string;
  title: string | null;
  customerName: string | null;
  customerPhone: string | null;
  salePrice: string;
  deposit: string | null;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryCost: string | null;
  version: number;
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
        } else if (wo.kind === "invoice") {
          if (wo.status === "CANCELLED" || wo.status === "RETURNED") { notify.warn(`الفاتورة ملغاة أو مرتجعة`); return; }
        }
      }
      const activeCn = (wo as { activeConsignment?: ScannedOrder["activeConsignment"] }).activeConsignment;
      const order: ScannedOrder = {
        id: wo.id, kind: wo.kind ?? "workOrder", orderNumber: wo.orderNumber, title: wo.title,
        customerName: wo.customerName, customerPhone: wo.customerPhone,
        salePrice: wo.salePrice, deposit: wo.deposit,
        deliveryAddress: wo.deliveryAddress, deliveryPhone: wo.deliveryPhone,
        deliveryCost: wo.deliveryCost,
        version: (wo as { version?: number }).version ?? 1,
        activeConsignment: activeCn ?? null,
      };
      if (target === "dispatch") {
        if (activeCn) {
          notify.warn(`الطلب مسند حالياً لـ ${activeCn.partyName ?? "جهة أخرى"} بالإرسالية ${activeCn.consignmentNumber}`);
        }
        setDispatchScanned(order); setDispatchBarcodeInput("");
        setRecipientPhone(wo.deliveryPhone ?? wo.customerPhone ?? "");
        setRecipientName(wo.customerName ?? ""); setDispatchFee(wo.deliveryCost ?? "");
      } else { setReturnScanned(order); setReturnBarcodeInput(""); setReturnReason(""); }
    } catch (e) { notify.err(e, "تعذّر جلب الطلب"); }
  }, [utils]);

  const dispatchEnabled = activeSection === "dispatch" && !!selectedPartyId && !dispatchScanned;
  const returnEnabled = activeSection === "return" && !returnScanned;

  useBarcodeScanner(
    useCallback(async (raw: string) => {
      if (dispatchEnabled) await lookupWorkOrder(raw, "dispatch");
      else if (returnEnabled) await lookupWorkOrder(raw, "return");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dispatchEnabled, returnEnabled, lookupWorkOrder]),
    { enabled: dispatchEnabled || returnEnabled },
  );

  const dispatchBarcodeHook = useBarcodeInput((code) => void lookupWorkOrder(code, "dispatch"));
  const returnBarcodeHook = useBarcodeInput((code) => void lookupWorkOrder(code, "return"));

  useEffect(() => {
    if (dispatchEnabled) dispatchRef.current?.focus();
    else if (returnEnabled) returnRef.current?.focus();
  }, [dispatchEnabled, returnEnabled]);

  const dispatchMut = trpc.delivery.dispatch.useMutation({
    onSuccess: (data) => {
      notify.ok("أُسند #" + (dispatchScanned?.orderNumber ?? ""), "إرسالية " + data.consignmentNumber);
      const chosenParty = (partiesQ.data ?? []).find((p) => p.id === selectedPartyId);
      const cod = round2(D(dispatchScanned?.salePrice ?? "0").minus(D(dispatchScanned?.deposit ?? "0"))).toFixed(2);
      const slip: DispatchSlipData = {
        consignmentNumber: data.consignmentNumber,
        orderNumber: dispatchScanned?.orderNumber ?? "",
        orderKind: dispatchScanned?.kind ?? "workOrder",
        partyName: chosenParty?.name ?? "المندوب",
        recipientName: recipientName || dispatchScanned?.customerName || "",
        recipientPhone: recipientPhone || dispatchScanned?.deliveryPhone || dispatchScanned?.customerPhone || "",
        deliveryAddress: dispatchScanned?.deliveryAddress || "غير محدد",
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
      void utils.workOrders.invalidate(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر الإسناد"),
  });

  const dispatchInvoiceMut = trpc.delivery.dispatchInvoice.useMutation({
    onSuccess: (data) => {
      notify.ok("أُسندت الفاتورة #" + (dispatchScanned?.orderNumber ?? ""), "إرسالية " + data.consignmentNumber);
      const chosenParty = (partiesQ.data ?? []).find((p) => p.id === selectedPartyId);
      const cod = round2(D(dispatchScanned?.salePrice ?? "0").minus(D(dispatchScanned?.deposit ?? "0"))).toFixed(2);
      const slip: DispatchSlipData = {
        consignmentNumber: data.consignmentNumber,
        orderNumber: dispatchScanned?.orderNumber ?? "",
        orderKind: "invoice",
        partyName: chosenParty?.name ?? "المندوب",
        recipientName: recipientName || dispatchScanned?.customerName || "",
        recipientPhone: recipientPhone || dispatchScanned?.deliveryPhone || dispatchScanned?.customerPhone || "",
        deliveryAddress: dispatchScanned?.deliveryAddress || "غير محدد",
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
      void utils.workOrders.invalidate(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر إسناد الفاتورة للتوصيل"),
  });

  const cancelMut = trpc.workOrders.cancel.useMutation({
    onSuccess: () => {
      notify.ok("أُلغي الطلب " + (returnScanned?.orderNumber ?? ""));
      setReturnScanned(null); setReturnBarcodeInput(""); setReturnReason("");
      void utils.workOrders.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر الإلغاء"),
  });

  async function handleDispatch() {
    if (!dispatchScanned || !selectedPartyId) return;
    if (dispatchScanned.activeConsignment) {
      notify.err(
        `لا يمكن إسناد الطلب — مسند حالياً لـ ${dispatchScanned.activeConsignment.partyName ?? "جهة أخرى"} بالإرسالية ${dispatchScanned.activeConsignment.consignmentNumber}`,
        "ألغِ الإرسالية السابقة أولاً لتجنّب تداخل الذمم والطرود.",
      );
      return;
    }
    const fee = D(dispatchFee || "0");
    const docLabel = dispatchScanned.kind === "invoice" ? "الفاتورة" : "الطلب";
    const ok = await confirm({
      title: "تأكيد الإسناد",
      description: [
        `${docLabel}: #${dispatchScanned.orderNumber} — ${dispatchScanned.title ?? ""}`,
        `العميل: ${dispatchScanned.customerName ?? ""} ${dispatchScanned.customerPhone ?? ""}`,
        `العنوان: ${dispatchScanned.deliveryAddress ?? "غير محدد"}`,
        fee.gt(0) ? `أجرة التوصيل: ${fmt(fee.toFixed(2))} د.ع (على الجهة)` : "بدون أجرة",
      ].join("\n"),
      confirmText: "أسند للمندوب",
    });
    if (!ok) return;

    if (dispatchScanned.kind === "invoice") {
      dispatchInvoiceMut.mutate({
        invoiceId: dispatchScanned.id,
        partyId: selectedPartyId,
        deliveryFee: fee.gt(0) ? fee.toFixed(2) : undefined,
        recipientName: recipientName || undefined,
        recipientPhone: recipientPhone || undefined,
        deliveryAddress: dispatchScanned.deliveryAddress || undefined,
        clientRequestId: crypto.randomUUID(),
      });
    } else {
      dispatchMut.mutate({
        workOrderId: dispatchScanned.id, partyId: selectedPartyId,
        deliveryFee: fee.toFixed(2),
        recipientName: recipientName || undefined,
        recipientPhone: recipientPhone || undefined,
        clientRequestId: crypto.randomUUID(),
      });
    }
  }

  async function handleFullReturn() {
    if (!returnScanned || returnReason.trim().length < 3) {
      notify.err("أدخل سبب الإلغاء (٣ أحرف على الأقل)"); return;
    }
    const ok = await confirm({
      variant: "warning", title: "إلغاء الطلب",
      description: [
        `#${returnScanned.orderNumber} — ${returnScanned.customerName ?? ""}`,
        D(returnScanned.deposit ?? "0").gt(0)
          ? `سيُردّ عربون ${fmt(returnScanned.deposit!)} د.ع من الدرج`
          : "لا عربون — إلغاء مباشر",
      ].join("\n"),
      confirmText: "إلغاء الطلب",
    });
    if (!ok) return;
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
                          <p className="text-xs text-green-600">
                            عربون {fmt(dispatchScanned.deposit!)} · متبقٍّ {fmt(round2(D(dispatchScanned.salePrice).minus(D(dispatchScanned.deposit!))).toFixed(2))} على المندوب
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  {dispatchScanned.deliveryAddress && (
                    <div className="flex items-start gap-2 rounded-xl border bg-background p-3">
                      <Truck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">عنوان التوصيل</p>
                        <p className="font-bold">{dispatchScanned.deliveryAddress}</p>
                      </div>
                    </div>
                  )}
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-3">
                    <p className="text-xs font-extrabold text-primary">بيانات الإسناد</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-bold">هاتف المستلم</label>
                        <IntlPhoneInput
                          value={recipientPhone}
                          onChange={setRecipientPhone}
                          placeholder="770 123 4567"
                          className="h-10"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-bold">أجرة التوصيل (د.ع)</label>
                        <MoneyInput
                          value={dispatchFee}
                          onChange={setDispatchFee}
                          placeholder="0"
                          className="h-10"
                          ariaLabel="أجرة التوصيل"
                        />
                      </div>
                    </div>
                  </div>
                  <Button
                    className="w-full py-6 text-base font-extrabold"
                    onClick={() => void handleDispatch()}
                    disabled={dispatchMut.isPending || !!dispatchScanned.activeConsignment}
                  >
                    {dispatchScanned.activeConsignment
                      ? "مسند مسبقاً للإرسالية " + dispatchScanned.activeConsignment.consignmentNumber
                      : dispatchMut.isPending
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

        {activeSection === "collect" && !!branchId && <CollectSection branchId={branchId} shift={shift} />}

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
                      <span className="font-extrabold text-base">فاتورة بيع #{returnScanned.orderNumber}</span>
                      <p className="text-xs text-muted-foreground">العميل: {returnScanned.customerName || "زبون نقدي"}</p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setReturnScanned(null); setReturnBarcodeInput(""); }}>مسح فاتورة أخرى</Button>
                </div>
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
                    <div className="flex items-center gap-2">
                      <Package aria-hidden className="size-5 text-destructive" />
                      <span className="text-lg font-extrabold">#{returnScanned.orderNumber}</span>
                    </div>
                    <p className="mt-0.5 text-sm font-bold">{returnScanned.customerName}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setReturnScanned(null); setReturnBarcodeInput(""); }}>مسح طلب آخر</Button>
                </div>
                <div className="space-y-3 p-4">
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
                    onClick={() => void handleFullReturn()} disabled={cancelMut.isPending || returnReason.trim().length < 3}>
                    {cancelMut.isPending ? L.cancelling : "إلغاء الطلب بالكامل"}
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

// ─── التحصيل والذمم ─────────────────────────────────────────────────────────

function CollectSection({ branchId, shift }: { branchId: number; shift: { id: number } | null }) {
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [settleMode, setSettleMode] = useState<"courier" | "company">("courier");
  const [statementNumber, setStatementNumber] = useState("");
  const [statementDeductions, setStatementDeductions] = useState("");
  const [statementNotes, setStatementNotes] = useState("");
  const [selectedStatementLines, setSelectedStatementLines] = useState<Record<number, boolean>>({});
  const [countedCash, setCountedCash] = useState("");
  const utils = trpc.useUtils();
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { staleTime: 60_000 });
  const obligationsQ = trpc.delivery.obligations.useQuery(undefined, { staleTime: 10_000, refetchInterval: 30_000 });
  const selectedParty = (obligationsQ.data ?? []).find((p: PartyObligation) => p.partyId === selectedPartyId);
  const partyInfo = (partiesQ.data ?? []).find((p) => p.id === selectedPartyId);
  const isCompany = partyInfo?.partyType === "COMPANY";
  const allCollectParties = partiesQ.data ?? [];
  const collectIndividualCouriers = allCollectParties.filter((p) => p.partyType === "INDIVIDUAL");
  const collectCompanyCouriers = allCollectParties.filter((p) => p.partyType === "COMPANY");
  const totalObligation = selectedParty ? Number(selectedParty.codDueTotal ?? 0) : 0;
  const inTransitAmount = selectedParty ? Number(selectedParty.parcelsInTransitAmount ?? 0) : 0;

  // الإرساليات المفتوحة للجهة المختارة — نحتاجها لبناء lines التوريد وتأكيد التسليم
  const openConsQ = trpc.delivery.openConsignments.useQuery(
    { partyId: selectedPartyId ?? 0, limit: 200 },
    { enabled: !!selectedPartyId, staleTime: 10_000, refetchInterval: 30_000 },
  );

  const openRows = openConsQ.data?.rows ?? [];
  const remittableRows = openRows.filter((r) => r.parcelStatus === "DELIVERED");
  const remittableTotal = remittableRows.reduce((sum, r) => {
    const due = Math.max(0, Number(r.codAmount ?? 0) - Number(r.collectedAmount ?? 0) - Number((r as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
    return sum + due;
  }, 0);

  // حسابات وضع كشف الشركة:
  const statementSelectedRows = openRows.filter((r) => selectedStatementLines[r.id]);
  const statementSelectedCodTotal = statementSelectedRows.reduce((sum, r) => {
    const due = Math.max(0, Number(r.codAmount ?? 0) - Number(r.collectedAmount ?? 0) - Number((r as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
    return sum + due;
  }, 0);
  const statementDeductionsNum = Number(statementDeductions || 0);
  const statementNetExpected = Math.max(0, statementSelectedCodTotal - statementDeductionsNum);

  const staffConfirmMut = trpc.delivery.staffConfirm.useMutation({
    onSuccess: () => {
      notify.ok("تم إثبات تسليم الطرد للزبون", "أصبح المبلغ بعهدة المندوب وجاهزاً للتوريد للدرج.");
      void obligationsQ.refetch(); void openConsQ.refetch(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر تأكيد التسليم"),
  });

  const remitMut = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      notify.ok("تم التحصيل والتوريد للدرج — " + r.remittanceNumber, "صاف " + fmt(r.netRemitted) + " د.ع");
      printRemittanceReceipt(selectedParty?.name ?? "المندوب", r);
      setCountedCash("");
      void obligationsQ.refetch(); void openConsQ.refetch(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر التحصيل"),
  });

  const companyStatementMut = trpc.delivery.recordCompanyStatement.useMutation({
    onSuccess: (r) => {
      notify.ok(`سُجِّل كشف الشركة ${r.statementNumber}`, `سند التوريد ${r.remittanceNumber ?? ""} — صافٍ ${fmt(r.netRemitted)} د.ع`);
      const remainingOpen = openRows.filter((row) => !selectedStatementLines[row.id]);
      const remainingOpenAmount = remainingOpen.reduce((sum, row) => sum + Number(row.codAmount || 0), 0);
      printCompanyStatementReceipt({
        companyName: partyInfo?.name ?? selectedParty?.name ?? "شركة التوصيل",
        statementNumber: r.statementNumber,
        remittanceNumber: r.remittanceNumber,
        deliveriesConfirmed: r.deliveriesConfirmed,
        collectedTotal: r.collectedTotal,
        deductionsTotal: statementDeductions || "0",
        netRemitted: r.netRemitted,
        remainingOpenCount: remainingOpen.length,
        remainingOpenAmount: remainingOpenAmount.toFixed(2),
        settledAt: new Date(),
        notes: statementNotes.trim() || undefined,
      });
      setStatementNumber(""); setStatementDeductions(""); setStatementNotes(""); setCountedCash(""); setSelectedStatementLines({});
      void obligationsQ.refetch(); void openConsQ.refetch(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر تسجيل كشف شركة التوصيل"),
  });

  async function handleConfirmDelivery(row: (typeof openRows)[number]) {
    const remaining = Math.max(0, Number(row.codAmount ?? 0) - Number(row.collectedAmount ?? 0) - Number((row as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
    const ok = await confirm({
      title: "تأكيد تسليم الطرد للزبون",
      description: [
        `الإرسالية: ${row.consignmentNumber}`,
        `الفاتورة: #${row.invoiceNumber ?? row.invoiceId ?? ""}`,
        row.customerName ? `الزبون: ${row.customerName}` : "",
        `المبلغ المطلوب: ${fmt(String(remaining))} د.ع`,
        "سيُسجَّل أن المندوب سلّم الطلب للزبون وقبض المبلغ.",
      ].filter(Boolean).join("\n"),
      confirmText: "تأكيد التسليم",
    });
    if (!ok) return;

    staffConfirmMut.mutate({
      consignmentId: row.id,
      collectedAmount: remaining.toFixed(2),
      evidence: "تأكيد موظف الاستقبال / عودة المندوب",
      clientRequestId: crypto.randomUUID(),
    });
  }

  async function handleCollect() {
    if (!selectedPartyId || !countedCash || !shift) return;
    const amount = D(countedCash);
    if (amount.lte(0)) { notify.err("أدخل مبلغاً صحيحاً"); return; }

    if (remittableRows.length === 0) {
      notify.err("لا توجد طرود مسلّمة جاهزة للتوريد — تأكد من تأكيد تسليم الطرود أولاً");
      return;
    }

    // بناء lines تلقائياً: توزيع المبلغ بالترتيب الزمني على الإرساليات المُسلّمة فقط (DELIVERED)
    let remaining = amount;
    const lines: { consignmentId: number; collectedAmount: string }[] = [];
    for (const row of remittableRows) {
      if (remaining.lte(0)) break;
      const due = D(String(Math.max(0, Number(row.codAmount ?? 0) - Number(row.collectedAmount ?? 0) - Number((row as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0))));
      if (due.lte(0)) continue;
      const take = round2(remaining.gte(due) ? due : remaining);
      lines.push({ consignmentId: row.id, collectedAmount: take.toFixed(2) });
      remaining = round2(remaining.minus(take));
    }

    if (lines.length === 0) { notify.err("لا مبالغ مستحقة للتوريد"); return; }

    const ok = await confirm({
      title: "تأكيد التحصيل والتوريد للدرج",
      description: [
        `الجهة: ${selectedParty?.name ?? ""}`,
        `المبلغ المستلَم: ${fmt(amount.toFixed(2))} د.ع`,
        `الذمة المسلّمة الجاهزة للتوريد: ${fmt(String(remittableTotal))} د.ع`,
        `عدد الإرساليات المُسوَّاة: ${lines.length}`,
        amount.lt(D(String(remittableTotal)))
          ? `تسوية جزئية — يبقى ${fmt(round2(D(String(remittableTotal)).minus(amount)).toFixed(2))} د.ع نقد بعهدة الجهة`
          : "تسوية كاملة للطرود المسلّمة — الأجرة معزولة تلقائياً",
      ].join("\n"),
      confirmText: "قبض وتوريد للدرج",
    });
    if (!ok) return;
    remitMut.mutate({ partyId: selectedPartyId, lines, countedCash: amount.toFixed(2), clientRequestId: crypto.randomUUID() });
  }

  async function handleCompanyStatementCollect() {
    if (!selectedPartyId || !shift) return;
    if (!statementNumber.trim()) {
      notify.err("يرجى إدخال رقم كشف الشركة");
      return;
    }
    const lines = statementSelectedRows.map((r) => {
      const due = Math.max(0, Number(r.codAmount ?? 0) - Number(r.collectedAmount ?? 0) - Number((r as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0));
      return { consignmentId: r.id, collectedAmount: due.toFixed(2) };
    });
    if (lines.length === 0) {
      notify.err("يرجى تحديد طرد واحد على الأقل تم تسليمه في الكشف");
      return;
    }
    const cash = D(countedCash || String(statementNetExpected));
    if (cash.lte(0) && statementNetExpected > 0) {
      notify.err("أدخل المبلغ الصافي المستلم");
      return;
    }
    const ok = await confirm({
      title: "تأكيد تسوية كشف شركة التوصيل",
      description: [
        `الشركة: ${partyInfo?.name ?? ""}`,
        `رقم الكشف: ${statementNumber}`,
        `عدد الطرود المسلّمة بالكشف: ${lines.length}`,
        `إجمالي مبالغ الطرود (COD): ${fmt(String(statementSelectedCodTotal))} د.ع`,
        statementDeductionsNum > 0 ? `استقطاعات أجور الشركة: - ${fmt(String(statementDeductionsNum))} د.ع` : "",
        `صافي النقد المورّد للدرج: ${fmt(cash.toFixed(2))} د.ع`,
        openRows.length - lines.length > 0 ? `يبقى معلقاً بذمة الشركة: ${openRows.length - lines.length} طرود` : "تسوية شاملة لكل الطرود",
      ].filter(Boolean).join("\n"),
      confirmText: "تأكيد التسوية والقبض",
    });
    if (!ok) return;

    companyStatementMut.mutate({
      partyId: selectedPartyId,
      branchId,
      shiftType: "RECEPTION",
      statementNumber: statementNumber.trim(),
      statementDate: new Date().toISOString().slice(0, 10),
      deductionsTotal: statementDeductionsNum > 0 ? statementDeductionsNum.toFixed(2) : undefined,
      notes: statementNotes.trim() || undefined,
      lines,
      countedCash: cash.toFixed(2),
      clientRequestId: crypto.randomUUID(),
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="gap-0 p-4">
        <h2 className="mb-3 font-extrabold flex items-center gap-2">
          <BarChart3 aria-hidden className="size-5" /> تحصيل وذمم المناديب والشركات
        </h2>
        <AppSelect
          value={selectedPartyId ? String(selectedPartyId) : ""}
          onValueChange={(v) => {
            const nextId = v ? Number(v) : null;
            setSelectedPartyId(nextId);
            setCountedCash("");
            setSelectedStatementLines({});
            const info = (partiesQ.data ?? []).find((p) => p.id === nextId);
            if (info?.partyType === "COMPANY") setSettleMode("company");
            else setSettleMode("courier");
          }}
          className="h-12 w-full text-base font-bold"
        >
          <option value="">— اختر المندوب أو شركة التوصيل —</option>
          {collectIndividualCouriers.length > 0 && (
            <optgroup label="── المناديب الداخليين (سائقون بعُهدة نقدية) ──">
              {collectIndividualCouriers.map((p) => {
                const bal = Number((obligationsQ.data ?? []).find((o: PartyObligation) => o.partyId === p.id)?.codDueTotal ?? 0);
                return <option key={p.id} value={String(p.id)}>{p.name} (مندوب){bal > 0 ? ` — عهدة: ${fmt(String(bal))} د.ع` : ""}</option>;
              })}
            </optgroup>
          )}
          {collectCompanyCouriers.length > 0 && (
            <optgroup label="── شركات ومكاتب التوصيل (مطابقة كشوفات دورية) ──">
              {collectCompanyCouriers.map((p) => {
                const bal = Number((obligationsQ.data ?? []).find((o: PartyObligation) => o.partyId === p.id)?.codDueTotal ?? 0);
                return <option key={p.id} value={String(p.id)}>{p.name} (شركة){bal > 0 ? ` — رصيد معلق: ${fmt(String(bal))} د.ع` : ""}</option>;
              })}
            </optgroup>
          )}
        </AppSelect>

        {selectedPartyId && isCompany && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-blue-700">
              <Building2 className="size-4 shrink-0" />
              <span>نظام شركة التوصيل: مطابقة كشف الطلبات واستقطاعات الأجور وتوريد الصافي</span>
            </div>
            <Badge variant="outline" className="border-blue-500 text-blue-700 font-bold shrink-0">
              كشف شركة
            </Badge>
          </div>
        )}
        {selectedPartyId && !isCompany && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--sem-pos)]">
              <User className="size-4 shrink-0" />
              <span>نظام المندوب الفردي: عهدة نقدية ميدانية وتوريد مباشر للدرج (الأجرة معزولة)</span>
            </div>
            <Badge variant="outline" className="border-[var(--sem-pos)] text-[var(--sem-pos)] font-bold shrink-0">
              عهدة نقدية
            </Badge>
          </div>
        )}
      </Card>

      {selectedPartyId && (
        <Card className="gap-0 p-4 space-y-4">
          {obligationsQ.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">جارٍ تحميل الذمة…</div>
          ) : (
            <>
              {/* ملخص الذمة */}
              <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold">إجمالي الذمة المسندة (COD)</span>
                    <p className="text-xs text-muted-foreground mt-0.5">مجموع قيمة الإرساليات غير المُسدَّدة — الأجرة معزولة</p>
                  </div>
                  <span className={cn("text-xl font-extrabold tabular-nums", totalObligation > 0 ? "text-destructive" : "text-[var(--sem-pos)]")}>
                    {fmt(String(totalObligation))} د.ع
                  </span>
                </div>

                {totalObligation > 0 && (
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t text-xs">
                    <div className="rounded-lg border bg-background/60 p-2.5">
                      <div className="text-muted-foreground">طرود في الطريق</div>
                      <div className="text-base font-extrabold tabular-nums text-foreground mt-0.5">
                        {fmt(String(inTransitAmount))} د.ع
                      </div>
                      <div className="text-[11px] text-muted-foreground">بعهدة الجهة للتسليم</div>
                    </div>
                    <div className="rounded-lg border bg-background/60 p-2.5">
                      <div className="text-muted-foreground">نقد جاهز للتوريد</div>
                      <div className="text-base font-extrabold tabular-nums text-[var(--sem-pos)] mt-0.5">
                        {fmt(String(remittableTotal))} د.ع
                      </div>
                      <div className="text-[11px] text-muted-foreground">سُلِّم للزبون بانتظار التوريد</div>
                    </div>
                  </div>
                )}
              </div>

              {/* ─── وضع كشف شركة التوصيل ─── */}
              {settleMode === "company" ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="size-4 text-primary" />
                      <span className="text-sm font-extrabold text-primary">بيانات كشف شركة التوصيل</span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-bold">رقم الكشف المسلَّم من الشركة <span className="text-destructive">*</span></label>
                        <Input
                          value={statementNumber}
                          onChange={(e) => setStatementNumber(e.target.value)}
                          placeholder="مثال: STMT-2026-09"
                          className="h-10 bg-background font-mono font-bold"
                          dir="ltr"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-bold">استقطاعات أجور الشركة (د.ع)</label>
                        <MoneyInput
                          value={statementDeductions}
                          onChange={setStatementDeductions}
                          placeholder="0"
                          className="h-10 bg-background"
                          ariaLabel="استقطاعات أجور الشركة"
                        />
                      </div>
                    </div>
                  </div>

                  {/* قائمة الطرود مع إمكانية التحديد بالمطابقة */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-muted-foreground">
                        الطرود المفتوحة للشركة ({openRows.length})
                      </h3>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 font-bold"
                          onClick={() => {
                            const next: Record<number, boolean> = {};
                            openRows.forEach((r) => { next[r.id] = true; });
                            setSelectedStatementLines(next);
                          }}
                        >
                          تحديد الكل
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 font-bold text-muted-foreground"
                          onClick={() => setSelectedStatementLines({})}
                        >
                          إلغاء التحديد
                        </Button>
                      </div>
                    </div>

                    {openRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد طرود مفتوحة لهذه الشركة
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {openRows.map((row) => {
                          const cod = Number(row.codAmount ?? 0);
                          const isSelected = !!selectedStatementLines[row.id];
                          return (
                            <div
                              key={row.id}
                              onClick={() => setSelectedStatementLines((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                              className={cn(
                                "flex items-center justify-between gap-3 rounded-xl border p-3 cursor-pointer transition-colors shadow-xs",
                                isSelected ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/20",
                              )}
                            >
                              <div className="flex items-center gap-3">
                                <div className="shrink-0 text-primary">
                                  {isSelected ? <CheckSquare className="size-5" /> : <Square className="size-5 text-muted-foreground" />}
                                </div>
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-extrabold text-sm">فاتورة #{row.invoiceNumber ?? row.invoiceId}</span>
                                    <span className="text-xs text-muted-foreground font-mono">{row.consignmentNumber}</span>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {row.customerName && <span>الزبون: <strong className="text-foreground">{row.customerName}</strong></span>}
                                  </div>
                                </div>
                              </div>
                              <div className="text-end">
                                <span className="text-xs text-muted-foreground block">المطلوب (COD)</span>
                                <span className="font-extrabold text-sm tabular-nums text-foreground">{fmt(String(cod))} د.ع</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* حسابات التوريد والتأكيد */}
                  {shift && statementSelectedRows.length > 0 && (
                    <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/20 p-4 space-y-3">
                      <p className="text-sm font-extrabold text-[var(--sem-pos)]">مطابقة الكشف والقبض في الدرج</p>
                      <div className="grid grid-cols-3 gap-2 text-xs border-b border-[var(--sem-pos)]/20 pb-3">
                        <div>
                          <span className="text-muted-foreground block">طرود الكشف المسلّمة</span>
                          <span className="font-extrabold text-sm">{statementSelectedRows.length} طرود</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">مجموع الـ COD</span>
                          <span className="font-extrabold text-sm">{fmt(String(statementSelectedCodTotal))} د.ع</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">صافي النقد المتوقع</span>
                          <span className="font-extrabold text-sm text-[var(--sem-pos)]">{fmt(String(statementNetExpected))} د.ع</span>
                        </div>
                      </div>

                      {openRows.length - statementSelectedRows.length > 0 && (
                        <p className="text-xs text-[var(--sem-warn)] font-bold">
                          يبقى معلقاً بذمة الشركة: {openRows.length - statementSelectedRows.length} طرود (لم تُذكر بالكشف أو مؤجلة)
                        </p>
                      )}

                      <div className="flex gap-2 pt-1">
                        <MoneyInput
                          value={countedCash}
                          onChange={setCountedCash}
                          placeholder={"المبلغ الصافي المستلم (المتوقع: " + fmt(String(statementNetExpected)) + ")"}
                          className="flex-1 h-11 text-base font-bold bg-background"
                          ariaLabel="المبلغ الصافي المستلم"
                        />
                        <Button
                          className="bg-[var(--sem-pos)] hover:bg-[var(--sem-pos)]/90 text-background px-6 font-bold"
                          disabled={companyStatementMut.isPending || !statementNumber.trim()}
                          onClick={() => void handleCompanyStatementCollect()}
                        >
                          {companyStatementMut.isPending ? "جارٍ التوريد…" : "تسوية الكشف وتوريد النقد"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* ─── وضع تسوية المندوب الفردي التقليدي ─── */
                <>
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold text-muted-foreground flex items-center justify-between">
                      <span>الطرود والإرساليات المسندة ({openRows.length})</span>
                      {inTransitAmount > 0 && (
                        <span className="font-normal text-[var(--sem-warn)]">
                          {openRows.filter((r) => r.parcelStatus !== "DELIVERED").length} طرود في الطريق
                        </span>
                      )}
                    </h3>
                    {openConsQ.isLoading ? (
                      <div className="py-4 text-center text-xs text-muted-foreground">جارٍ تحميل الطرود…</div>
                    ) : openRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد طرود مفتوحة
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {openRows.map((row) => {
                          const cod = Number(row.codAmount ?? 0);
                          const isDelivered = row.parcelStatus === "DELIVERED";
                          const isInTransit = !isDelivered;
                          return (
                            <div key={row.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border bg-background p-3 shadow-xs">
                              <div className="min-w-0 space-y-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-extrabold text-sm">
                                    فاتورة #{row.invoiceNumber ?? row.invoiceId}
                                  </span>
                                  <span className="text-xs text-muted-foreground font-mono">
                                    {row.consignmentNumber}
                                  </span>
                                  {isInTransit && (
                                    <Badge variant="secondary" className="text-[11px] font-bold">
                                      في الطريق
                                    </Badge>
                                  )}
                                  {isDelivered && (
                                    <Badge className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-transparent text-[11px] font-bold">
                                      سلم — جاهز للتوريد
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                                  {row.customerName && <span>الزبون: <strong className="text-foreground">{row.customerName}</strong></span>}
                                  <span>المطلوب (COD): <strong className="text-foreground tabular-nums">{fmt(String(cod))} د.ع</strong></span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                                {isInTransit && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="font-bold text-xs h-8"
                                    disabled={staffConfirmMut.isPending}
                                    onClick={() => void handleConfirmDelivery(row)}
                                  >
                                    <CheckCircle2 aria-hidden className="size-3.5 ms-1 text-[var(--sem-pos)]" />
                                    تأكيد التسليم
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* قسم القبض والتوريد للدرج للمندوب */}
                  {shift && remittableTotal > 0 && (
                    <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/20 p-4 space-y-3">
                      <p className="text-sm font-extrabold text-[var(--sem-pos)]">قبض وتوريد النقد للدرج</p>
                      <p className="text-xs text-muted-foreground">توريد المبالغ المحصلة من الطرود المسلمة للوردية الحالية — الأجرة معزولة</p>
                      <div className="flex gap-2">
                        <MoneyInput
                          value={countedCash}
                          onChange={setCountedCash}
                          placeholder={"المبلغ المستلَم (الكامل: " + fmt(String(remittableTotal)) + ")"}
                          className="flex-1 h-11 text-base font-bold bg-background"
                          ariaLabel="المبلغ المستلَم"
                        />
                        <Button
                          className="bg-[var(--sem-pos)] hover:bg-[var(--sem-pos)]/90 text-background px-6 font-bold"
                          disabled={!countedCash || remitMut.isPending}
                          onClick={() => void handleCollect()}
                        >
                          {remitMut.isPending ? "…" : "قبض وتوريد"}
                        </Button>
                      </div>
                      {countedCash && D(String(remittableTotal)).gt(0) && D(countedCash).lt(D(String(remittableTotal))) && (
                        <p className="text-xs text-[var(--sem-warn)] font-bold">
                          تسوية جزئية — يبقى {fmt(round2(D(String(remittableTotal)).minus(D(countedCash))).toFixed(2))} د.ع بعهدة الجهة
                        </p>
                      )}
                    </div>
                  )}

                  {shift && remittableTotal === 0 && totalObligation > 0 && (
                    <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
                      <div className="flex items-center gap-2 font-bold text-xs text-foreground">
                        <Clock aria-hidden className="size-4 text-muted-foreground" />
                        <span>الطرود لا تزال في الطريق مع المندوب</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        إجمالي مبالغ الطرود ({fmt(String(totalObligation))} د.ع) لا تزال بعهدة المندوب في الميدان.
                        عند عودة المندوب وتسليم الطلب، اضغط <strong>«تأكيد التسليم»</strong> على الطرد أعلاه، وسيظهر زر القبض والتوريد للدرج فوراً مع طباعة الإيصال.
                      </p>
                    </div>
                  )}
                </>
              )}

              {totalObligation === 0 && (
                <div className="rounded-xl border bg-[var(--sem-pos-bg)]/20 p-4 text-center text-[var(--sem-pos)] font-bold">
                  لا ذمة على هذه الجهة
                </div>
              )}

              {!shift && <p className="text-sm text-destructive text-center">افتح وردية استقبال لتسجيل التحصيل</p>}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
