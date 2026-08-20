import { useMemo, useState } from "react";
import { AlertTriangle, Check, FileText, MessageCircle, Phone, Printer, RotateCcw, Truck } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { DispatchDialog } from "@/components/delivery/DispatchDialog";
import { buildWorkOrderStatusMessage } from "@/lib/whatsapp";
import { deriveWoDeliveryState, woDeliveryStateLabel, WO_DELIVERY_STATE_CLS } from "@shared/workOrderDeliveryState";

/**
 * إدارة التوصيل (COD) — شاشة مكرّسة (D5):
 *  - «جاهز للإرسال»: تعيين جهة توصيل + أجرة لطلبٍ جاهز ⇒ إصدار فاتورة COD + عهدة.
 *  - «تسوية المناديب»: توريد COD كاملاً، ودفع الأجرة المستحقة بسند مستقل بعد ثبوت التسليم.
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
  // ١٨/٨: تبويبٌ ثالث «قيد التوصيل» — الشاشة المفقودة بين الإسناد والتسوية (بلاغ المالك).
  // يُفتَح بـ`?tab=transit` كي يقود إليه تحذيرُ سحب البطاقة في الكانبان مباشرةً.
  const initialTab = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "transit"
    ? "transit" as const
    : "dispatch" as const;
  const [tab, setTab] = useState<"dispatch" | "transit" | "settle">(initialTab);
  const transitCount = trpc.delivery.inTransit.useQuery(undefined, { refetchInterval: 30_000 }).data?.length ?? 0;
  return (
    <div className="space-y-5 p-4 md:p-6" dir="rtl">
      <PageHeader
        title="إدارة التوصيل"
        description="إسناد الطلبات الجاهزة وتتبع تسليمها، ثم توريد COD ودفع أجرة التوصيل بسند مستقل."
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
        <button className={tabBtn(tab === "transit")} onClick={() => setTab("transit")}>
          قيد التوصيل
          {transitCount > 0 && (
            <span className="ms-1.5 rounded-full bg-[var(--sem-warn)] px-1.5 text-[10px] font-black text-white tabular-nums">
              {transitCount}
            </span>
          )}
        </button>
        <button className={tabBtn(tab === "settle")} onClick={() => setTab("settle")}>تسوية المناديب</button>
      </div>
      {tab === "dispatch" ? <DispatchTab /> : tab === "transit" ? <InTransitTab /> : <SettleTab />}
    </div>
  );
}

// ───────────────────────── تبويب: جاهز للإرسال ─────────────────────────
function DispatchTab() {
  const utils = trpc.useUtils();
  const ready = trpc.delivery.readyForDispatch.useQuery(undefined, { refetchInterval: 20_000, refetchOnWindowFocus: true });
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true }, { refetchInterval: 30_000, refetchOnWindowFocus: true });
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
      utils.delivery.consignments.invalidate();
      utils.delivery.openConsignments.invalidate();
      utils.workOrders.list.invalidate();
      utils.workOrders.counts.invalidate();
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
        onConfirm={async ({ partyId, fee, recipientName, recipientPhone, assignedUserId }) => {
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
              assignedUserId,
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

// ───────────────────────── تبويب: قيد التوصيل ─────────────────────────
/**
 * «أين طردي؟» — الشاشة التي كانت مفقودة (بلاغ المالك ١٨/٨). تعرض كل طردٍ خرج ولم يُغلق،
 * أياً كانت حالته، بتعرّضه الماليّ وعمره وجهته وسائقه — فلا يختفي طلبٌ بين الإسناد والتسليم.
 * كثافةٌ عالية بلا ازدحام: صفٌّ واحد يحمل كلّ ما يلزم القرار، وأزرارُ التواصل في مكانها.
 */
function InTransitTab() {
  const utils = trpc.useUtils();
  const rows = trpc.delivery.inTransit.useQuery(undefined, { refetchInterval: 20_000, refetchOnWindowFocus: true });
  const [query, setQuery] = useState("");

  // المخرج اليوميّ للطرد الذي أعاده المندوب (بلاغ المالك): استرجاعٌ بسببٍ موثَّق ⇒ عكسٌ كامل
  // (مخزون + فاتورة + ذمّة + عربون + تحرير عهدة COD) في معاملةٍ واحدة.
  const returnCn = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => {
      notify.ok("رجع الطرد للمكتبة", "عُكس البيع كاملاً: المخزون والفاتورة وذمّة العميل وعهدة المندوب.");
      utils.delivery.inTransit.invalidate();
      utils.delivery.readyForDispatch.invalidate();
      utils.delivery.openConsignments.invalidate();
      utils.delivery.listParties.invalidate();
      utils.workOrders.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function askReturn(r: { id: number; consignmentNumber: string | null; parcelStatus: string | null }) {
    const needsReason = r.parcelStatus === "ACCEPTED" || r.parcelStatus === "PICKED_UP" || r.parcelStatus === "OUT_FOR_DELIVERY";
    const reason = needsReason
      ? window.prompt("سبب رجوع الطرد (رفض العميل / عنوان خاطئ / تعذّر الوصول…):")?.trim()
      : "";
    if (needsReason && (!reason || reason.length < 2)) return;
    const ok = await confirm({
      title: `استرجاع الإرسالية ${r.consignmentNumber ?? r.id}`,
      description: "يُعكَس البيع كاملاً: تعود البضاعة للمخزون، وتصير الفاتورة مرتجعة، وتسقط ذمّة العميل، ويُبرَّأ المندوب من تحصيلها. لا يُنفَّذ إلّا بعد استلام الطرد فعلياً في الفرع.",
      confirmText: "نعم، استلمتُ الطرد",
    });
    if (!ok) return;
    returnCn.mutate({
      consignmentId: r.id,
      clientRequestId: crypto.randomUUID(),
      ...(needsReason && reason ? { returnReason: reason } : {}),
    });
  }

  /**
   * فصلُ «المرتجع المُعلَن» عن «المُستلَم» (إطار المالك، نسخة ٢): الطرد المتعثّر أعلنته الجهة
   * ولم يصل الفرع بعد — **لا حركة مخزون ولا عكس فاتورة حتى يُستلَم ويُفحَص فعلاً**. هذا الفلتر
   * يجعل تلك القائمة قابلةً للعثور بدل أن تضيع بين الطرود السائرة.
   */
  const [stateFilter, setStateFilter] = useState<"ALL" | "ASSIGNED" | "IN_TRANSIT" | "FAILED">("ALL");
  const filtered = useMemo(() => {
    const all = rows.data ?? [];
    if (stateFilter === "ALL") return all;
    return all.filter((r) => deriveWoDeliveryState("DISPATCHED", r.parcelStatus) === stateFilter);
  }, [rows.data, stateFilter]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((r) =>
      [r.consignmentNumber, r.invoiceNumber, r.orderNumber, r.partyName, r.driverName, r.recipientName, r.customerName, r.recipientPhone]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [filtered, query]);

  const countOf = (s: "ASSIGNED" | "IN_TRANSIT" | "FAILED") =>
    (rows.data ?? []).filter((r) => deriveWoDeliveryState("DISPATCHED", r.parcelStatus) === s).length;

  const totalDue = useMemo(
    () => (rows.data ?? []).reduce((sum, r) => sum + Number(r.codDue || 0), 0),
    [rows.data],
  );

  if (rows.isError) return <ErrorState onRetry={() => void rows.refetch()} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-10 items-center gap-1 rounded-lg border bg-muted/40 p-1" role="tablist" aria-label="حالة الطرد">
          {([
            { v: "ALL", label: "الكل", n: (rows.data ?? []).length },
            { v: "ASSIGNED", label: "مُسنَد — لم يخرج", n: countOf("ASSIGNED") },
            { v: "IN_TRANSIT", label: "بالطريق", n: countOf("IN_TRANSIT") },
            { v: "FAILED", label: "بانتظار المرتجع", n: countOf("FAILED") },
          ] as const).map((c) => (
            <button
              key={c.v}
              type="button"
              role="tab"
              aria-selected={stateFilter === c.v}
              onClick={() => setStateFilter(c.v)}
              className={cn(
                "h-8 rounded-md px-2.5 text-xs font-black transition-colors",
                stateFilter === c.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
              <span className="ms-1 tabular-nums opacity-70">{c.n}</span>
            </button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="بحث برقم الإرسالية/الفاتورة/الطلب، أو الجهة أو المستلم…"
          className="h-10 max-w-md"
        />
        <div className="ms-auto flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md border bg-muted/40 px-2 py-1 font-bold">
            طرود بالطريق: <span className="tabular-nums">{list.length}</span>
          </span>
          <span className="rounded-md border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-2 py-1 font-bold text-[var(--sem-warn)]">
            تعرّض التحصيل: <span className="tabular-nums" dir="ltr">{fmt(totalDue)}</span> د.ع
          </span>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={stateFilter === "FAILED" ? "لا طرود بانتظار المرتجع" : "لا طرود بالطريق"}
          description={
            stateFilter === "FAILED"
              ? "لا طرد أعلنت الجهة تعذّر تسليمه وينتظر رجوعه للفرع."
              : "كل ما أُسنِد للمناديب إمّا سُلّم وسُوّي أو أُرجع."
          }
        />
      ) : (
        <ScrollTableShell>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-xs text-muted-foreground">
                <th className="p-2 text-start">الإرسالية / الطلب</th>
                <th className="p-2 text-start">الجهة والسائق</th>
                <th className="p-2 text-start">المستلم</th>
                <th className="p-2 text-start">الحالة</th>
                <th className="p-2 text-end">المطلوب تحصيله</th>
                <th className="p-2 text-end">العمر</th>
                <th className="p-2 text-start">تواصل</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                // كل صفٍّ هنا `DISPATCHED` بحكم الاستعلام؛ التمييز من حالة الطرد وحدها.
                const state = deriveWoDeliveryState("DISPATCHED", r.parcelStatus);
                const label = state === "NONE" ? "بالطريق" : woDeliveryStateLabel(state)!;
                const cls = state === "NONE" ? WO_DELIVERY_STATE_CLS.IN_TRANSIT : WO_DELIVERY_STATE_CLS[state];
                const stale = Number(r.ageHours ?? 0) >= 48;
                const phone = (r.recipientPhone ?? "").trim();
                return (
                  <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="p-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold tabular-nums" dir="ltr">{r.consignmentNumber}</span>
                        {/* ١٩/٨ (طلب المالك): مصدرُ الطرد. الطابور محايدُ المصدر أصلاً — طلبُ
                            المتجر المُسنَد لشركةٍ يظهر كما يظهر أمرُ الشغل — لكنّ الصفّ كان لا
                            يقول أيَّهما، و`orderNumber` يبقى NULL لطلب المتجر فيبدو بلا هويّة. */}
                        <span className="rounded bg-muted px-1.5 py-px text-[10px] font-bold text-muted-foreground">
                          {r.sourceType === "WORK_ORDER"
                            ? "أمر شغل"
                            : r.sourceType === "ONLINE_ORDER"
                              ? "طلب متجر"
                              : "فاتورة"}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground" dir="ltr">
                        {r.orderNumber ?? r.invoiceNumber ?? `#${r.sourceId}`}
                      </div>
                    </td>
                    <td className="p-2">
                      <div className="font-bold">{r.partyName ?? "—"}</div>
                      <div className="text-[11px] text-muted-foreground">{r.driverName ?? "بلا سائق مُسنَد"}</div>
                    </td>
                    <td className="p-2">
                      <div>{r.recipientName ?? r.customerName ?? "—"}</div>
                      <div className="text-[11px] text-muted-foreground" dir="ltr">{phone || "—"}</div>
                    </td>
                    <td className="p-2">
                      <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-extrabold", cls)}>{label}</span>
                      {r.failureReason && (
                        <div className="mt-0.5 max-w-40 text-[11px] text-[var(--sem-danger)]">{r.failureReason}</div>
                      )}
                    </td>
                    <td className="p-2 text-end font-black tabular-nums" dir="ltr">{fmt(r.codDue)}</td>
                    <td className={cn("p-2 text-end tabular-nums", stale && "font-black text-[var(--sem-danger)]")} dir="ltr">
                      {Number(r.ageHours ?? 0)} س
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1">
                        {phone && (
                          <>
                            <Button size="sm" variant="outline" asChild title="اتصال بالمستلم">
                              <a href={`tel:${phone}`}><Phone aria-hidden className="size-3.5" /></a>
                            </Button>
                            <Button size="sm" variant="outline" asChild title="واتساب المستلم">
                              <a href={`https://wa.me/${phone.replace(/[^\d]/g, "")}`} target="_blank" rel="noreferrer">
                                <MessageCircle aria-hidden className="size-3.5" />
                              </a>
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          title="رجع الطرد للمكتبة — عكسٌ كامل للبيع"
                          disabled={returnCn.isPending}
                          onClick={() => void askReturn(r)}
                        >
                          <RotateCcw aria-hidden className="size-3.5" /> استرجاع
                        </Button>
                        <Button size="sm" variant="outline" asChild title="فتح جهة التوصيل وتسويتها">
                          <a href={`/delivery/parties/${r.partyId}`}>الجهة</a>
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTableShell>
      )}
    </div>
  );
}

// ───────────────────────── تبويب: تسوية المناديب ─────────────────────────
function SettleTab() {
  const utils = trpc.useUtils();
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const me = trpc.auth.me.useQuery();
  const branchId = Number(me.data?.branchId ?? 0);
  const currentShift = trpc.shifts.current.useQuery(
    { branchId, shiftType: "RECEPTION" },
    { enabled: branchId > 0 },
  );
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
  const [rows, setRows] = useState<Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }>>({});
  const [countedBreakdown, setCountedBreakdown] = useState<Record<number, number>>({});
  const [countedCash, setCountedCash] = useState(0);
  // مفتاح idempotency **ثابت لكل جلسة توريد** (مراجعة عدائية ١٠/٨): كان UUID يُولَّد لحظة النقر
  // فلا تلتقط طبقة الـidempotency الخادمية النقرَ المزدوج **للتوريد الجزئي** (الإرسالية تبقى
  // PARTIAL بمتبقٍّ يقبل نفس المبلغ ثانيةً ⇒ إيصالا IN لنقدٍ واحد، فاتورة تُدفع زوراً، ذمّة
  // عميل تُخصَم مرّتين). يتجدّد عند تغيير الجهة وبعد كل نجاح. (نمط SettleDialog/recoverWriteOff.)
  const [remitReqId, setRemitReqId] = useState(() => crypto.randomUUID());

  // ١٩/٨ — حقول كشف شركة التوصيل: مستند الشركة الذي قادت أسطرُه هذه التسوية.
  const [statementNumber, setStatementNumber] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [statementDeductions, setStatementDeductions] = useState(0);
  const [statementNotes, setStatementNotes] = useState("");

  const resetAfterSettle = () => {
    setRows({});
    setCountedBreakdown({});
    setCountedCash(0);
    setStatementNumber("");
    setStatementDate("");
    setStatementDeductions(0);
    setStatementNotes("");
    setRemitReqId(crypto.randomUUID());
    utils.delivery.openConsignments.invalidate();
    utils.delivery.inTransit.invalidate();
    utils.delivery.listParties.invalidate();
  };

  const companyStatement = trpc.delivery.recordCompanyStatement.useMutation({
    onSuccess: (r) => {
      notify.ok(
        `سُجِّل كشف الشركة ${r.statementNumber}`,
        `سند التوريد ${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع${r.deliveriesConfirmed > 0 ? ` · أثبت تسليم ${r.deliveriesConfirmed} طرداً` : ""}`,
      );
      resetAfterSettle();
    },
    onError: (e) => notify.err(e),
  });

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
  const payFee = trpc.delivery.payFee.useMutation({
    onSuccess: (r) => {
      notify.ok("دُفعت أجرة التوصيل", `المبلغ ${fmt(r.paid)} د.ع — المتبقي ${fmt(r.remaining)} د.ع`);
      void utils.delivery.openConsignments.invalidate();
      void utils.delivery.partyFinancials.invalidate();
      void utils.delivery.listParties.invalidate();
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
  const remainingOf = (c: OpenConsignment) => Math.max(0, Number(c.codAmount) - Number(c.collectedAmount));
  const isRemittable = (c: OpenConsignment) => c.parcelStatus === "DELIVERED"
    && (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL")
    && remainingOf(c) > 0;
  /**
   * **كشفُ الشركة يُثبت التسليم بنفسه** (تصويب مراجعة Codex، ٢٠/٨).
   *
   * `isRemittable` تشترط `parcelStatus = DELIVERED` — وهو ختمٌ **حصريٌّ ببوّابة المندوب**.
   * وجهاتُ التوصيل بلا حسابِ بوّابة هي بالضبط **الحالةُ التي بُني الكشفُ من أجلها**، فكان
   * سطرُها لا يظهر ولا يُختار ⇒ `deliveriesConfirmed` لا يتجاوز الصفر أبداً من الشاشة
   * والميزةُ غيرُ قابلةٍ للاستعمال. والخادمُ يقبلها فعلاً (`needConfirm` يختم التسليم).
   *
   * فحين يُدخَل رقمُ الكشف تتّسع الأهليّةُ لكلّ طردٍ **حيّ** له متبقٍّ — والطردُ الملغى أو
   * المُرجَع يبقى خارجها (لا تُثبَّت عليه تسوية). وبلا رقمِ كشفٍ لا يتغيّر شيء.
   */
  const statementMode = statementNumber.trim().length > 0;
  const isStatementConfirmable = (c: OpenConsignment) => c.status === "DISPATCHED"
    && c.parcelStatus !== "CANCELLED" && c.parcelStatus !== "RETURNED"
    && (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL" || c.moneyStatus === "NOT_APPLICABLE")
    && remainingOf(c) > 0;
  /** الأهليّةُ الفعليّة للتسوية — تتّسع بالكشف وحده. */
  const isSettleable = (c: OpenConsignment) => isRemittable(c) || (statementMode && isStatementConfirmable(c));
  const isReturnable = (c: OpenConsignment) => c.status === "DISPATCHED"
    && (c.parcelStatus === "ASSIGNED" || c.parcelStatus === "FAILED")
    && (c.moneyStatus === "NOT_APPLICABLE" || c.moneyStatus === "UNSETTLED")
    && Number(c.collectedAmount) === 0;
  const get = (c: OpenConsignment) => rows[c.id] ?? (isSettleable(c)
    ? { outcome: "COLLECTED" as const, collected: String(remainingOf(c)) }
    : { outcome: "NONE" as const, collected: "0" });

  const totals = useMemo(() => {
    // «العجز» = ما نقص عن الأسطر **المُدرَجة** في هذا التوريد (مطابقةً لدلالة الخادم بعد
    // استثناء الأسطر الصفرية — مراجعة ٩/٨): الإرسالية المتروكة كلياً «تبقى بالطريق» ولا
    // تدخل عجز هذا المستند، وإلا ناقض حوارُ التأكيد الإيصالَ المطبوع وسجلَّ التوريدات.
    let collected = 0, expected = 0, leftInTransit = 0;
    for (const c of list) {
      if (!isSettleable(c)) continue;
      const remaining = remainingOf(c);
      const st = get(c);
      const col = st.outcome === "COLLECTED" ? Math.min(remaining, Math.max(0, Number(st.collected) || 0)) : 0;
      if (col > 0) {
        expected += remaining;
        collected += col;
        // الأجرة تُخصَم عند التسليم الكامل **وبشرط الخادم حرفياً** (مراجعة عدائية ٩/٨ — كانت
        // الشاشة تخصم كل الأجور فتحسب صافياً يخالف الخادم لإرساليات COURIER (يقبضها المندوب
        // بنفسه) والمصروفة سلفاً (feeSettledAt) ⇒ العدّ لا يطابق أبداً = طريق مسدود للتسوية).
      } else if (remaining > 0) {
        leftInTransit += 1;
      }
    }
    return { collected, fees: 0, net: collected, shortfall: expected - collected, expected, leftInTransit };
  }, [list, rows, statementMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    // الأسطر الصفرية تُستثنى (٩/٨): غير المحصَّل ليس توريداً — يبقى بالطريق (كان الصفر يقلب
    // الإرسالية PARTIAL كاذبةً ويقفل باب إرجاعها). الخادم يرفضها أيضاً — الاستثناء هنا أوضح.
    const lines = list
      .filter((c) => isSettleable(c) && get(c).outcome === "COLLECTED")
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
      description: `المُحصَّل والمورّد للمكتبة ${fmt(String(totals.net))} د.ع. أجرة التوصيل تُدفع بسند مستقل بعد ثبوت التسليم.${totals.leftInTransit > 0 ? ` (${totals.leftInTransit} إرسالية تبقى بالطريق خارج هذا التوريد.)` : ""}`,
      confirmText: "تأكيد التسوية",
    });
    if (!ok) return;
    // ١٩/٨ — كشف الشركة: إن أُدخل رقمُه فالتسوية تمرّ بمسار الكشف (يُثبت التسليم لما لم
    // يُختَم بعد، ورقمُه الفريد يمنع إدخاله مرّتين). بلا رقمٍ يبقى التوريد اليدويّ كما كان.
    if (statementNumber.trim()) {
      companyStatement.mutate({
        partyId: Number(partyId),
        statementNumber: statementNumber.trim(),
        statementDate: statementDate || null,
        deductionsTotal: statementDeductions ? String(statementDeductions) : null,
        notes: statementNotes.trim() || null,
        lines,
        countedCash: countedCash.toFixed(2),
        clientRequestId: remitReqId,
      });
      return;
    }
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
        <EmptyState icon={Truck} title="لا التزامات مفتوحة" description="لا توجد مبالغ للتوريد أو أجور للدفع أو إرساليات قابلة للإرجاع لهذه الجهة." />
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
                  const remaining = remainingOf(c);
                  const remittable = isSettleable(c);
                  const returnable = isReturnable(c);
                  const feeDue = Math.max(0, Number(c.feeDue ?? 0));
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
                        {Number(c.deliveryFee ?? 0) > 0 && c.parcelStatus !== "DELIVERED" && (
                          <span className="block text-[10px] font-bold text-muted-foreground">
                            {c.feeCollection === "COURIER" ? "يقبضها المندوب من العميل" : "تُستحق بعد نجاح التوصيل"}
                          </span>
                        )}
                        {Number(c.deliveryFee ?? 0) > 0 && c.parcelStatus === "DELIVERED" && feeDue <= 0 && (
                          <span className="block text-[10px] font-bold text-muted-foreground">
                            {c.feeCollection === "COURIER" ? "يقبضها المندوب — لا تُخصم" : "صُرفت سلفاً — لا تُخصم"}
                          </span>
                        )}
                        {feeDue > 0 && c.parcelStatus === "DELIVERED" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-1 h-7 text-[10px]"
                            disabled={payFee.isPending || !currentShift.data?.id}
                            title={!currentShift.data?.id ? "افتح وردية استقبال لدفع الأجرة من درج موثق" : undefined}
                            onClick={async () => {
                              const ok = await confirm({
                                title: "دفع أجرة التوصيل",
                                description: `دفع ${fmt(String(feeDue))} د.ع لجهة التوصيل عن ${c.consignmentNumber} من وردية الاستقبال #${currentShift.data?.id}.`,
                                confirmText: "دفع بسند صرف",
                              });
                              if (ok && currentShift.data?.id) payFee.mutate({
                                consignmentId: c.id,
                                shiftId: currentShift.data.id,
                                clientRequestId: crypto.randomUUID(),
                              });
                            }}
                          >
                            دفع المستحق
                          </Button>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        <div className="inline-flex gap-1">
                          {remittable && (
                            <button
                              className={cn("rounded px-2 py-1 text-xs font-bold", st.outcome === "COLLECTED" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground")}
                              onClick={() => setRows((r) => ({ ...r, [c.id]: { outcome: "COLLECTED", collected: String(remaining) } }))}
                            ><Check aria-hidden className="inline size-3" /> حُصِّل</button>
                          )}
                          {canReturn && returnable && (
                            <button
                              className="rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700"
                              onClick={async () => {
                                const ok = await confirm({ variant: "danger", title: "إرجاع الإرسالية", description: `عكس بيع الإرسالية ${c.consignmentNumber} وإعادة البضاعة للمخزون. متابعة؟`, confirmText: "إرجاع" });
                                if (ok) ret.mutate({ consignmentId: c.id, clientRequestId: crypto.randomUUID() });
                              }}
                            ><RotateCcw aria-hidden className="inline size-3" /> مُرتجَع</button>
                          )}
                          {!remittable && !returnable && feeDue > 0 && <span className="text-xs font-bold text-amber-700">أجرة مستحقة</span>}
                        </div>
                      </td>
                      <td className="p-3 text-left">
                        {remittable ? (
                          <Input
                            dir="ltr"
                            inputMode="decimal"
                            disabled={st.outcome !== "COLLECTED"}
                            value={st.collected}
                            onChange={(e) => setRows((r) => ({ ...r, [c.id]: { outcome: "COLLECTED", collected: e.target.value } }))}
                            className="h-8 w-28 text-end tabular-nums"
                          />
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTableShell>

          {/* ١٩/٨ — كشف شركة التوصيل: مستند الشركة الذي قادت أسطرُه هذه التسوية. بإدخال رقمه
              تصير التسوية «كشفاً»: يُثبِت التسليم لما لم يُختَم بعد (فالشركات بلا بوّابة لم
              يكن لطرودها مخرجٌ أصلاً)، ورقمُه الفريد لكل جهة يمنع إدخاله مرّتين. */}
          <div className="rounded-xl border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)]/40 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-black text-[var(--sem-info)]">
              <FileText aria-hidden className="size-4" />
              كشف شركة التوصيل (اختياريّ — يملؤه من يسوّي بكشفٍ ورقيّ من الشركة)
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="stmt-no" className="text-xs">رقم الكشف</Label>
                <Input id="stmt-no" value={statementNumber} maxLength={64} dir="ltr"
                  onChange={(e) => setStatementNumber(e.target.value)} placeholder="STMT-…" className="h-9" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="stmt-date" className="text-xs">تاريخ الكشف</Label>
                <Input id="stmt-date" type="date" value={statementDate}
                  onChange={(e) => setStatementDate(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="stmt-deduct" className="text-xs">استقطاعات الشركة (إفصاح)</Label>
                <MoneyInput id="stmt-deduct" value={String(statementDeductions || "")}
                  onChange={(v) => setStatementDeductions(Number(v) || 0)} ariaLabel="استقطاعات الشركة" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="stmt-notes" className="text-xs">ملاحظة</Label>
                <Input id="stmt-notes" value={statementNotes} maxLength={500}
                  onChange={(e) => setStatementNotes(e.target.value)} placeholder="سبب الفرق مثلاً…" className="h-9" />
              </div>
            </div>
            {statementNumber.trim() && (
              <p className="mt-2 text-[11px] font-bold text-[var(--sem-info)]">
                ستُسجَّل التسوية ككشفٍ: الطرود غير المختومة يُثبِت الكشفُ تسليمها، والاستقطاع
                إفصاحٌ على المستند لا يُخصَم من ذمّة أيّ عميل.
              </p>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <div className="flex justify-between border-b py-1.5"><span className="text-muted-foreground">إجمالي التحصيل (COD)</span><span dir="ltr" className="font-bold tabular-nums">{fmt(String(totals.collected))} د.ع</span></div>
              <div className="flex justify-between border-b py-1.5"><span className="text-muted-foreground">الأجور</span><span className="text-xs text-muted-foreground">تُدفع بسند مستقل بعد التسليم</span></div>
              <div className="flex justify-between border-b py-1.5"><span className="font-bold">النقد المورَّد للمكتبة</span><span dir="ltr" className="font-extrabold tabular-nums text-primary">{fmt(String(totals.net))} د.ع</span></div>
              <div className={cn("flex items-center justify-between py-1.5 font-bold", totals.shortfall > 0.01 ? "text-destructive" : "text-emerald-600")}>
                <span className="inline-flex items-center gap-1">{totals.shortfall > 0.01 && <AlertTriangle aria-hidden className="size-3.5" />} {totals.shortfall > 0.01 ? "عجز يبقى ذمّةً على المندوب" : "مطابق"}</span>
                <span dir="ltr" className="tabular-nums">{fmt(String(Math.max(0, totals.shortfall)))} د.ع</span>
              </div>
              <div className={cn("flex items-center justify-between border-t py-1.5 font-bold", Math.abs(countedCash - totals.net) > 0.01 ? "text-money-negative" : "text-money-positive")}>
                <span>{Math.abs(countedCash - totals.net) > 0.01 ? "فرق العدّ — لا يمكن التسوية" : "النقد المعدود مطابق للصافي"}</span>
                <span dir="ltr" className="tabular-nums">{fmt(String(countedCash - totals.net))} د.ع</span>
              </div>
              {canRemit && (
                <Button
                  className="mt-3 w-full"
                  onClick={submit}
                  disabled={remit.isPending || companyStatement.isPending || Math.abs(countedCash - totals.net) > 0.01}
                >
                  {remit.isPending || companyStatement.isPending
                    ? "جارٍ…"
                    : statementNumber.trim()
                      ? `تسجيل كشف الشركة ${statementNumber.trim()} وتوريد الصافي`
                      : "تأكيد التسوية وتوريد الصافي"}
                </Button>
              )}
            </div>
            <CashCounter value={countedBreakdown} onChange={(c, total) => { setCountedBreakdown(c); setCountedCash(Number(total)); }} />
          </div>
        </>
      )}
    </div>
  );
}
