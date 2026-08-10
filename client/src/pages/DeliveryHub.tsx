import { useMemo, useState } from "react";
import { AlertTriangle, Check, Printer, RotateCcw, Truck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CashCounter } from "@/components/CashCounter";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { cn } from "@/lib/utils";
import { printDoc } from "@/lib/printing/print";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { printDeliverySlip, printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { RowActions } from "@/components/list";
import { ShippingLabelSizeSelect } from "@/components/ShippingLabelSizeSelect";
import { DispatchDialog } from "@/components/delivery/DispatchDialog";
import { buildWorkOrderStatusMessage } from "@/lib/whatsapp";

/**
 * إدارة التوصيل (COD) — شاشة مكرّسة (D5):
 *  - «جاهز للإرسال»: تعيين جهة توصيل + أجرة لطلبٍ جاهز ⇒ إصدار فاتورة COD + عهدة.
 *  - «تسوية المناديب»: قبض تحصيلات الجهة، خصم الأجرة، توريد الصافي (D8) — كم للمكتبة وكم للجهة.
 */

type ReadyOrder = RouterOutputs["delivery"]["readyForDispatch"][number];
type Party = RouterOutputs["delivery"]["listParties"][number];
type OpenConsignment = RouterOutputs["delivery"]["openConsignments"][number];

/** إيصال تسوية توصيل حراري عند التوريد. */
function printRemittanceReceipt(partyName: string, r: { remittanceNumber: string; collectedTotal: string; feesTotal: string; netRemitted: string; shortfallTotal: string }) {
  void printDoc({
    kind: "zreport",
    title: "إيصال تسوية توصيل",
    subtitle: r.remittanceNumber,
    meta: [`الجهة: ${partyName}`, fmtDateTime(new Date())],
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
          <div className="flex flex-wrap items-center gap-2">
            <ShippingLabelSizeSelect />
            <Button variant="outline" asChild>
              <a href="/delivery/parties">جهات التوصيل وذممها</a>
            </Button>
          </div>
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
  const me = trpc.auth.me.useQuery();
  // مرآة بوّابة الخادم: dispatch = cashierProcedure = requireRole("cashier","manager") وadmin يمرّ ضمنياً
  // (بوّابة أدوار صِرفة بلا مفتاح وحدة صلاحيات — لا مفتاح delivery في المصفوفة ⇒ القائمة الحرفية هي المطابقة الدقيقة).
  const canDispatch = ["admin", "cashier", "manager"].includes(me.data?.role ?? "");
  const [target, setTarget] = useState<ReadyOrder | null>(null);
  const [query, setQuery] = useState("");

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
  const allRows = ready.data ?? [];
  // بحث محلي فوري (القائمة تُجلب دفعةً واحدة بلا ترقيم خادميّ ⇒ فلترة العميل تكفي).
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ar");
    if (!needle) return allRows;
    return allRows.filter((o) =>
      [o.orderNumber, o.title, o.customerName].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(needle)),
    );
  }, [allRows, query]);

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <span className="text-sm font-bold">الطلبات الجاهزة للتوصيل ({rows.length})</span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="رقم الطلب أو العميل…"
              aria-label="بحث في الطلبات الجاهزة"
              className="h-8 w-56"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void ready.refetch()} disabled={ready.isFetching}>
            <RotateCcw aria-hidden className={cn("size-3.5", ready.isFetching && "animate-spin")} />
            تحديث
          </Button>
        </div>
      </div>
      {ready.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
      ) : allRows.length === 0 ? (
        <EmptyState icon={Truck} title="لا طلبات جاهزة" description="لا توجد طلبات بحالة «جاهز» للإرسال حالياً." />
      ) : rows.length === 0 ? (
        <EmptyState icon={Truck} title="لا نتائج" description="لا طلبات مطابقة لبحثك." />
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
                      <RowActions
                        mode="inline"
                        contact={{
                          phone: o.deliveryPhone ?? o.customerPhone,
                          alternativePhones: [o.customerPhone],
                          label: `واتساب ${o.customerName ?? "المستلم"}`,
                          message: buildWorkOrderStatusMessage({
                            orderNumber: o.orderNumber,
                            title: o.title,
                            status: "READY",
                            customerName: o.customerName,
                            quantity: o.quantity,
                            dueDate: o.dueDate ? String(o.dueDate) : null,
                            amountDue: cod,
                          }),
                          gate: { module: "store", level: "READ" },
                        }}
                        actions={[
                          {
                            key: "label",
                            kind: "print",
                            label: "ملصق",
                            icon: Printer,
                            onSelect: () => void printReadyOrderLabel(o),
                            gate: { module: "store", level: "READ" },
                          },
                          {
                            key: "dispatch",
                            kind: "approve",
                            label: "تسليم لمندوب",
                            hidden: !canDispatch,
                            onSelect: () => setTarget(o),
                            gate: { roles: ["cashier", "manager"] },
                          },
                        ]}
                      />
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
        onConfirm={async ({ partyId, fee, recipientName, recipientPhone }) => {
          const ord = target!;
          const party = (parties.data ?? []).find((p) => p.id === partyId);
          // نافذة الملصق تُفتح هنا **متزامنةً مع نقرة التأكيد** (قبل await الإرسال) وإلا حجبها
          // مانع النوافذ على المتصفّحات المتشدّدة — تُملأ بعد نجاح الإرسال وتُغلق عند فشله.
          const labelWin = preopenShippingLabelWindow();
          try {
            const r = await dispatch.mutateAsync({
              workOrderId: ord.id,
              partyId,
              deliveryFee: fee,
              recipientName: recipientName || undefined,
              recipientPhone: recipientPhone || undefined,
              deliveryAddress: ord.deliveryAddress ?? undefined,
              clientRequestId: crypto.randomUUID(),
            });
            void printReadyOrderLabel(ord, { partyName: party?.name ?? null, trackingNumber: r.consignmentNumber, cod: r.codAmount, into: labelWin });
            printDeliverySlip(ord, party, r);
          } catch {
            labelWin?.close(); // عُولج الخطأ في onError — لا تُترك نافذة انتظار يتيمة
          }
        }}
      />
    </div>
  );
}

// ───────────────────────── تبويب: تسوية المناديب ─────────────────────────
function SettleTab() {
  const utils = trpc.useUtils();
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const me = trpc.auth.me.useQuery();
  // مرآة بوّابتي الخادم: recordRemittance = cashierProcedure، وreturnConsignment = managerProcedure
  // (بوّابتا أدوار صِرفتان بلا مفتاح وحدة — القائمة الحرفية هي المطابقة الدقيقة، وadmin يمرّ ضمنياً).
  const canRemit = ["admin", "cashier", "manager"].includes(me.data?.role ?? "");
  // قرار المالك (٦/٨/٢٦) — صار **نافذاً** بعد بناء عزل الفرع (كان معلَّقاً بالمدير مؤقّتاً):
  // إرجاع إرسالية المندوب بيد موظّف التسوية نفسه — بضاعةٌ لم تُسلَّم وعادت، لا مرتجع زبون.
  // البوّابة الخادمية `storeFulfillProcedure` (وحدة store=FULL لأدوار manager/cashier/sales_rep)
  // ⇒ نستعمل **نفس دالة الخادم** هنا لا قائمة أدوارٍ حرفية، فتُحترَم المنوح/القيود الصريحة
  // بلا تباعُد بين الطرفين.
  const canReturn = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier", "sales_rep"],
    );
  const [partyId, setPartyId] = useState<string>("");
  const cons = trpc.delivery.openConsignments.useQuery({ partyId: Number(partyId) }, { enabled: !!partyId });
  const [rows, setRows] = useState<Record<number, { outcome: "COLLECTED" | "RETURNED"; collected: string }>>({});
  const [countedBreakdown, setCountedBreakdown] = useState<Record<number, number>>({});
  const [countedCash, setCountedCash] = useState(0);
  // مفتاح idempotency **ثابت لكل جلسة توريد** (مراجعة عدائية ١٠/٨): كان UUID يُولَّد لحظة النقر
  // فلا تلتقط طبقة الـidempotency الخادمية النقرَ المزدوج **للتوريد الجزئي** (الإرسالية تبقى
  // PARTIAL بمتبقٍّ يقبل نفس المبلغ ثانيةً ⇒ إيصالا IN لنقدٍ واحد، فاتورة تُدفع زوراً، ذمّة
  // عميل تُخصَم مرّتين). يتجدّد عند تغيير الجهة وبعد كل نجاح. (نمط SettleDialog/recoverWriteOff.)
  const [remitReqId, setRemitReqId] = useState(() => crypto.randomUUID());

  const remit = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      notify.ok("سُجِّل التوريد", `${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع${Number(r.shortfallTotal) > 0 ? ` (عجز ${fmt(r.shortfallTotal)})` : ""}`);
      const partyName = (parties.data ?? []).find((p) => String(p.id) === partyId)?.name ?? "";
      printRemittanceReceipt(partyName, r);
      setRows({});
      setCountedBreakdown({});
      setCountedCash(0);
      setRemitReqId(crypto.randomUUID()); // توريدٌ تالٍ = مفتاحٌ جديد (لا replay للتالي)
      utils.delivery.openConsignments.invalidate();
      utils.delivery.listParties.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const ret = trpc.delivery.returnConsignment.useMutation({
    onSuccess: (r) => {
      // مراجعة PR #495: أمانة الأجرة المصروفة للمندوب سلفاً **لا تُردّ** هنا (لا التزامَ باقياً
      // — تحريرُها ثانيةً كان يُخرج نقداً مرّتين). يُفصَح عنها كي يقرّر المالك ردَّها مصروفاً.
      if ((r as { feeAlreadyPaidToCourier?: boolean })?.feeAlreadyPaidToCourier) {
        notify.warn(
          "أُرجعت الإرسالية — أجرة التوصيل صُرفت للمندوب سلفاً",
          `أجرة ${fmt((r as { deliveryFee?: string }).deliveryFee ?? 0)} د.ع خرجت من الدرج للمندوب لحظة الإسناد ولم تُردّ. ردُّها للزبون قرارُ إدارةٍ يُسجَّل سند صرف (مصروف على المكتبة).`,
        );
      } else {
        notify.ok("أُرجعت الإرسالية");
      }
      utils.delivery.openConsignments.invalidate();
      utils.delivery.listParties.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const list = cons.data ?? [];
  const get = (c: OpenConsignment) => rows[c.id] ?? { outcome: "COLLECTED" as const, collected: String(Math.max(0, Number(c.codAmount) - Number(c.collectedAmount))) };

  const totals = useMemo(() => {
    // «العجز» = ما نقص عن الأسطر **المُدرَجة** في هذا التوريد (مطابقةً لدلالة الخادم بعد
    // استثناء الأسطر الصفرية — مراجعة ٩/٨): الإرسالية المتروكة كلياً «تبقى بالطريق» ولا
    // تدخل عجز هذا المستند، وإلا ناقض حوارُ التأكيد الإيصالَ المطبوع وسجلَّ التوريدات.
    let collected = 0, fees = 0, expected = 0, leftInTransit = 0;
    for (const c of list) {
      const remaining = Math.max(0, Number(c.codAmount) - Number(c.collectedAmount));
      const st = get(c);
      const col = st.outcome === "COLLECTED" ? Math.min(remaining, Math.max(0, Number(st.collected) || 0)) : 0;
      if (col > 0) {
        expected += remaining;
        collected += col;
        // الأجرة تُخصَم عند التسليم الكامل **وبشرط الخادم حرفياً** (مراجعة عدائية ٩/٨ — كانت
        // الشاشة تخصم كل الأجور فتحسب صافياً يخالف الخادم لإرساليات COURIER (يقبضها المندوب
        // بنفسه) والمصروفة سلفاً (feeSettledAt) ⇒ العدّ لا يطابق أبداً = طريق مسدود للتسوية).
        const feeStillOwed = c.feeCollection !== "COURIER" && c.feeSettledAt == null;
        if (col >= remaining && remaining > 0 && feeStillOwed) fees += Number(c.deliveryFee ?? 0);
      } else if (remaining > 0) {
        leftInTransit += 1;
      }
    }
    return { collected, fees, net: collected - fees, shortfall: expected - collected, expected, leftInTransit };
  }, [list, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    // الأسطر الصفرية تُستثنى (٩/٨): غير المحصَّل ليس توريداً — يبقى بالطريق (كان الصفر يقلب
    // الإرسالية PARTIAL كاذبةً ويقفل باب إرجاعها). الخادم يرفضها أيضاً — الاستثناء هنا أوضح.
    const lines = list
      .filter((c) => get(c).outcome === "COLLECTED")
      .map((c) => ({ consignmentId: c.id, collectedAmount: String(Math.max(0, Number(get(c).collected) || 0)) }))
      .filter((l) => Number(l.collectedAmount) > 0);
    if (lines.length === 0) { notify.err("لا مبالغ للتوريد — أدخل المُحصَّل فعلاً؛ غير المحصَّل يبقى بالطريق"); return; }
    if (Math.abs(countedCash - totals.net) > 0.01) {
      notify.err(`النقد المعدود لا يطابق الصافي المتوقع. المعدود ${fmt(String(countedCash))} والمتوقع ${fmt(String(totals.net))} د.ع`);
      return;
    }
    const ok = await confirm({
      variant: "danger",
      title: "تأكيد تسوية تحصيلات المندوب",
      description: `المُحصَّل ${fmt(String(totals.collected))} − الأجور ${fmt(String(totals.fees))} = صافٍ للمكتبة ${fmt(String(totals.net))} د.ع.${totals.shortfall > 0 ? ` يبقى العجز ${fmt(String(totals.shortfall))} د.ع ذمّةً على المندوب.` : ""}${totals.leftInTransit > 0 ? ` (${totals.leftInTransit} إرسالية تبقى بالطريق خارج هذا التوريد.)` : ""}`,
      confirmText: "تأكيد التسوية",
    });
    if (!ok) return;
    remit.mutate({ partyId: Number(partyId), lines, countedCash: countedCash.toFixed(2), clientRequestId: remitReqId });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <label className="mb-1.5 block text-sm font-bold">اختر جهة التوصيل</label>
        <select className="h-11 w-full max-w-md rounded-md border bg-transparent px-3 text-sm" value={partyId} onChange={(e) => { setPartyId(e.target.value); setRows({}); setRemitReqId(crypto.randomUUID()); }}>
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
                  <th className="p-3 text-right">الفاتورة</th>
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
                  // مرآة قاعدة الخادم (feeStillOwed): أجرة لا تُخصم من هذا التوريد تُعرَض موسومةً
                  // لا رقماً صامتاً يُدخِله الموظف في حسبة العدّ خطأً.
                  const feeStillOwed = c.feeCollection !== "COURIER" && c.feeSettledAt == null;
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{c.consignmentNumber}</td>
                      {/* الربط البصري إرسالية↔فاتورة في أهم لحظة تحاسب — المندوب يحمل نسخ INV-… */}
                      <td className="p-3">
                        {c.invoiceId ? (
                          <a className="font-mono text-xs text-primary hover:underline" dir="ltr" href={`/invoices/${c.invoiceId}`}>
                            {c.invoiceNumber ?? `#${c.invoiceId}`}
                          </a>
                        ) : "—"}
                      </td>
                      <td className="p-3">{c.customerName ?? c.recipientName ?? "عميل نقدي"}</td>
                      <td className="p-3 text-left tabular-nums" dir="ltr">{fmt(String(remaining))}</td>
                      <td className="p-3 text-left">
                        <span className="tabular-nums text-muted-foreground" dir="ltr">{fmt(c.deliveryFee)}</span>
                        {Number(c.deliveryFee ?? 0) > 0 && !feeStillOwed && (
                          <span className="block text-[10px] font-bold text-muted-foreground">
                            {c.feeCollection === "COURIER" ? "يقبضها المندوب — لا تُخصم" : "صُرفت سلفاً — لا تُخصم"}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        <div className="inline-flex gap-1">
                          <button
                            className={cn("rounded px-2 py-1 text-xs font-bold", st.outcome === "COLLECTED" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground")}
                            onClick={() => setRows((r) => ({ ...r, [c.id]: { outcome: "COLLECTED", collected: String(remaining) } }))}
                          ><Check aria-hidden className="inline size-3" /> حُصِّل</button>
                          {canReturn && (
                            <button
                              className={cn("rounded px-2 py-1 text-xs font-bold", st.outcome === "RETURNED" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground")}
                              onClick={async () => {
                                const ok = await confirm({ variant: "danger", title: "إرجاع الإرسالية", description: `عكس بيع الإرسالية ${c.consignmentNumber} وإعادة البضاعة للمخزون. متابعة؟`, confirmText: "إرجاع" });
                                if (ok) ret.mutate({ consignmentId: c.id, clientRequestId: crypto.randomUUID() });
                              }}
                            ><RotateCcw aria-hidden className="inline size-3" /> مُرتجَع</button>
                          )}
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
              <div className={cn("flex items-center justify-between border-t py-1.5 font-bold", Math.abs(countedCash - totals.net) > 0.01 ? "text-money-negative" : "text-money-positive")}>
                <span>{Math.abs(countedCash - totals.net) > 0.01 ? "فرق العدّ — لا يمكن التسوية" : "النقد المعدود مطابق للصافي"}</span>
                <span dir="ltr" className="tabular-nums">{fmt(String(countedCash - totals.net))} د.ع</span>
              </div>
              {canRemit && (
                <Button className="mt-3 w-full" onClick={submit} disabled={remit.isPending || Math.abs(countedCash - totals.net) > 0.01}>{remit.isPending ? "جارٍ…" : "تأكيد التسوية وتوريد الصافي"}</Button>
              )}
            </div>
            <CashCounter value={countedBreakdown} onChange={(c, total) => { setCountedBreakdown(c); setCountedCash(Number(total)); }} />
          </div>
        </>
      )}
    </div>
  );
}
