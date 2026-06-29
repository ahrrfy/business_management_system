import { useMemo, useState } from "react";
import { AlertTriangle, Check, RotateCcw, Truck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CashCounter } from "@/components/CashCounter";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { printDoc } from "@/lib/printing/print";

/**
 * إدارة التوصيل (COD) — شاشة مكرّسة (D5):
 *  - «جاهز للإرسال»: تعيين جهة توصيل + أجرة لطلبٍ جاهز ⇒ إصدار فاتورة COD + عهدة.
 *  - «تسوية المناديب»: قبض تحصيلات الجهة، خصم الأجرة، توريد الصافي (D8) — كم للمكتبة وكم للجهة.
 */

type ReadyOrder = RouterOutputs["delivery"]["readyForDispatch"][number];
type Party = RouterOutputs["delivery"]["listParties"][number];
type OpenConsignment = RouterOutputs["delivery"]["openConsignments"][number];

/** بوليصة توصيل حرارية (جسر/WebUSB/متصفح) عند الإرسال. */
function printDeliverySlip(order: ReadyOrder, party: Party | undefined, r: { consignmentNumber: string; invoiceNumber: string; codAmount: string; deliveryFee: string }) {
  void printDoc({
    kind: "receipt",
    title: "بوليصة توصيل",
    subtitle: r.consignmentNumber,
    meta: [
      `الطلب: ${order.orderNumber}`,
      `الجهة: ${party?.name ?? ""}`,
      `المستلم: ${order.customerName ?? "—"}`,
      order.deliveryAddress ? `العنوان: ${order.deliveryAddress}` : "",
      `الفاتورة: ${r.invoiceNumber}`,
    ].filter(Boolean),
    totals: [
      { label: "مبلغ التحصيل (COD)", value: `${fmt(r.codAmount)} د.ع` },
      { label: "أجرة التوصيل", value: `${fmt(r.deliveryFee)} د.ع` },
    ],
    footer: "يُسلَّم المبلغ للمكتبة عند التوريد",
    barcodeSet: { barcode128: r.consignmentNumber, qrPayload: r.consignmentNumber, displayLabel: r.consignmentNumber },
  });
}
/** إيصال تسوية توصيل حراري عند التوريد. */
function printRemittanceReceipt(partyName: string, r: { remittanceNumber: string; collectedTotal: string; feesTotal: string; netRemitted: string; shortfallTotal: string }) {
  void printDoc({
    kind: "zreport",
    title: "إيصال تسوية توصيل",
    subtitle: r.remittanceNumber,
    meta: [`الجهة: ${partyName}`, new Date().toLocaleString("ar-IQ-u-nu-latn")],
    totals: [
      { label: "إجمالي التحصيل", value: `${fmt(r.collectedTotal)} د.ع` },
      { label: "مستحقات الجهة (الأجور)", value: `${fmt(r.feesTotal)} د.ع` },
      { label: "صافٍ للمكتبة", value: `${fmt(r.netRemitted)} د.ع` },
      { label: "عجز يبقى عهدة", value: `${fmt(r.shortfallTotal)} د.ع` },
    ],
    footer: "تسوية تحصيلات المندوب",
  });
}

const tabBtn = (active: boolean) =>
  cn(
    "rounded-lg px-4 py-2 text-sm font-bold transition-colors",
    active ? "bg-primary text-primary-foreground" : "border bg-card hover:bg-muted/60",
  );

export default function DeliveryHub() {
  const [tab, setTab] = useState<"dispatch" | "settle">("dispatch");
  return (
    <div className="space-y-5 p-4 md:p-6" dir="rtl">
      <PageHeader
        title="إدارة التوصيل"
        description="تعيين المناديب للطلبات الجاهزة (COD) وتسوية تحصيلاتهم بخصم الأجرة وتوريد الصافي."
        icon={<Truck className="size-6 text-primary" aria-hidden />}
        actions={
          <Button variant="outline" asChild>
            <a href="/delivery/parties">جهات التوصيل وذممها</a>
          </Button>
        }
      />
      <div className="flex gap-2">
        <button className={tabBtn(tab === "dispatch")} onClick={() => setTab("dispatch")}>جاهز للإرسال</button>
        <button className={tabBtn(tab === "settle")} onClick={() => setTab("settle")}>تسوية المناديب</button>
      </div>
      {tab === "dispatch" ? <DispatchTab /> : <SettleTab />}
    </div>
  );
}

// ───────────────────────── تبويب: جاهز للإرسال ─────────────────────────
function DispatchTab() {
  const utils = trpc.useUtils();
  const ready = trpc.delivery.readyForDispatch.useQuery();
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const [target, setTarget] = useState<ReadyOrder | null>(null);

  const dispatch = trpc.delivery.dispatch.useMutation({
    onSuccess: (r) => {
      notify.ok("أُرسل عبر المندوب", `إرسالية ${r.consignmentNumber} — COD ${fmt(r.codAmount)} د.ع`);
      setTarget(null);
      utils.delivery.readyForDispatch.invalidate();
      utils.delivery.listParties.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  if (ready.isError) return <ErrorState onRetry={() => ready.refetch()} />;
  const rows = ready.data ?? [];

  return (
    <div className="rounded-xl border bg-card">
      <div className="border-b px-4 py-3 text-sm font-bold">الطلبات الجاهزة للتوصيل</div>
      {ready.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Truck} title="لا طلبات جاهزة" description="لا توجد طلبات بحالة «جاهز» للإرسال حالياً." />
      ) : (
        <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 text-right">رقم الطلب</th>
                <th className="p-3 text-right">العنوان</th>
                <th className="p-3 text-right">العميل</th>
                <th className="p-3 text-left">سعر البيع</th>
                <th className="p-3 text-left">العربون</th>
                <th className="p-3 text-left">مبلغ التحصيل (COD)</th>
                <th className="p-3 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const cod = Math.max(0, Number(o.salePrice) - Number(o.deposit ?? 0));
                return (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3 font-medium">{o.orderNumber}</td>
                    <td className="p-3">{o.title}{o.hasDelivery && <Badge variant="secondary" className="ms-2">توصيل</Badge>}</td>
                    <td className="p-3">{o.customerName ?? "عميل نقدي"}</td>
                    <td className="p-3 text-left tabular-nums" dir="ltr">{fmt(o.salePrice)}</td>
                    <td className="p-3 text-left tabular-nums text-emerald-600" dir="ltr">{Number(o.deposit ?? 0) > 0 ? fmt(o.deposit) : "—"}</td>
                    <td className="p-3 text-left font-bold tabular-nums" dir="ltr">{fmt(String(cod))}</td>
                    <td className="p-3 text-center">
                      <Button size="sm" onClick={() => setTarget(o)} disabled={!o.deliveryAddress && false}>تسليم لمندوب</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTableShell>
      )}
      <DispatchDialog
        order={target}
        parties={parties.data ?? []}
        pending={dispatch.isPending}
        onClose={() => setTarget(null)}
        onConfirm={async (partyId, fee) => {
          const ord = target!;
          const party = (parties.data ?? []).find((p) => p.id === partyId);
          try {
            const r = await dispatch.mutateAsync({ workOrderId: ord.id, partyId, deliveryFee: fee, deliveryAddress: ord.deliveryAddress ?? undefined, clientRequestId: crypto.randomUUID() });
            printDeliverySlip(ord, party, r);
          } catch { /* عُولج في onError */ }
        }}
      />
    </div>
  );
}

function DispatchDialog({ order, parties, pending, onClose, onConfirm }: {
  order: ReadyOrder | null;
  parties: Party[];
  pending: boolean;
  onClose: () => void;
  onConfirm: (partyId: number, fee: string) => void;
}) {
  const [partyId, setPartyId] = useState<string>("");
  const [fee, setFee] = useState<string>("0");
  const selectedParty = parties.find((p) => String(p.id) === partyId);
  useMemo(() => {
    if (order) {
      setPartyId("");
      setFee("0");
    }
  }, [order?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!order) return null;
  const cod = Math.max(0, Number(order.salePrice) - Number(order.deposit ?? 0));

  const pickParty = (id: string) => {
    setPartyId(id);
    const p = parties.find((x) => String(x.id) === id);
    if (p) setFee(String(Number(p.defaultFee ?? 0)));
  };

  const submit = async () => {
    if (!partyId) { notify.err("اختر جهة التوصيل"); return; }
    const ok = await confirm({
      variant: "danger",
      title: "تأكيد التسليم للمندوب",
      description: `سيُصدر فاتورة بقيمة ${fmt(order.salePrice)} د.ع وتُسجَّل ${fmt(String(cod))} د.ع ذمّةً على «${selectedParty?.name}». لا رجعة.`,
      confirmText: "تسليم",
      requireText: "تسليم",
    });
    if (!ok) return;
    onConfirm(Number(partyId), fee || "0");
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-extrabold">تسليم «{order.title}» لمندوب</h3>
        <p className="mb-4 text-xs text-muted-foreground">{order.orderNumber} — {order.customerName ?? "عميل نقدي"}</p>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-bold">جهة التوصيل</label>
            <select
              className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
              value={partyId}
              onChange={(e) => pickParty(e.target.value)}
            >
              <option value="">— اختر —</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.partyType === "COMPANY" ? "شركة" : "مندوب"})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-bold">أجرة التوصيل (د.ع)</label>
            <Input dir="ltr" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} className="h-11 text-end tabular-nums" />
          </div>
        </div>
        <div className="mb-4 space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmt(order.salePrice)} د.ع</span></div>
          {Number(order.deposit ?? 0) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-emerald-600">−{fmt(order.deposit)} د.ع</span></div>}
          <div className="flex justify-between border-t pt-1 font-bold"><span>مبلغ التحصيل (COD)</span><span dir="ltr" className="tabular-nums">{fmt(String(cod))} د.ع</span></div>
        </div>
        <div className="flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={pending}>إلغاء</Button>
          <Button className="flex-1" onClick={submit} disabled={pending || !partyId}>{pending ? "جارٍ…" : "تأكيد التسليم للمندوب"}</Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── تبويب: تسوية المناديب ─────────────────────────
function SettleTab() {
  const utils = trpc.useUtils();
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const [partyId, setPartyId] = useState<string>("");
  const cons = trpc.delivery.openConsignments.useQuery({ partyId: Number(partyId) }, { enabled: !!partyId });
  const [rows, setRows] = useState<Record<number, { outcome: "COLLECTED" | "RETURNED"; collected: string }>>({});
  const [countedBreakdown, setCountedBreakdown] = useState<Record<number, number>>({});

  const remit = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      notify.ok("سُجِّل التوريد", `${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع${Number(r.shortfallTotal) > 0 ? ` (عجز ${fmt(r.shortfallTotal)})` : ""}`);
      const partyName = (parties.data ?? []).find((p) => String(p.id) === partyId)?.name ?? "";
      printRemittanceReceipt(partyName, r);
      setRows({});
      setCountedBreakdown({});
      utils.delivery.openConsignments.invalidate();
      utils.delivery.listParties.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const ret = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => { notify.ok("أُرجعت الإرسالية"); utils.delivery.openConsignments.invalidate(); utils.delivery.listParties.invalidate(); },
    onError: (e) => notify.err(e),
  });

  const list = cons.data ?? [];
  const get = (c: OpenConsignment) => rows[c.id] ?? { outcome: "COLLECTED" as const, collected: String(Math.max(0, Number(c.codAmount) - Number(c.collectedAmount))) };

  const totals = useMemo(() => {
    let collected = 0, fees = 0, expected = 0;
    for (const c of list) {
      const remaining = Math.max(0, Number(c.codAmount) - Number(c.collectedAmount));
      expected += remaining;
      const st = get(c);
      if (st.outcome === "COLLECTED") {
        const col = Math.min(remaining, Math.max(0, Number(st.collected) || 0));
        collected += col;
        if (col >= remaining && remaining > 0) fees += Number(c.deliveryFee ?? 0); // الأجرة عند التسليم الكامل
      }
    }
    return { collected, fees, net: collected - fees, shortfall: expected - collected, expected };
  }, [list, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const lines = list
      .filter((c) => get(c).outcome === "COLLECTED")
      .map((c) => ({ consignmentId: c.id, collectedAmount: String(Math.max(0, Number(get(c).collected) || 0)) }))
      .filter((l) => Number(l.collectedAmount) >= 0);
    if (lines.length === 0) { notify.err("لا إرساليات للتسوية"); return; }
    const ok = await confirm({
      variant: "danger",
      title: "تأكيد تسوية تحصيلات المندوب",
      description: `المُحصَّل ${fmt(String(totals.collected))} − الأجور ${fmt(String(totals.fees))} = صافٍ للمكتبة ${fmt(String(totals.net))} د.ع.${totals.shortfall > 0 ? ` يبقى العجز ${fmt(String(totals.shortfall))} د.ع ذمّةً على المندوب.` : ""}`,
      confirmText: "تأكيد التسوية",
    });
    if (!ok) return;
    remit.mutate({ partyId: Number(partyId), lines, clientRequestId: crypto.randomUUID() });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <label className="mb-1.5 block text-sm font-bold">اختر جهة التوصيل</label>
        <select className="h-11 w-full max-w-md rounded-md border bg-transparent px-3 text-sm" value={partyId} onChange={(e) => { setPartyId(e.target.value); setRows({}); }}>
          <option value="">— اختر —</option>
          {(parties.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name} — بذمّته {fmt(p.currentBalance)} د.ع</option>
          ))}
        </select>
      </div>

      {!partyId ? null : cons.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
      ) : list.length === 0 ? (
        <EmptyState icon={Truck} title="لا شحنات مفتوحة" description="لا توجد إرساليات قيد التحصيل لهذه الجهة." />
      ) : (
        <>
          <ScrollTableShell className="bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-right">الإرسالية</th>
                  <th className="p-3 text-right">العميل</th>
                  <th className="p-3 text-left">المتوقَّع (COD)</th>
                  <th className="p-3 text-left">الأجرة</th>
                  <th className="p-3 text-center">الحالة</th>
                  <th className="p-3 text-left">المُحصَّل</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const st = get(c);
                  const remaining = Math.max(0, Number(c.codAmount) - Number(c.collectedAmount));
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{c.consignmentNumber}</td>
                      <td className="p-3">{c.customerName ?? c.recipientName ?? "عميل نقدي"}</td>
                      <td className="p-3 text-left tabular-nums" dir="ltr">{fmt(String(remaining))}</td>
                      <td className="p-3 text-left tabular-nums text-muted-foreground" dir="ltr">{fmt(c.deliveryFee)}</td>
                      <td className="p-3 text-center">
                        <div className="inline-flex gap-1">
                          <button
                            className={cn("rounded px-2 py-1 text-xs font-bold", st.outcome === "COLLECTED" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground")}
                            onClick={() => setRows((r) => ({ ...r, [c.id]: { outcome: "COLLECTED", collected: String(remaining) } }))}
                          ><Check aria-hidden className="inline size-3" /> حُصِّل</button>
                          <button
                            className={cn("rounded px-2 py-1 text-xs font-bold", st.outcome === "RETURNED" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground")}
                            onClick={async () => {
                              const ok = await confirm({ variant: "danger", title: "إرجاع الإرسالية", description: `عكس بيع الإرسالية ${c.consignmentNumber} وإعادة البضاعة للمخزون. متابعة؟`, confirmText: "إرجاع" });
                              if (ok) ret.mutate({ consignmentId: c.id, clientRequestId: crypto.randomUUID() });
                            }}
                          ><RotateCcw aria-hidden className="inline size-3" /> مُرتجَع</button>
                        </div>
                      </td>
                      <td className="p-3 text-left">
                        <Input
                          dir="ltr"
                          inputMode="decimal"
                          disabled={st.outcome !== "COLLECTED"}
                          value={st.collected}
                          onChange={(e) => setRows((r) => ({ ...r, [c.id]: { outcome: "COLLECTED", collected: e.target.value } }))}
                          className="h-8 w-28 text-end tabular-nums"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTableShell>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <div className="flex justify-between border-b py-1.5"><span className="text-muted-foreground">إجمالي التحصيل (COD)</span><span dir="ltr" className="font-bold tabular-nums">{fmt(String(totals.collected))} د.ع</span></div>
              <div className="flex justify-between border-b py-1.5"><span className="text-muted-foreground">مستحقات الجهة (الأجور)</span><span dir="ltr" className="tabular-nums text-amber-600">−{fmt(String(totals.fees))} د.ع</span></div>
              <div className="flex justify-between border-b py-1.5"><span className="font-bold">صافٍ للمكتبة (المورَّد)</span><span dir="ltr" className="font-extrabold tabular-nums text-primary">{fmt(String(totals.net))} د.ع</span></div>
              <div className={cn("flex items-center justify-between py-1.5 font-bold", totals.shortfall > 0.01 ? "text-destructive" : "text-emerald-600")}>
                <span className="inline-flex items-center gap-1">{totals.shortfall > 0.01 && <AlertTriangle aria-hidden className="size-3.5" />} {totals.shortfall > 0.01 ? "عجز يبقى ذمّةً على المندوب" : "مطابق"}</span>
                <span dir="ltr" className="tabular-nums">{fmt(String(Math.max(0, totals.shortfall)))} د.ع</span>
              </div>
              <Button className="mt-3 w-full" onClick={submit} disabled={remit.isPending}>{remit.isPending ? "جارٍ…" : "تأكيد التسوية وتوريد الصافي"}</Button>
            </div>
            <CashCounter value={countedBreakdown} onChange={(c) => setCountedBreakdown(c)} />
          </div>
        </>
      )}
    </div>
  );
}
