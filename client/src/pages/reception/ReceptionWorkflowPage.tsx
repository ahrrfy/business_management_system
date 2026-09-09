/**
 * DeliveryWorkflowPage - شاشة الإسناد والتوصيل /reception/workflow
 * ثلاثة أقسام: الإسناد، التحصيل والذمم، الإلغاء والمرتجع
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Link } from "wouter";
import type { RouterOutputs } from "@/lib/trpc";
import { ArrowRight, BadgeDollarSign, Ban, BarChart3, Package, RefreshCcw, ScanLine, Truck, User, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { cn } from "@/lib/utils";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { parseScan } from "@/lib/scanRouter";

type Section = "dispatch" | "collect" | "return";
type PartyObligation = RouterOutputs["delivery"]["obligations"][number];

interface ScannedOrder {
  id: number;
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
}

export default function DeliveryWorkflowPage() {
  const [activeSection, setActiveSection] = useState<Section>("dispatch");
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
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
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { enabled: activeSection === "dispatch", staleTime: 60_000 });

  const lookupWorkOrder = useCallback(async (raw: string, target: "dispatch" | "return") => {
    const r = parseScan(raw);
    const orderNumber = r.type === "workOrder" ? r.number : raw.trim();
    if (!orderNumber) return;
    try {
      const wo = await utils.workOrders.getByNumber.fetch({ orderNumber });
      if (!wo) { notify.err(`طلب غير موجود: ${orderNumber}`); return; }
      if (target === "dispatch") {
        if (wo.status === "DELIVERED") { notify.info(`الطلب ${wo.orderNumber} مُسلَّم`); return; }
        if (wo.status !== "READY") { notify.warn(`الطلب غير جاهز (حالته: ${wo.status})`); return; }
      }
      const order: ScannedOrder = {
        id: wo.id, orderNumber: wo.orderNumber, title: wo.title,
        customerName: wo.customerName, customerPhone: wo.customerPhone,
        salePrice: wo.salePrice, deposit: wo.deposit,
        deliveryAddress: wo.deliveryAddress, deliveryPhone: wo.deliveryPhone,
        deliveryCost: wo.deliveryCost,
        version: (wo as { version?: number }).version ?? 1,
      };
      if (target === "dispatch") {
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

      setDispatchScanned(null); setDispatchBarcodeInput("");
      setRecipientPhone(""); setRecipientName(""); setDispatchFee("");
      void utils.workOrders.invalidate(); void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر الإسناد"),
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
    const fee = D(dispatchFee || "0");
    const ok = await confirm({
      title: "تأكيد الإسناد",
      description: [
        `الطلب: #${dispatchScanned.orderNumber} — ${dispatchScanned.title ?? ""}`,
        `العميل: ${dispatchScanned.customerName ?? ""} ${dispatchScanned.customerPhone ?? ""}`,
        `العنوان: ${dispatchScanned.deliveryAddress ?? "غير محدد"}`,
        fee.gt(0) ? `أجرة التوصيل: ${fmt(fee.toFixed(2))} د.ع (على الجهة)` : "بدون أجرة",
      ].join("\n"),
      confirmText: "أسند للمندوب",
    });
    if (!ok) return;
    dispatchMut.mutate({
      workOrderId: dispatchScanned.id, partyId: selectedPartyId,
      deliveryFee: fee.toFixed(2),
      recipientName: recipientName || undefined,
      recipientPhone: recipientPhone || undefined,
      clientRequestId: crypto.randomUUID(),
    });
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
    cancelMut.mutate({ workOrderId: returnScanned.id, expectedVersion: returnScanned.version, reason: returnReason.trim() });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" dir="rtl">
      <div className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-3">
        <Link href="/pos?mode=RECEPTION" className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold text-muted-foreground hover:bg-muted">
          <ArrowRight aria-hidden className="size-3.5" /> الاستقبال
        </Link>
        <h1 className="text-base font-extrabold">التوصيل والإسناد</h1>
        <div className="ms-auto">
          {shift
            ? <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">وردية #{shift.id}</span>
            : <span className="rounded-full bg-destructive/10 px-3 py-1 text-xs font-bold text-destructive">لا وردية</span>}
        </div>
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
            <div className="rounded-2xl border bg-card p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-full bg-primary text-[11px] font-black text-primary-foreground">١</span>
                <h2 className="font-extrabold">اختر جهة التوصيل</h2>
              </div>
              <AppSelect value={selectedPartyId ? String(selectedPartyId) : ""}
                onValueChange={(v) => { setSelectedPartyId(v ? Number(v) : null); setDispatchScanned(null); setDispatchBarcodeInput(""); }}
                className="h-12 w-full text-base font-bold">
                <option value="">— اختر المندوب أو شركة التوصيل —</option>
                {(partiesQ.data ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
              </AppSelect>
            </div>

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
              <div className="rounded-2xl border bg-card shadow-sm">
                <div className="flex items-start justify-between border-b bg-muted/30 p-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Package aria-hidden className="size-5 text-primary" />
                      <span className="text-lg font-extrabold">#{dispatchScanned.orderNumber}</span>
                      <Badge variant="outline" className="border-green-500 text-green-600">جاهز</Badge>
                    </div>
                    {dispatchScanned.title && <p className="mt-1 text-sm text-muted-foreground">{dispatchScanned.title}</p>}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setDispatchScanned(null); setDispatchBarcodeInput(""); }}>← مسح آخر</Button>
                </div>
                <div className="space-y-3 p-4">
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
                  <Button className="w-full py-6 text-base font-extrabold" onClick={() => void handleDispatch()} disabled={dispatchMut.isPending}>
                    {dispatchMut.isPending ? "جارٍ الإسناد…" : D(dispatchFee || "0").gt(0) ? "أسند للمندوب · أجرة " + fmt(dispatchFee) + " د.ع" : "أسند للمندوب"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeSection === "collect" && !!branchId && <CollectSection branchId={branchId} shift={shift} />}




        {activeSection === "return" && (
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="rounded-2xl border bg-card p-4">
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
            </div>

            {!returnScanned && (
              <div className="rounded-2xl border-2 border-dashed border-destructive/40 bg-destructive/5 p-6 text-center">
                <ScanLine aria-hidden className="mx-auto size-10 text-destructive/60" />
                <p className="mt-2 text-base font-extrabold text-destructive">امسح باركود الطلب</p>
                <div className="mt-4 flex gap-2">
                  <Input ref={returnRef} value={returnBarcodeInput}
                    onChange={(e) => setReturnBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      returnBarcodeHook.handleKeyDown(e, setReturnBarcodeInput);
                      if (!e.defaultPrevented && e.key === "Enter" && returnBarcodeInput.trim())
                        void lookupWorkOrder(returnBarcodeInput.trim(), "return");
                    }}
                    placeholder="رقم الطلب (Enter)" className="flex-1 text-center font-bold" dir="ltr" />
                  <Button variant="outline" onClick={() => void lookupWorkOrder(returnBarcodeInput.trim(), "return")} disabled={!returnBarcodeInput.trim()}>بحث</Button>
                </div>
              </div>
            )}

            {returnScanned && returnType === "FULL" && (
              <div className="rounded-2xl border bg-card shadow-sm">
                <div className="flex items-start justify-between border-b bg-destructive/10 p-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Package aria-hidden className="size-5 text-destructive" />
                      <span className="text-lg font-extrabold">#{returnScanned.orderNumber}</span>
                    </div>
                    <p className="mt-0.5 text-sm font-bold">{returnScanned.customerName}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setReturnScanned(null); setReturnBarcodeInput(""); }}>← مسح آخر</Button>
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
                      <li>إلغاء الطلب نهائياً</li>
                      {D(returnScanned.deposit ?? "0").gt(0) && <li>ردّ {fmt(returnScanned.deposit!)} د.ع من درج الوردية</li>}
                      <li>إعادة المواد والمخزون للرصيد</li>
                    </ul>
                  </div>
                  <Button variant="destructive" className="w-full py-6 text-base font-extrabold"
                    onClick={() => void handleFullReturn()} disabled={cancelMut.isPending || returnReason.trim().length < 3}>
                    {cancelMut.isPending ? "جارٍ الإلغاء…" : "إلغاء الطلب بالكامل"}
                  </Button>
                </div>
              </div>
            )}

            {returnScanned && returnType === "PARTIAL" && (
              <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-center">
                <RefreshCcw aria-hidden className="mx-auto size-10 text-amber-500" />
                <p className="mt-3 text-base font-bold text-amber-700">المرتجع الجزئي — قريباً</p>
                <p className="mt-1 text-sm text-muted-foreground">يُمكّن اختيار البنود وتحديد الكمية والمبلغ المُسترجَع</p>
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
  const [countedCash, setCountedCash] = useState("");
  const utils = trpc.useUtils();
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { staleTime: 60_000 });
  const obligationsQ = trpc.delivery.obligations.useQuery(undefined, { staleTime: 30_000, refetchInterval: 60_000 });
  const selectedParty = (obligationsQ.data ?? []).find((p: PartyObligation) => p.partyId === selectedPartyId);
  const totalObligation = selectedParty ? Number((selectedParty as { codBalance?: string | number }).codBalance ?? 0) : 0;

  // الإرساليات المفتوحة للجهة المختارة — نحتاجها لبناء lines التوريد
  const openConsQ = trpc.delivery.openConsignments.useQuery(
    { partyId: selectedPartyId ?? 0, limit: 200 },
    { enabled: !!selectedPartyId, staleTime: 30_000 },
  );

  const remitMut = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      notify.ok("تمّ التحصيل — " + r.remittanceNumber, "صافٍ " + fmt(r.netRemitted) + " د.ع");

      setCountedCash("");
      void obligationsQ.refetch();
      void utils.delivery.invalidate();
    },
    onError: (e) => notify.err(e, "تعذّر التحصيل"),
  });

  async function handleCollect() {
    if (!selectedPartyId || !countedCash || !shift) return;
    const amount = D(countedCash);
    if (amount.lte(0)) { notify.err("أدخل مبلغاً صحيحاً"); return; }

    const openRows = openConsQ.data?.rows ?? [];
    if (openRows.length === 0) { notify.err("لا إرساليات مفتوحة — لا يوجد ما يُسوَّى"); return; }

    // بناء lines تلقائياً: توزيع المبلغ بالترتيب الزمني حتى ينتهي المبلغ
    let remaining = amount;
    const lines: { consignmentId: number; collectedAmount: string }[] = [];
    for (const row of openRows) {
      if (remaining.lte(0)) break;
      const due = D(String(Number(row.codAmount ?? 0) - Number(row.collectedAmount ?? 0) - Number((row as { counterSettledAmount?: string | number }).counterSettledAmount ?? 0)));
      if (due.lte(0)) continue;
      const take = round2(remaining.gte(due) ? due : remaining);
      lines.push({ consignmentId: row.id, collectedAmount: take.toFixed(2) });
      remaining = round2(remaining.minus(take));
    }

    if (lines.length === 0) { notify.err("لا مبالغ مستحقة للتوريد"); return; }

    const ok = await confirm({
      title: "تأكيد التحصيل",
      description: [
        `الجهة: ${selectedParty?.name ?? ""}`,
        `المبلغ المستلَم: ${fmt(amount.toFixed(2))} د.ع`,
        `الذمة الكلية: ${fmt(String(totalObligation))} د.ع`,
        `عدد الإرساليات المُسوَّاة: ${lines.length}`,
        amount.lt(D(String(totalObligation)))
          ? `تسوية جزئية — يبقى ${fmt(round2(D(String(totalObligation)).minus(amount)).toFixed(2))} د.ع`
          : "تسوية كاملة للذمة — الأجرة معزولة تلقائياً",
      ].join("\n"),
      confirmText: "قبض وتسوية",
    });
    if (!ok) return;
    remitMut.mutate({ partyId: selectedPartyId, lines, countedCash: amount.toFixed(2), clientRequestId: crypto.randomUUID() });
  }



  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-2xl border bg-card p-4">
        <h2 className="mb-3 font-extrabold flex items-center gap-2">
          <BarChart3 aria-hidden className="size-5" /> تحصيل وذمم المناديب
        </h2>
        <AppSelect value={selectedPartyId ? String(selectedPartyId) : ""}
          onValueChange={(v) => { setSelectedPartyId(v ? Number(v) : null); setCountedCash(""); }}
          className="h-12 w-full text-base">
          <option value="">— اختر المندوب أو شركة التوصيل —</option>
          {(partiesQ.data ?? []).map((p) => {
            const ob = (obligationsQ.data ?? []).find((ob: PartyObligation) => ob.partyId === p.id);
            const bal = Number((ob as { codBalance?: string | number } | undefined)?.codBalance ?? 0);
            return (
              <option key={p.id} value={String(p.id)}>
                {p.name}{bal > 0 ? ` — ذمة: ${fmt(String(bal))} د.ع` : ""}
              </option>
            );
          })}
        </AppSelect>
      </div>

      {selectedPartyId && (
        <div className="rounded-2xl border bg-card p-4 space-y-3">
          {obligationsQ.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">جارٍ تحميل الذمة…</div>
          ) : (
            <>
              <div className="rounded-xl border bg-muted/30 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold">الذمة التراكمية</span>
                    <p className="text-xs text-muted-foreground mt-0.5">مجموع قيمة الإرساليات غير المُسدَّدة — الأجرة معزولة</p>
                  </div>
                  <span className={cn("text-xl font-extrabold tabular-nums", totalObligation > 0 ? "text-destructive" : "text-green-600")}>
                    {fmt(String(totalObligation))} د.ع
                  </span>
                </div>
              </div>

              {shift && totalObligation > 0 && (
                <div className="rounded-xl border border-green-300 bg-green-50 p-4 space-y-3">
                  <p className="text-sm font-extrabold text-green-700">قبض من الجهة</p>
                  <p className="text-xs text-muted-foreground">النظام يُسوّي الإرساليات تلقائياً — الأجرة معزولة</p>
                  <div className="flex gap-2">
                    <MoneyInput
                      value={countedCash}
                      onChange={setCountedCash}
                      placeholder={"المبلغ المستلَم (الكامل: " + fmt(String(totalObligation)) + ")"}
                      className="flex-1 h-11 text-base font-bold"
                      ariaLabel="المبلغ المستلَم"
                    />
                    <Button className="bg-green-600 hover:bg-green-700 text-white px-6"
                      disabled={!countedCash || remitMut.isPending} onClick={() => void handleCollect()}>
                      {remitMut.isPending ? "…" : "قبض"}
                    </Button>
                  </div>
                  {countedCash && D(String(totalObligation)).gt(0) && D(countedCash).lt(D(String(totalObligation))) && (
                    <p className="text-xs text-amber-600 font-bold">
                      تسوية جزئية — يبقى {fmt(round2(D(String(totalObligation)).minus(D(countedCash))).toFixed(2))} د.ع على الجهة
                    </p>
                  )}
                </div>
              )}
              {totalObligation === 0 && <div className="rounded-xl border bg-green-50 p-4 text-center text-green-700 font-bold">لا ذمة على هذه الجهة</div>}

              {!shift && <p className="text-sm text-destructive text-center">افتح وردية استقبال لتسجيل التحصيل</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
