import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileCheck2,
  FileText,
  History,
  MessageCircle,
  Phone,
  Printer,
  RotateCcw,
  Send,
  ShieldCheck,
  Truck,
  Undo2,
  Wallet,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { CashCounter } from "@/components/CashCounter";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list";
import { ShippingLabelSizeSelect } from "@/components/ShippingLabelSizeSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { DispatchDialog } from "@/components/delivery/DispatchDialog";
import { ConsignmentTimelineDrawer } from "@/components/delivery/ConsignmentTimelineDrawer";
import { DeliveryManifestButton } from "@/components/delivery/DeliveryManifestButton";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { playReadyBeep } from "@/lib/notifyBeep";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import {
  SHORTFALL_REASONS,
  SHORTFALL_REASON_LABEL_AR,
  SHORTFALL_REASON_DESCRIPTION_AR,
  type ShortfallReason,
} from "@shared/shortfallReason";
import { cn } from "@/lib/utils";
import { printDoc } from "@/lib/printing/print";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { printDeliverySlip, printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { buildCourierAssignmentMessage, buildCustomerDispatchMessage, buildWorkOrderStatusMessage, openWhatsApp } from "@/lib/whatsapp";
import {
  CONSIGNMENT_VIEW_AR,
  CONSIGNMENT_VIEW_CLS,
  CONSIGNMENT_VIEW_ORDER,
  deriveConsignmentView,
  type ConsignmentViewKey,
} from "@shared/consignmentView";
import {
  DELIVERY_AGE_CLS,
  DELIVERY_AGE_ESCALATE_HOURS,
  deliveryAgeLevel,
  formatDeliveryAge,
} from "@shared/deliveryAging";

/**
 * إدارة التوصيل (COD) — طاولة عمل لا شاشة عرض (بلاغ المالك ٢٢/٨: «لماذا لا توجد أزرار لتنفيذ
 * كذا؟ لماذا لا يوجد توجيه وإسناد لكي تكون عاملاً حقيقياً للعمل؟»):
 *  - «جاهز للإرسال»: تعيين جهة توصيل + أجرة لطلبٍ جاهز ⇒ إصدار فاتورة COD + عهدة.
 *  - «قيد التوصيل»: طاولة تحكّم بكل انتقالات الطرد المشروعة — خروج جماعي بيد الموظف، إعلان
 *    رجوع، تعذّر، استلام مرتجع، إثبات يدوي، درج زمني كامل.
 *  - «تسوية المناديب»: جدول التزامات الجهات (الأقدم أولاً) + توريد الكشف + صرف الأجور المجمّع.
 */

type ReadyOrder = RouterOutputs["delivery"]["readyForDispatch"][number];
type OpenConsignment = RouterOutputs["delivery"]["openConsignments"]["rows"][number];
type InTransitRow = RouterOutputs["delivery"]["inTransit"]["rows"][number];
type PartyObligation = RouterOutputs["delivery"]["obligations"][number];

/** إيصال تسوية توصيل حراري عند التوريد. */
function printRemittanceReceipt(partyName: string, r: { remittanceNumber: string | null; collectedTotal: string; feesTotal: string; netRemitted: string; shortfallTotal: string; courierCommissionAmount?: string | null }) {
  if (!r.remittanceNumber) return; // كشف إثبات محض بلا سند توريد ⇒ لا إيصال.
  // Slice H (٢٩/٨/٢٦): سطرُ العمولة يظهر على الإيصال حين تكون للجهة قاعدةٌ فعّالة — إعلاميّ للمقارنة.
  const totals: Array<{ label: string; value: string }> = [
    { label: "إجمالي التحصيل", value: `${fmt(r.collectedTotal)} د.ع` },
    { label: "مستحقات الجهة (الأجور)", value: `${fmt(r.feesTotal)} د.ع` },
  ];
  if (r.courierCommissionAmount != null) {
    totals.push({ label: "عمولة القاعدة (تقديريّة)", value: `${fmt(r.courierCommissionAmount)} د.ع` });
  }
  totals.push(
    { label: "صافٍ للمكتبة", value: `${fmt(r.netRemitted)} د.ع` },
    { label: "عجز يبقى عهدة", value: `${fmt(r.shortfallTotal)} د.ع` },
  );
  void printDoc({
    kind: "zreport",
    title: "إيصال تسوية توصيل",
    subtitle: r.remittanceNumber,
    meta: [`الجهة: ${partyName}`, fmtDateTime(new Date())],
    totals,
    footer: "تسوية تحصيلات المندوب",
  });
}

const tabBtn = (active: boolean) =>
  cn(
    "rounded-lg px-4 py-2 text-sm font-bold transition-colors",
    active ? "bg-primary text-primary-foreground" : "border bg-card hover:bg-muted/60",
  );

function readTabFromSearch(search: string): "dispatch" | "transit" | "settle" {
  const t = new URLSearchParams(search).get("tab");
  return t === "transit" ? "transit" : t === "settle" ? "settle" : "dispatch";
}

export default function DeliveryHub() {
  /**
   * ٢٣/٨ (Codex P1): `wouter/Link` يُنقّل داخل التطبيق فلا يُعاد mount للمكوّن — كان `tab`
   * يُقرأ من الـURL مرّةً على الـmount فقط، فيبقى «transit» حين ينقر الكاشير «سجّل التحصيل»
   * ولا تُركَّب `SettleTab` أبداً. `useSearch` من wouter يُحدَّث تفاعلياً على كل تنقّل ⇒
   * نُزامن `tab` معه في effect: النقر على الرابط يُظهر الشاشة الصحيحة فوراً، وإدخال التبويب
   * يدوياً يبقى يعمل (setTab يتقدّم على الـeffect للتحديث المحلّيّ الفوريّ).
   */
  const search = useSearch();
  const [tab, setTab] = useState<"dispatch" | "transit" | "settle">(() => readTabFromSearch(search));
  useEffect(() => {
    setTab(readTabFromSearch(search));
  }, [search]);
  /**
   * شارةُ العدّاد: صفحةٌ واحدة (٢٠٠) تكفي عرفاً، ونضع «+» عندما يتجاوز العدد الصفحةَ الأولى
   * حتى لا يقرأ الكاشير رقماً كاذباً بعد الترقيم. الأعداد الدقيقة تحصل في التبويب نفسه.
   */
  const transitFirstPage = trpc.delivery.inTransit.useQuery(undefined, { refetchInterval: 30_000 });
  const transitCount = transitFirstPage.data?.rows.length ?? 0;
  const transitMore = transitFirstPage.data?.hasMore ?? false;
  return (
    <div className="space-y-5 p-4 md:p-6" dir="rtl">
      <PageHeader
        title="إدارة التوصيل"
        description="طاولة قيادة كاملة لدورة حياة الطرد: من الإسناد إلى التسليم إلى التسوية والتحصيل، بلا طلبٍ ضائعٍ أو صامت."
        icon={<Truck className="size-6 text-primary" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ShippingLabelSizeSelect />
            <Button variant="outline" asChild>
              <Link href="/delivery?tab=parties">جهات التوصيل وذممها</Link>
            </Button>
          </div>
        }
      />
      <div className="flex gap-2">
        <button className={tabBtn(tab === "dispatch")} onClick={() => setTab("dispatch")}>جاهز للإرسال</button>
        <button className={tabBtn(tab === "transit")} onClick={() => setTab("transit")}>
          قيد التوصيل
          {transitCount > 0 && (
            <span className="ms-1.5 rounded-full bg-[var(--sem-warn)] px-1.5 text-[10px] font-black text-background tabular-nums">
              {transitCount}{transitMore ? "+" : ""}
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
  const canDispatch = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["cashier", "manager"],
    );
  const [target, setTarget] = useState<ReadyOrder | null>(null);
  const [query, setQuery] = useState("");

  // كشفُ الطلبات الجديدة بين استعلامَين متتاليَين (Slice A، ٢٩/٨/٢٦) — بلاغ المالك: «الطلب انجزة
  // فني المطبعة وحوّله لجاهز، لا شي يظهر ولا شي يلاحظه موظّفو الاستقبال والتوصيل». تبويب Dispatch
  // يعتمد `readyForDispatch` (READY + hasDelivery ولا إرسالية بعد) — أي طلبٍ يظهر فيه لأوّل مرّة
  // هو *بالتحديد* حالةٌ تحتاج فعلاً بشرياً. نفس نمط ReceptionOrderQueue حرفياً.
  const knownReadyRef = useRef<Set<number>>(new Set());
  const firstLoadRef = useRef<boolean>(true);
  useEffect(() => {
    const rows = ready.data;
    if (!rows) return;
    const currentIds = new Set<number>();
    for (const r of rows) currentIds.add(Number(r.id));
    if (firstLoadRef.current) {
      knownReadyRef.current = currentIds;
      firstLoadRef.current = false;
      return;
    }
    const freshIds: number[] = [];
    Array.from(currentIds).forEach((id) => {
      if (!knownReadyRef.current.has(id)) freshIds.push(id);
    });
    knownReadyRef.current = currentIds;
    if (freshIds.length > 0) {
      const freshRows = rows.filter((r) => freshIds.includes(Number(r.id)));
      const first = freshRows[0]!;
      const suffix = freshRows.length > 1 ? ` (و${freshRows.length - 1} طلب/طلبات أخرى)` : "";
      notify.info(
        `طلب جاهز للإرسال: ${first.orderNumber}${suffix}`,
        first.customerName ? `العميل: ${first.customerName}` : undefined,
      );
      playReadyBeep();
    }
  }, [ready.data]);

  const dispatch = trpc.delivery.dispatch.useMutation({
    onSuccess: (r, variables) => {
      // Slice M (٣٠/٨/٢٦): تفاصيل الإسناد للمندوب بضغطةٍ من التوست — يفتح واتساب برسالةٍ مُعدّة.
      // الجهة تُلتقط بـpartyId المُرسَل + قائمة parties الحيّة (لا استعلام إضافيّ).
      const dispatchedParty = parties.data?.find((p) => Number(p.id) === Number(variables.partyId));
      const dispatchedOrder = target; // النافذة لا تُغلَق حتى إتمام دورة onSuccess.
      const courierPhone = dispatchedParty?.phone;
      const canSendWhatsapp = !!courierPhone && !!dispatchedOrder;
      notify.ok(
        "أُرسل عبر المندوب",
        `إرسالية ${r.consignmentNumber} — COD ${fmt(r.codAmount)} د.ع`,
        canSendWhatsapp
          ? {
              label: "أرسل تفاصيل واتساب",
              onClick: () => {
                openWhatsApp(
                  courierPhone!,
                  buildCourierAssignmentMessage({
                    consignmentNumber: r.consignmentNumber,
                    orderNumber: dispatchedOrder!.orderNumber,
                    title: dispatchedOrder!.title,
                    customerName: dispatchedOrder!.customerName,
                    customerPhone: dispatchedOrder!.deliveryPhone ?? dispatchedOrder!.customerPhone,
                    deliveryAddress: dispatchedOrder!.deliveryAddress,
                    codAmount: r.codAmount,
                    deliveryFee: variables.deliveryFee ?? "0",
                    feeCollection: dispatchedOrder!.deliveryFeeCollection ?? "COURIER",
                  }),
                );
              },
            }
          : undefined,
      );
      // Slice N (٣٠/٨/٢٦): توست ثانٍ للعميل — يعرف مَن يُوصِل طلبَه ورقم هاتفه (لا يفاجَأ برقم غريب).
      // ينفصل عن التوست الأوّل كي لا نُفقد الموظّف زرَّ المندوب حين يُغلق العميل من غير عمد.
      const customerPhone = dispatchedOrder?.deliveryPhone ?? dispatchedOrder?.customerPhone;
      if (customerPhone && dispatchedParty && dispatchedOrder) {
        notify.info(
          "أعلم العميل بالمندوب",
          `اضغط للإرسال — ${dispatchedOrder.customerName ?? "العميل"} يعرف مَن يُوصِل طلبَه`,
        );
        // نمرّر الزرّ في التوست الثاني (info بدل ok كي يتمايز بصرياً — الأوّل نجاح، الثاني إجراءٌ اختياريّ).
        setTimeout(() => {
          notify.ok(
            `أعلم ${dispatchedOrder.customerName ?? "العميل"} بالمندوب`,
            `${dispatchedParty.name} — ${dispatchedParty.phone ?? "بلا هاتف"}`,
            {
              label: "أرسل واتساب للعميل",
              onClick: () => {
                openWhatsApp(
                  customerPhone,
                  buildCustomerDispatchMessage({
                    orderNumber: dispatchedOrder.orderNumber,
                    title: dispatchedOrder.title,
                    customerName: dispatchedOrder.customerName,
                    courierName: dispatchedParty.name,
                    courierPhone: dispatchedParty.phone,
                    codAmount: r.codAmount,
                    deliveryFee: variables.deliveryFee ?? "0",
                    feeCollection: dispatchedOrder.deliveryFeeCollection ?? "COURIER",
                  }),
                );
              },
            },
          );
        }, 400);
      }
      setTarget(null);
      utils.delivery.readyForDispatch.invalidate();
      utils.delivery.listParties.invalidate();
      utils.delivery.consignments.invalidate();
      utils.delivery.openConsignments.invalidate();
      utils.delivery.inTransit.invalidate();
      utils.delivery.obligations.invalidate();
      utils.workOrders.list.invalidate();
      utils.workOrders.counts.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  if (ready.isError) return <ErrorState onRetry={() => ready.refetch()} />;
  const allRows = ready.data ?? [];
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
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="رقم الطلب أو العميل…"
            aria-label="بحث في الطلبات الجاهزة"
            className="h-8 w-56"
          />
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
                    <td className="p-3 text-left tabular-nums text-money-positive" dir="ltr">{Number(o.deposit ?? 0) > 0 ? fmt(o.deposit) : "—"}</td>
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
                            // Slice E (٢٩/٨/٢٦): تمرير الأجرة وطريقة القبض ⇒ رسالةٌ صادقة عن الإجماليّ.
                            hasDelivery: o.hasDelivery,
                            deliveryFee: o.deliveryCost ?? "0",
                            deliveryFeeCollection: o.deliveryFeeCollection ?? "COURIER",
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
                            gate: { roles: ["cashier", "manager"], module: "store", level: "FULL" },
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
            labelWin?.close();
          }
        }}
      />
    </div>
  );
}

// ───────────────────────── تبويب: قيد التوصيل (طاولة عمل) ─────────────────────────
/**
 * الشاشة التي كانت مفقودة (بلاغ المالك ١٨/٨) وتحوّلت الآن إلى **طاولة عمل** (٢٢/٨):
 * كل صف يعرض «الإجراء التالي» الصحيح لحالته، تحديد جماعي لإجراءات الدُفعة (خروج/تعذّر/محضر
 * تسليم)، ودرج زمني بنقرةٍ واحدة على رقم الإرسالية.
 */
function InTransitTab() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  /**
   * Codex P1 #1 (٢٥/٨): تبويبُ «قيد التوصيل» طاولةُ عملٍ يفلتر عليها الكاشير ويأخذ إجراءاتٍ
   * جماعية — إخفاءُ صفوفٍ بالترقيم يعني إجراءً على «الكلّ» ينسى الطرود المُخفاة. نجمع كلّ
   * الصفحات (٥٠٠ لكل نداء) قبل السماح بأيّ فعلٍ يعتمد على القائمة.
   */
  const rows = trpc.delivery.inTransit.useInfiniteQuery(
    { limit: 500 },
    {
      refetchInterval: 20_000,
      refetchOnWindowFocus: true,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  useEffect(() => {
    if (rows.hasNextPage && !rows.isFetchingNextPage) void rows.fetchNextPage();
  }, [rows.hasNextPage, rows.isFetchingNextPage, rows.fetchNextPage]);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [failTarget, setFailTarget] = useState<{ ids: number[] } | null>(null);
  const [manualProofTarget, setManualProofTarget] = useState<InTransitRow | null>(null);
  const [staffConfirmTarget, setStaffConfirmTarget] = useState<InTransitRow | null>(null);
  const [declareTarget, setDeclareTarget] = useState<InTransitRow | null>(null);

  const canFulfil = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier", "sales_rep"],
    );
  /**
   * ٢٣/٨ (Codex P2 #3): `deliveryCashierProcedure` = `moduleProcedure(["cashier","manager"],"store","FULL")`
   * — لا يشمل `sales_rep`. `canFulfil` أعلاه أوسع (يشمله). إظهارُ زرّ «تم التسليم» عليه
   * كان يُنتج `FORBIDDEN` من الخادم على كل نقرة. مرآةُ بوّابة الخادم حرفياً هنا.
   */
  const canStaffConfirm = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier"],
    );
  const isManager = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager"],
    );

  // ── Mutations ──
  const invalidateAll = () => {
    utils.delivery.inTransit.invalidate();
    utils.delivery.obligations.invalidate();
    utils.delivery.listParties.invalidate();
    utils.delivery.openConsignments.invalidate();
    utils.delivery.readyForDispatch.invalidate();
    utils.workOrders.list.invalidate();
  };
  const staffHandover = trpc.delivery.staffHandover.useMutation({
    onSuccess: (r) => {
      const skippedNote = r.skipped.length > 0 ? ` — تُخطّي ${r.skipped.length}` : "";
      notify.ok("خرجت الطرود مع المندوب", `أُخرج ${r.moved} طرداً${skippedNote}`);
      setSelectedIds(new Set());
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const staffMarkFailed = trpc.delivery.staffMarkFailed.useMutation({
    onSuccess: () => { notify.ok("وُسم متعذّر التسليم"); invalidateAll(); },
    onError: (e) => notify.err(e),
  });
  const declareReturn = trpc.delivery.declareReturn.useMutation({
    onSuccess: (res) => {
      notify.ok("سُجّل رجوعٌ مُعلَن", `تحرّر تحصيلٌ متوقّع ${fmt(res.releasedExposure ?? "0")} د.ع — والبضاعة تنتظر الاستلام والفحص`);
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const returnCn = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => { notify.ok("رجع الطرد للمكتبة", "عُكس البيع كاملاً: المخزون والفاتورة وذمّة العميل وعهدة المندوب."); invalidateAll(); },
    onError: (e) => notify.err(e),
  });
  const manualProof = trpc.delivery.manualProof.useMutation({
    onSuccess: () => { notify.ok("سُجّل إثبات التسليم اليدويّ", "أُثبت التسليم بالسلطة الاستثنائية — مُوثَّق في سجلّ التدقيق."); invalidateAll(); setManualProofTarget(null); },
    onError: (e) => notify.err(e),
  });
  const staffConfirm = trpc.delivery.staffConfirm.useMutation({
    onSuccess: () => { notify.ok("تم التسليم", "سُجّل تأكيدُك بالمُسلَّم من المندوب — والنقد صار بذمّته حتى تسويته."); invalidateAll(); setStaffConfirmTarget(null); },
    onError: (e) => notify.err(e),
  });

  // ── Filtering ──
  const [stateFilter, setStateFilter] = useState<ConsignmentViewKey | "ALL">("ALL");
  const rowsWithView = useMemo(() => {
    const flat = (rows.data?.pages ?? []).flatMap((p) => p.rows);
    return flat.map((r) => ({
      ...r,
      viewKey: deriveConsignmentView({
        parcelStatus: r.parcelStatus,
        status: "DISPATCHED",
        moneyStatus: r.moneyStatus,
        returnDeclaredAt: r.returnDeclaredAt,
        partyHasPortal: r.partyHasPortal,
      }),
    }));
  }, [rows.data]);
  const filtered = useMemo(() => {
    if (stateFilter === "ALL") return rowsWithView;
    return rowsWithView.filter((r) => r.viewKey === stateFilter);
  }, [rowsWithView, stateFilter]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((r) =>
      [r.consignmentNumber, r.invoiceNumber, r.orderNumber, r.partyName, r.driverName, r.recipientName, r.customerName, r.recipientPhone, r.returnDeclaredReason, r.address]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [filtered, query]);

  // ── Counts per view key (صادقة، بحسب الاشتقاق الموحّد) ──
  const counts = useMemo(() => {
    const map = new Map<ConsignmentViewKey, number>();
    for (const r of rowsWithView) map.set(r.viewKey, (map.get(r.viewKey) ?? 0) + 1);
    return map;
  }, [rowsWithView]);

  /**
   * ── Exposure totals — Slice DFP1 (٣٠/٨/٢٦، P1 #3a): يُشتقّان من `list` (نتيجة الفلاتر
   * والبحث)، لا من `rowsWithView` (الأصل الخام). كان الفلتر يُغيّر الصفوف المعروضة فيبقى
   * الرأس يُعلن مسؤوليّة الجهات كلّها — تناقضٌ بصريّ يوجّه المدير لقرارٍ خاطئ.
   * الآن: ما تراه هو ما يُجمَع في الرأس، ويُضاف رأسُ «قيمة البضاعة» بجوار «التحصيل» بلونٍ
   * حذر — طردٌ مدفوعٌ سلفاً بـ500,000 ليس «صفر مسؤوليّة»، والبضاعة بيد المندوب حتى تصل.
   */
  const totals = useMemo(() => {
    const codDue = list.reduce((s, r) => s + Number(r.codDue || 0), 0);
    const goodsValue = list.reduce((s, r) => s + Math.max(0, Number(r.invoiceTotal || 0) - Number(r.invoiceReturnedTotal || 0)), 0);
    return { codDue, goodsValue };
  }, [list]);

  // ── Bulk selection helpers ──
  const eligibleForHandoverIds = list.filter((r) => r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT").map((r) => Number(r.id));
  const selectedList = list.filter((r) => selectedIds.has(Number(r.id)));
  const allVisibleSelected = list.length > 0 && list.every((r) => selectedIds.has(Number(r.id)));
  const toggleAllVisible = () => {
    if (allVisibleSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(list.map((r) => Number(r.id))));
  };
  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Bulk actions ──
  async function bulkHandover() {
    const ids = selectedList.filter((r) => r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT").map((r) => Number(r.id));
    if (ids.length === 0) { notify.err("لا طرود قابلة للخروج ضمن المحدَّد"); return; }
    const ok = await confirm({
      title: `تأكيد خروج ${ids.length} طرداً مع المندوب`,
      description: "سيُوسَم الطرد «خرج للتوصيل» ويُدوَّن في خطّه الزمنيّ بسلطة موظّف. يُستعمَل حين تُدار الجهةُ بكشفٍ لا ببوّابة سائق.",
      confirmText: "خرجت الطرود",
    });
    if (!ok) return;
    staffHandover.mutate({ consignmentIds: ids, clientRequestId: crypto.randomUUID() });
  }

  const [singleHandoverParty, setSingleHandoverParty] = useState<number | null>(null); // unused reserved

  async function singleHandover(id: number) {
    const ok = await confirm({
      title: `خروج الطرد ${id} مع المندوب`,
      description: "تأكيد التسليم اليدويّ للسائق — يُنقَل «خرج للتوصيل» ويُدوَّن في الخطّ الزمنيّ.",
      confirmText: "خرج",
    });
    if (!ok) return;
    staffHandover.mutate({ consignmentIds: [id], clientRequestId: crypto.randomUUID() });
  }

  async function askDeclareReturn(r: InTransitRow) {
    setDeclareTarget(r);
  }
  async function askReceiveReturn(r: InTransitRow) {
    const ok = await confirm({
      variant: "danger",
      title: `استلام مرتجع الإرسالية ${r.consignmentNumber ?? r.id}`,
      description: "يُعكَس البيع كاملاً: تعود البضاعة للمخزون، الفاتورة مرتجعة، ذمّة العميل تسقط. لا يُنفَّذ إلّا بعد استلام الطرد في الفرع فعلياً.",
      confirmText: "استلمتُ الطرد",
    });
    if (!ok) return;
    returnCn.mutate({ consignmentId: r.id, clientRequestId: crypto.randomUUID() });
  }

  if (rows.isError) return <ErrorState onRetry={() => void rows.refetch()} />;

  return (
    <div className="space-y-3">
      {/* ─── الشريط العلوي: عدّادات صادقة + تعرّض مضاعف + بحث + إجراءات جماعية ─── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-10 items-center gap-1 rounded-lg border bg-muted/40 p-1" role="tablist" aria-label="حالة الطرد">
          <button
            type="button"
            role="tab"
            aria-selected={stateFilter === "ALL"}
            onClick={() => setStateFilter("ALL")}
            className={cn(
              "h-8 rounded-md px-2.5 text-xs font-black transition-colors",
              stateFilter === "ALL" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            الكل <span className="ms-1 tabular-nums opacity-70">{rowsWithView.length}</span>
          </button>
          {CONSIGNMENT_VIEW_ORDER.filter((k) => k !== "CLOSED" && (counts.get(k) ?? 0) > 0).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={stateFilter === k}
              onClick={() => setStateFilter(k)}
              className={cn(
                "h-8 rounded-md px-2.5 text-xs font-black transition-colors",
                stateFilter === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {CONSIGNMENT_VIEW_AR[k]} <span className="ms-1 tabular-nums opacity-70">{counts.get(k) ?? 0}</span>
            </button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="بحث برقم الإرسالية/الفاتورة/الطلب، أو الجهة أو المستلم أو العنوان…"
          className="h-10 max-w-md"
        />
        <div className="ms-auto flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md border bg-muted/40 px-2 py-1 font-bold">
            طرود مفتوحة: <span className="tabular-nums">{list.length}</span>
          </span>
          <span className="rounded-md border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-2 py-1 font-bold text-[var(--sem-warn)]">
            تعرّض التحصيل: <span className="tabular-nums" dir="ltr">{fmt(totals.codDue)}</span> د.ع
          </span>
          <span className="rounded-md border border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] px-2 py-1 font-bold text-[var(--sem-info)]">
            قيمة البضاعة المفتوحة: <span className="tabular-nums" dir="ltr">{fmt(totals.goodsValue)}</span> د.ع
          </span>
        </div>
      </div>

      {/* ─── شريط الإجراءات الجماعية (يظهر حين يوجد محدَّد) ─── */}
      {selectedIds.size > 0 && canFulfil && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2 text-sm">
          <span className="font-bold">المحدَّد: <span className="tabular-nums">{selectedIds.size}</span></span>
          <Button size="sm" variant="outline" disabled={staffHandover.isPending || eligibleForHandoverIds.filter((id) => selectedIds.has(id)).length === 0} onClick={bulkHandover}>
            <Send aria-hidden className="size-3.5" /> خرج مع المندوب ({selectedList.filter((r) => r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT").length})
          </Button>
          <Button size="sm" variant="outline" disabled={staffMarkFailed.isPending} onClick={() => setFailTarget({ ids: Array.from(selectedIds) })}>
            <XCircle aria-hidden className="size-3.5" /> علّم متعذّراً
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>مسح التحديد</Button>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={stateFilter === "ALL" ? "لا طرود بالطريق" : `لا طرود في «${CONSIGNMENT_VIEW_AR[stateFilter]}»`}
          description={stateFilter === "ALL" ? "كل ما أُسنِد للمناديب إمّا سُلّم وسُوّي أو أُرجع." : "طابور فارغ لهذا الفلتر — قد يكون هذا الوضع الطبيعيّ."}
        />
      ) : (
        <ScrollTableShell>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-xs text-muted-foreground">
                {canFulfil && (
                  <th className="p-2 text-start">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="تحديد الكل الظاهر" />
                  </th>
                )}
                <th className="p-2 text-start">الإرسالية / الطلب</th>
                <th className="p-2 text-start">الجهة والسائق</th>
                <th className="p-2 text-start">المستلم / العنوان</th>
                <th className="p-2 text-start">الحالة</th>
                <th className="p-2 text-end">المطلوب تحصيله</th>
                <th className="p-2 text-end">العمر</th>
                <th className="p-2 text-start">الإجراء التالي</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const cls = CONSIGNMENT_VIEW_CLS[r.viewKey];
                const label = CONSIGNMENT_VIEW_AR[r.viewKey];
                const ageHours = Number(r.ageHours ?? 0);
                const ageLevel = deliveryAgeLevel(ageHours);
                const ageStr = formatDeliveryAge(ageHours);
                const isEscalated = ageHours >= DELIVERY_AGE_ESCALATE_HOURS;
                const phone = (r.recipientPhone ?? "").trim();
                const rowId = Number(r.id);
                return (
                  <tr key={r.id} className={cn("border-b last:border-0 hover:bg-muted/40", selectedIds.has(rowId) && "bg-primary/5")}>
                    {canFulfil && (
                      <td className="p-2">
                        <input type="checkbox" checked={selectedIds.has(rowId)} onChange={() => toggleOne(rowId)} aria-label={`تحديد ${r.consignmentNumber}`} />
                      </td>
                    )}
                    <td className="p-2">
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={() => setDrawerId(rowId)} className="font-bold tabular-nums text-primary hover:underline" dir="ltr">
                          {r.consignmentNumber}
                        </button>
                        <span className="rounded bg-muted px-1.5 py-px text-[10px] font-bold text-muted-foreground">
                          {r.sourceType === "WORK_ORDER" ? "أمر شغل" : r.sourceType === "ONLINE_ORDER" ? "طلب متجر" : "فاتورة"}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground" dir="ltr">
                        {r.orderNumber ?? r.invoiceNumber ?? `#${r.sourceId}`}
                      </div>
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold">{r.partyName ?? "—"}</span>
                        {!r.partyHasPortal && (
                          <span className="rounded bg-[var(--sem-info-bg)] px-1 py-px text-[9px] font-bold text-[var(--sem-info)]" title="جهةٌ تُدار بالكشف — لا بوّابة مندوب">كشف</span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{r.driverName ?? "بلا سائق مُسنَد"}</div>
                    </td>
                    <td className="p-2">
                      <div>{r.recipientName ?? r.customerName ?? "—"}</div>
                      <div className="text-[11px] text-muted-foreground" dir="ltr">{phone || "—"}</div>
                      {r.address && <div className="mt-0.5 max-w-64 truncate text-[10px] text-muted-foreground" title={r.address}>{r.address}</div>}
                    </td>
                    <td className="p-2">
                      <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-extrabold", cls)}>{label}</span>
                      {r.returnDeclaredAt != null && (
                        <div className="mt-0.5 max-w-56 text-[11px] font-bold text-[var(--sem-warn)]">
                          {r.returnDeclaredReason ?? "بلا سبب"}
                        </div>
                      )}
                      {r.failureReason && (
                        <div className="mt-0.5 max-w-40 text-[11px] text-[var(--sem-danger)]">{r.failureReason}</div>
                      )}
                    </td>
                    <td className="p-2 text-end font-black tabular-nums" dir="ltr">{fmt(r.codDue)}</td>
                    <td className="p-2 text-end">
                      <div className="inline-flex items-center gap-1">
                        <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-black", DELIVERY_AGE_CLS[ageLevel])} dir="ltr">
                          {ageStr}
                        </span>
                        {isEscalated && <span className="rounded bg-[var(--sem-danger-bg)] px-1 py-px text-[9px] font-bold text-[var(--sem-danger)]" title="طرد متصعَّد لركوده">تصعيد</span>}
                      </div>
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {/* الإجراء التالي حسب الحالة */}
                        {canFulfil && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT") && (
                          <Button size="sm" variant="outline" title="سلّمتُه للمندوب — يبدأ رحلة التوصيل" disabled={staffHandover.isPending} onClick={() => void singleHandover(rowId)}>
                            <Send aria-hidden className="size-3" /> أعطيتُه للمندوب
                          </Button>
                        )}
                        {/*
                          ٢٣/٨ — «تم التسليم» بيد الكاشير: للحالة اليوميّة الشائعة (اتصال المندوب/رسالة)
                          — لا يحتاج انتظار كشف الشركة ولا موافقة المدير. سلطةٌ متوسّطة توثَّق باسمك.
                        */}
                        {canStaffConfirm && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT" || r.viewKey === "IN_TRANSIT") && (
                          <Button size="sm" variant="default" title="أخبرَني المندوب أنه سلّمه للزبون" disabled={staffConfirm.isPending} onClick={() => setStaffConfirmTarget(r)}>
                            <CheckCircle2 aria-hidden className="size-3" /> تم التسليم
                          </Button>
                        )}
                        {canFulfil && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT" || r.viewKey === "IN_TRANSIT") && (
                          <Button size="sm" variant="outline" title="لم يستلمه الزبون — نحتاج إعادة محاولة أو إرجاع" disabled={staffMarkFailed.isPending} onClick={() => setFailTarget({ ids: [rowId] })}>
                            <XCircle aria-hidden className="size-3" /> لم يُسلَّم
                          </Button>
                        )}
                        {/*
                          ٢٣/٨ — الجسر المفقود: الطرد سُلِّم لكن نقده لم يُورَّد بعد ⇒ زرٌّ واحد
                          ينقل الكاشير إلى «تسوية المناديب» بالجهة مختارةً سلفاً كي يُدخل الكشف.
                        */}
                        {canFulfil && r.viewKey === "DELIVERED_AWAITING_REMIT" && (
                          <Button size="sm" variant="default" asChild title="اذهب لتسجيل النقد المُحصَّل من هذه الجهة">
                            <Link href={`/delivery?tab=settle&party=${r.partyId}`}>
                              <Wallet aria-hidden className="size-3" /> سجّل التحصيل
                            </Link>
                          </Button>
                        )}
                        {canFulfil && r.viewKey === "FAILED" && r.returnDeclaredAt == null && (
                          <Button size="sm" variant="outline" title="الشركة أخبرتنا أنّ الطرد راجعٌ إلينا" disabled={declareReturn.isPending} onClick={() => void askDeclareReturn(r)}>
                            <Undo2 aria-hidden className="size-3" /> الشركة تُرجعه
                          </Button>
                        )}
                        {canFulfil && (r.viewKey === "FAILED" || r.viewKey === "RETURN_DECLARED") && (
                          <Button size="sm" variant="outline" title={r.returnDeclaredAt != null ? "وصلت البضاعة للمكتبة وفُحصت — أُعيدها للمخزون" : "وصلت البضاعة للمكتبة — أُعيدها للمخزون"} disabled={returnCn.isPending} onClick={() => void askReceiveReturn(r)}>
                            <RotateCcw aria-hidden className="size-3" /> استلمتُ الرجعة
                          </Button>
                        )}
                        {/*
                          ٢٢/٨ (Codex P2 #1): إثبات يدويّ يمرّ عبر `confirmConsignmentDelivery`
                          الذي يرتدّ `alreadyDelivered` فوراً على أيّ طردٍ سبق ختمُه.
                          ٢٣/٨: تصنيف السلطة صار: كاشير («تم التسليم») → مدير («تأكيد بموافقة مدير»).
                          يظهر زرّ المدير كسلطةٍ أعلى لحالاتٍ تحتاج دليلاً مكتوباً موسَّعاً.
                        */}
                        {isManager && (r.viewKey === "ASSIGNED" || r.viewKey === "AWAITING_STATEMENT" || r.viewKey === "IN_TRANSIT") && (
                          <Button size="sm" variant="outline" title="سلطةٌ استثنائية للمدير — بدليلٍ مكتوبٍ في التدقيق" disabled={manualProof.isPending} onClick={() => setManualProofTarget(r)}>
                            <ShieldCheck aria-hidden className="size-3" /> تأكيد المدير
                          </Button>
                        )}
                        {phone && (
                          <>
                            <Button size="sm" variant="ghost" asChild title="اتصال بالمستلم">
                              <a href={`tel:${phone}`}><Phone aria-hidden className="size-3" /></a>
                            </Button>
                            <Button size="sm" variant="ghost" asChild title="واتساب المستلم">
                              <a href={`https://wa.me/${phone.replace(/[^\d]/g, "")}`} target="_blank" rel="noreferrer"><MessageCircle aria-hidden className="size-3" /></a>
                            </Button>
                          </>
                        )}
                        <Button size="sm" variant="ghost" asChild title="فتح جهة التوصيل وتسويتها">
                          <Link href={`/delivery?tab=parties&detail=${r.partyId}`}><Wallet aria-hidden className="size-3" /></Link>
                        </Button>
                        <Button size="sm" variant="ghost" title="خط زمن الطرد" onClick={() => setDrawerId(rowId)}>
                          <History aria-hidden className="size-3" />
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

      {/* ─── درج الخط الزمنيّ (يفتح بنقر رقم الإرسالية أو أيقونة التاريخ) ─── */}
      <ConsignmentTimelineDrawer consignmentId={drawerId} onClose={() => setDrawerId(null)} />

      {/* ─── حوار التعذّر (مفرد أو جماعي) ─── */}
      {failTarget && (
        <FailReasonDialog
          count={failTarget.ids.length}
          pending={staffMarkFailed.isPending}
          onCancel={() => setFailTarget(null)}
          onConfirm={async (reason) => {
            const results = await Promise.allSettled(
              failTarget.ids.map((id) => staffMarkFailed.mutateAsync({
                consignmentId: id,
                reason,
                clientRequestId: crypto.randomUUID(),
              })),
            );
            const ok = results.filter((r) => r.status === "fulfilled").length;
            const err = results.length - ok;
            if (err === 0) notify.ok(`وُسم ${ok} طرداً متعذّراً`);
            else notify.err(`نجح ${ok} وفشل ${err}`);
            setSelectedIds(new Set());
            setFailTarget(null);
            invalidateAll();
          }}
        />
      )}

      {/* ─── حوار إعلان الرجوع (بديل window.prompt) ─── */}
      {declareTarget && (
        <DeclareReturnDialog
          row={declareTarget}
          pending={declareReturn.isPending}
          onCancel={() => setDeclareTarget(null)}
          onConfirm={(reason, statementNumber) => {
            declareReturn.mutate({
              consignmentId: declareTarget.id,
              reason,
              ...(statementNumber ? { statementNumber } : {}),
              clientRequestId: crypto.randomUUID(),
            });
            setDeclareTarget(null);
          }}
        />
      )}

      {/* ─── حوار «تم التسليم» (كاشير) ─── */}
      {staffConfirmTarget && (
        <StaffConfirmDialog
          row={staffConfirmTarget}
          pending={staffConfirm.isPending}
          onCancel={() => setStaffConfirmTarget(null)}
          onConfirm={(collectedAmount, evidence, shortfallReason) => {
            staffConfirm.mutate({
              consignmentId: staffConfirmTarget.id,
              collectedAmount,
              evidence,
              clientRequestId: crypto.randomUUID(),
              // Slice DFP1 (٣٠/٨/٢٦): سببُ العجز يُرسَل فقط حين وقع عجز — للحفاظ على توافق الحمولة
              // للحالة السائدة (تحصيل كامل بلا سبب مطلوب). الخادم يرفضه إن لزم وغاب.
              ...(shortfallReason ? { shortfallReason } : {}),
            });
          }}
        />
      )}

      {/* ─── حوار الإثبات اليدوي (مدير فقط) ─── */}
      {manualProofTarget && (
        <ManualProofDialog
          row={manualProofTarget}
          pending={manualProof.isPending}
          onCancel={() => setManualProofTarget(null)}
          onConfirm={(collectedAmount, evidence) => {
            manualProof.mutate({
              consignmentId: manualProofTarget.id,
              collectedAmount,
              evidence,
              clientRequestId: crypto.randomUUID(),
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * حوار «تم التسليم» بيد الكاشير — Slice DFP1 (٣٠/٨/٢٦، redesign):
 *
 * قبلَ اليوم: يعرض «المطلوب تحصيله» ثمّ يفتح `MoneyInput` حرّاً مُهيَّأً بالقيمة — الكاشير يستطيع
 * كتابة قيمةٍ مختلفة دون تنبيه، والحوار يُرسلها كأنّها التحصيل الحقيقيّ. بلاغ المالك (٣٠/٨):
 * «لا شي زيادة ونقصان ولا دينار غير محسوب أو ليس له مسار» — الحرّية بلا تصنيف كذبٌ على المالك.
 *
 * التصميم الجديد بمسارَين مغلَقَين، مطابقٌ لسير عمل الكاشير الفعليّ:
 *   ١) «قَبَض المطلوب كاملاً» — الحالة السائدة (٩٠٪+). زرٌّ رئيسٌ بلا حقول: يُثبِت المطلوب.
 *   ٢) «مبلغ مختلف» — يفتح: (أ) المبلغ الفعليّ، (ب) سببٌ إلزاميّ من enum ثابت،
 *      (ج) ملخّصُ الفرق «متبقٍّ Y د.ع على المندوب» ليعرف الكاشير أنّ العجز صار ذمّةً.
 *
 * لماذا لا نصّ حرّ للسبب: النصّ الحرّ يُنتج «مشاكل» غير قابلة للتحليل. القائمة الثابتة تسمح
 * بتقرير «أسباب العجز الأكثر تكراراً» ⇒ قرارٌ عمليٌّ لا انطباع.
 */
function StaffConfirmDialog({ row, pending, onCancel, onConfirm }: { row: InTransitRow; pending: boolean; onCancel: () => void; onConfirm: (collectedAmount: string, evidence: string, shortfallReason: ShortfallReason | undefined) => void }) {
  const remaining = Math.max(0, Number(row.codAmount) - Number(row.collectedAmount ?? 0) - Number(row.counterSettledAmount ?? 0));
  const [mode, setMode] = useState<"exact" | "different">("exact");
  const [amount, setAmount] = useState(String(remaining));
  const [note, setNote] = useState("");
  const [shortfallReason, setShortfallReason] = useState<ShortfallReason | "">("");
  const QUICK_NOTES = ["اتصال المندوب", "رسالة واتساب من المندوب", "تأكيد من العميل"];
  const amountTrimmed = amount.trim();
  const amountNum = Number(amountTrimmed);
  const isAmountValid = amountTrimmed !== "" && Number.isFinite(amountNum) && amountNum >= 0;
  const effectiveAmount = mode === "exact" ? remaining : (isAmountValid ? amountNum : 0);
  const diff = remaining - effectiveAmount;
  const isShort = diff > 0.005;
  const isOver = diff < -0.005;
  const noteValid = note.trim().length >= 3;
  const reasonRequired = mode === "different" && isShort;
  const reasonValid = !reasonRequired || (shortfallReason !== "" && SHORTFALL_REASONS.includes(shortfallReason as ShortfallReason));
  const canConfirm =
    !pending &&
    noteValid &&
    (mode === "exact" || (isAmountValid && !isOver)) &&
    reasonValid;

  const handleConfirm = () => {
    onConfirm(
      effectiveAmount.toFixed(2),
      note.trim(),
      isShort && shortfallReason ? (shortfallReason as ShortfallReason) : undefined,
    );
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-pos)]">
          <CheckCircle2 aria-hidden className="size-5" />
          تم التسليم — {row.consignmentNumber}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          سُلِّم الطردُ للزبون. المبلغُ يصير عهدةً على {row.partyName ?? "المندوب"} حتى تُوَرَّده لاحقاً في «تسوية المناديب». يُسجَّل التأكيدُ باسمك في سجلّ التدقيق.
        </p>
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-2 text-xs">
          <span className="text-muted-foreground">المطلوب تحصيله من الزبون</span>
          <span className="text-end font-black tabular-nums" dir="ltr">{fmt(String(remaining))} د.ع</span>
        </div>

        {/* اختيار المسار — رأسٌ واضحٌ لكيلا يخطئ الكاشير */}
        <div className="mb-3 grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/20 p-1">
          <button
            type="button"
            onClick={() => { setMode("exact"); setAmount(String(remaining)); setShortfallReason(""); }}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-bold transition",
              mode === "exact" ? "bg-[var(--sem-pos)] text-background shadow-sm" : "text-muted-foreground hover:bg-accent",
            )}
          >
            قَبَض المطلوب كاملاً
          </button>
          <button
            type="button"
            onClick={() => setMode("different")}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-bold transition",
              mode === "different" ? "bg-[var(--sem-warn)] text-background shadow-sm" : "text-muted-foreground hover:bg-accent",
            )}
          >
            مبلغ مختلف
          </button>
        </div>

        {mode === "different" && (
          <>
            <Label htmlFor="staff-amount" className="text-xs">المبلغ الذي قبضه المندوب فعلاً</Label>
            <div className="mb-3">
              <MoneyInput id="staff-amount" value={amount} onChange={(v) => setAmount(v)} ariaLabel="المبلغ المُحصَّل" />
            </div>
            {isOver && (
              <p className="mb-3 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-2 text-xs font-medium text-[var(--sem-neg)]">
                المبلغ أكبر من المطلوب — تحقّق من الرقم أو استعمل مسار الفائض المستقلّ.
              </p>
            )}
            {isShort && (
              <>
                <div className="mb-3 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs">
                  <div className="font-bold text-[var(--sem-warn)]">
                    عجزٌ في التحصيل: {fmt(String(diff))} د.ع
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    سيُقيَّد هذا الفرق ذمّةً فوريّة على {row.partyName ?? "المندوب"} — لا يبقى على الزبون.
                  </div>
                </div>
                <Label className="text-xs">سبب العجز <span className="text-[var(--sem-neg)]">*</span></Label>
                <div className="mb-3 grid grid-cols-1 gap-1.5">
                  {SHORTFALL_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setShortfallReason(r)}
                      className={cn(
                        "flex items-start gap-2 rounded-md border p-2 text-start text-xs transition",
                        shortfallReason === r
                          ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]"
                          : "border-muted bg-muted/20 hover:bg-accent",
                      )}
                    >
                      <span className="mt-0.5 inline-block size-3 shrink-0 rounded-full border-2"
                        style={{
                          borderColor: shortfallReason === r ? "var(--sem-warn)" : "var(--muted-foreground)",
                          backgroundColor: shortfallReason === r ? "var(--sem-warn)" : "transparent",
                        }}
                      />
                      <div className="flex-1">
                        <div className="font-bold">{SHORTFALL_REASON_LABEL_AR[r]}</div>
                        <div className="text-muted-foreground">{SHORTFALL_REASON_DESCRIPTION_AR[r]}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <Label className="text-xs">مصدر التأكيد (اختصار سريع أو نصّ حرّ)</Label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_NOTES.map((n) => (
            <button key={n} type="button" onClick={() => setNote(n)} className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition",
              note === n ? "bg-[var(--sem-pos)] text-background" : "bg-muted text-muted-foreground hover:bg-accent",
            )}>{n}</button>
          ))}
        </div>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: اتصال ٦:٤٥م من المندوب…" className="mb-4" />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button size="sm" disabled={!canConfirm} onClick={handleConfirm}>
            {pending ? "جارٍ…" : "تأكيد التسليم"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── حوارات مساعِدة ─────────────────────────

const FAIL_REASONS = [
  "رفض العميل الاستلام",
  "العميل غير متوفّر",
  "عنوان خاطئ",
  "تعذّر التواصل",
  "طلب تأجيل التسليم",
];

function FailReasonDialog({ count, pending, onCancel, onConfirm }: { count: number; pending: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-danger)]">
          <XCircle aria-hidden className="size-5" />
          تعذّر تسليم {count > 1 ? `${count} طرداً` : "الطرد"}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          يُسجَّل السبب على كل طرد ويُوسَم متعذّراً. لا حركة مخزون ولا عكس فاتورة الآن — استلامُ الطرد وفحصه لاحقاً هما ما يُشغّلان العكس الكامل.
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {FAIL_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition",
              reason === r ? "bg-[var(--sem-danger)] text-background" : "bg-muted text-muted-foreground hover:bg-accent",
            )}>{r}</button>
          ))}
        </div>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="سبب تعذّر التسليم…"
          className="mb-4"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button
            size="sm"
            disabled={pending || reason.trim().length < 2}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending ? "جارٍ…" : `تأكيد تعذّر ${count > 1 ? count : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

const DECLARE_REASONS = [
  "رفض العميل",
  "عنوان خاطئ",
  "لم يُعثر عليه",
  "تعذّر التواصل",
];

function DeclareReturnDialog({ row, pending, onCancel, onConfirm }: { row: InTransitRow; pending: boolean; onCancel: () => void; onConfirm: (reason: string, statementNumber: string) => void }) {
  const [reason, setReason] = useState("");
  const [statementNumber, setStatementNumber] = useState("");
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-warn)]">
          <Undo2 aria-hidden className="size-5" />
          إعلان رجوع {row.consignmentNumber ?? `#${row.id}`}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          يُغلق توقّع التحصيل على الجهة فوراً، ويضع الطرد في «بانتظار المرتجع». لا تعود البضاعة للمخزون ولا تُرجَع الفاتورة — ذلك يقع عند الاستلام والفحص في الفرع.
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {DECLARE_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition",
              reason === r ? "bg-[var(--sem-warn)] text-background" : "bg-muted text-muted-foreground hover:bg-accent",
            )}>{r}</button>
          ))}
        </div>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="أو اكتب سبباً حرّاً…" className="mb-2" />
        <Label htmlFor="declare-stmt" className="text-xs">رقم كشف الشركة (اختياريّ)</Label>
        <Input id="declare-stmt" value={statementNumber} onChange={(e) => setStatementNumber(e.target.value)} dir="ltr" placeholder="STMT-…" className="mb-4" />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button size="sm" disabled={pending || reason.trim().length < 3} onClick={() => onConfirm(reason.trim(), statementNumber.trim())}>
            {pending ? "جارٍ…" : "تأكيد إعلان الرجوع"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ManualProofDialog({ row, pending, onCancel, onConfirm }: { row: InTransitRow; pending: boolean; onCancel: () => void; onConfirm: (collectedAmount: string, evidence: string) => void }) {
  const remaining = Math.max(0, Number(row.codAmount) - Number(row.collectedAmount ?? 0) - Number(row.counterSettledAmount ?? 0));
  const [amount, setAmount] = useState(String(remaining));
  const [evidence, setEvidence] = useState("");
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={onCancel} dir="rtl">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2 text-base font-bold text-[var(--sem-info)]">
          <ShieldCheck aria-hidden className="size-5" />
          إثبات تسليم يدويّ — {row.consignmentNumber}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          سلطةٌ استثنائية للمدير: لطرد لا بوّابة له ولا كشف بعد. يُثبَت التسليم بدليل مكتوب (مصدره: مكالمة/صورة/شهادة موظّف) وتُدوَّن هويّة الفاعل والدليل في سجلّ التدقيق. المبلغ المُعلَن تحصيله يُبرِئ ذمّة العميل بمقداره، والفرق يبقى ذمّةً حيّةً تُقبَض بالكاونتر.
        </p>
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-2 text-xs">
          <span className="text-muted-foreground">المطلوب تحصيله</span>
          <span className="text-end font-black tabular-nums" dir="ltr">{fmt(String(remaining))} د.ع</span>
        </div>
        <Label htmlFor="proof-amount" className="text-xs">المُعلَن تحصيله فعلاً</Label>
        <div className="mb-3">
          <MoneyInput id="proof-amount" value={amount} onChange={(v) => setAmount(v)} ariaLabel="المبلغ المُعلَن تحصيله" />
        </div>
        <Label htmlFor="proof-ev" className="text-xs">الدليل (إلزاميّ — ≥٤ حروف)</Label>
        <Input id="proof-ev" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="مصدر الدليل — مكالمة/صورة/شهادة…" className="mb-4" />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>تراجع</Button>
          <Button size="sm" disabled={pending || evidence.trim().length < 4 || Number(amount) < 0} onClick={() => onConfirm(String(Number(amount).toFixed(2)), evidence.trim())}>
            {pending ? "جارٍ…" : "تسجيل الإثبات"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── تبويب: تسوية المناديب ─────────────────────────

function SettleTab() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = Number(me.data?.branchId ?? 0);
  const currentShift = trpc.shifts.current.useQuery(
    { branchId, shiftType: "RECEPTION" },
    { enabled: branchId > 0 },
  );
  const canRemit = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["cashier", "manager"],
    );
  const canReturn = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier", "sales_rep"],
    );
  /**
   * ٢٣/٨ — قبول `?party=…` من رابط «سجّل التحصيل» في تبويب «قيد التوصيل».
   * ٢٣/٨ (Codex P1): `useSearch` تفاعليّ ⇒ يُطبَّق حتى بلا remount حين ينقر الكاشير الرابط.
   */
  const settleSearch = useSearch();
  const [partyId, setPartyId] = useState<string>(() => new URLSearchParams(settleSearch).get("party") ?? "");
  const obligations = trpc.delivery.obligations.useQuery(undefined, { refetchInterval: 30_000 });
  /**
   * Slice DFP1 (٣٠/٨/٢٦) — الجهات المتأخّرة (SLA): قسم اطّلاعيّ يبرز الجهات التي راكمت طروداً
   * قديمة بلا توريد. قرارُ المالك: عدّاد اطّلاعيّ فقط — الحارس التشغيليّ هو الذي يمنع الإسناد.
   */
  const staleParties = trpc.delivery.staleParties.useQuery(undefined, { refetchInterval: 60_000 });
  /**
   * Codex P1 #1 (٢٥/٨): تسويةُ المندوب مستندٌ ماليّ — لا نقبل أن تُخفي الترقيمُ (٢٠٠ صفٍّ افتراضياً)
   * إرسالياتٍ عن الكاشير فيوقّع سنداً ينقص عن العهدة. نستعمل `useInfiniteQuery` **بحدٍّ أقصى ٥٠٠
   * لكل نداء** ونجلب كلّ الصفحات تلقائياً قبل حساب الإجماليّات — رأسُ الجدول يبقى مفتوحاً حتى
   * `hasNextPage=false` (بشارة «جارٍ تحميل الباقي…»). زرُّ التوريد معطَّلٌ حتى انتهاء الجلب.
   */
  const cons = trpc.delivery.openConsignments.useInfiniteQuery(
    { partyId: Number(partyId), limit: 500 },
    {
      enabled: !!partyId,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  // تحميلُ الصفحات المتبقّية تلقائياً — القرار بيدنا لا بيد المستخدم (تسويةٌ تحرّك مالاً).
  useEffect(() => {
    if (cons.hasNextPage && !cons.isFetchingNextPage) void cons.fetchNextPage();
  }, [cons.hasNextPage, cons.isFetchingNextPage, cons.fetchNextPage]);
  const remittances = trpc.delivery.remittances.useQuery({ partyId: Number(partyId), limit: 20 }, { enabled: !!partyId });
  const [rows, setRows] = useState<Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }>>({});
  const [countedBreakdown, setCountedBreakdown] = useState<Record<number, number>>({});
  const [countedCash, setCountedCash] = useState(0);
  const [remitReqId, setRemitReqId] = useState(() => crypto.randomUUID());
  // effect مؤجَّل بعد state declarations — يتفاعل مع تغيّر الـURL من رابط «سجّل التحصيل».
  useEffect(() => {
    const p = new URLSearchParams(settleSearch).get("party");
    if (p && p !== partyId) {
      setPartyId(p);
      setRows({});
      setRemitReqId(crypto.randomUUID());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleSearch]);
  const [drawerId, setDrawerId] = useState<number | null>(null);
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
    utils.delivery.obligations.invalidate();
    utils.delivery.remittances.invalidate();
  };

  const companyStatement = trpc.delivery.recordCompanyStatement.useMutation({
    onSuccess: (r) => {
      const proofNote = r.remittanceNumber ? `سند التوريد ${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع` : "كشف إثبات محض — لا سند توريد";
      notify.ok(`سُجِّل كشف الشركة ${r.statementNumber}`, `${proofNote}${r.deliveriesConfirmed > 0 ? ` · أثبت تسليم ${r.deliveriesConfirmed} طرداً` : ""}`);
      resetAfterSettle();
    },
    onError: (e) => notify.err(e),
  });

  const remit = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      // Slice H (٢٩/٨/٢٦): إشعارٌ يشمل العمولة إن حُسِبت + فارقُها عن الأجرة الفعلية (نتيجةُ القاعدة).
      const commissionNote = r.courierCommissionAmount != null
        ? ` · عمولة القاعدة ${fmt(r.courierCommissionAmount)} (فرقٌ ${fmt(String(Number(r.feesTotal) - Number(r.courierCommissionAmount)))})`
        : "";
      notify.ok(
        "سُجِّل التوريد",
        `${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع${Number(r.shortfallTotal) > 0 ? ` (عجز ${fmt(r.shortfallTotal)})` : ""}${commissionNote}`,
      );
      const partyName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "";
      printRemittanceReceipt(partyName, r);
      resetAfterSettle();
    },
    onError: (e) => notify.err(e),
  });

  const payPartyFees = trpc.delivery.payPartyFees.useMutation({
    onSuccess: (r) => {
      notify.ok(`صُرفت ${r.count} أجرة`, `المجموع ${fmt(r.paidTotal)} د.ع — بسند واحد`);
      resetAfterSettle();
    },
    onError: (e) => notify.err(e),
  });

  const ret = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => { notify.ok("أُرجعت الإرسالية"); resetAfterSettle(); },
    onError: (e) => notify.err(e),
  });

  const list = useMemo(
    () => (cons.data?.pages ?? []).flatMap((p) => p.rows),
    [cons.data],
  );
  const listStillLoading = cons.hasNextPage || cons.isFetchingNextPage;
  const partyName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "";
  const partyRow = obligations.data?.find((p) => String(p.partyId) === partyId);

  const remainingOf = (c: OpenConsignment) => Math.max(0, Number(c.codAmount) - Number(c.collectedAmount) - Number((c as { counterSettledAmount?: string }).counterSettledAmount ?? "0"));
  const isRemittable = (c: OpenConsignment) => c.parcelStatus === "DELIVERED"
    && (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL")
    && remainingOf(c) > 0;

  const statementMode = statementNumber.trim().length > 0;
  const isStatementConfirmable = (c: OpenConsignment) => c.status === "DISPATCHED"
    && c.parcelStatus !== "CANCELLED" && c.parcelStatus !== "RETURNED"
    && (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL" || c.moneyStatus === "NOT_APPLICABLE");
  const isSettleable = (c: OpenConsignment) => isRemittable(c) || (statementMode && isStatementConfirmable(c));
  const isReturnable = (c: OpenConsignment) => c.status === "DISPATCHED"
    && (c.parcelStatus === "ASSIGNED" || c.parcelStatus === "FAILED")
    && (c.moneyStatus === "NOT_APPLICABLE" || c.moneyStatus === "UNSETTLED")
    && Number(c.collectedAmount) === 0;

  // ٢٢/٨: في وضع الكشف تبدأ الصفوف **غير محدَّدة** (opt-in) — قلبٌ لمنطق «حُصِّل بالكامل» الخطر.
  // خارج الكشف يبقى السلوك التقليديّ: الأهل يبدأ COLLECTED بكامل المتبقّي.
  const get = (c: OpenConsignment) => rows[c.id] ?? (statementMode
    ? { outcome: "NONE" as const, collected: "0" }
    : (isSettleable(c) ? { outcome: "COLLECTED" as const, collected: String(remainingOf(c)) } : { outcome: "NONE" as const, collected: "0" }));

  const totals = useMemo(() => {
    let collected = 0, expected = 0, leftInTransit = 0, selectedCount = 0;
    for (const c of list) {
      if (!isSettleable(c)) continue;
      const remaining = remainingOf(c);
      const st = get(c);
      const col = st.outcome === "COLLECTED" ? Math.min(remaining, Math.max(0, Number(st.collected) || 0)) : 0;
      if (col > 0) {
        expected += remaining;
        collected += col;
        selectedCount += 1;
      } else if (remaining > 0) {
        leftInTransit += 1;
      }
    }
    /**
     * **صافي التوريد = المُحصَّل − الاستقطاع** (Codex P1 #2 — ٢٢/٨): الخادمُ في وضع الكشف
     * يفرض `countedCash = collectedTotal - deductionsTotal` (استقطاعُ الشركة نقدٌ لم يدخل
     * الدرج). كان `net = collected` فقط ⇒ إدخالُ النقد الفعليّ يُعطّل زرّ التوريد
     * (فرقٌ مع الصافي)، وإدخالُ الإجماليّ يمرّ الشاشة ويرتدّ الخادم — كشفٌ باستقطاعٍ يصير
     * مستحيلاً بلا استثناء.
     */
    const deductions = statementMode ? Math.max(0, statementDeductions || 0) : 0;
    const net = Math.max(0, collected - deductions);
    return { collected, fees: 0, net, deductions, shortfall: expected - collected, expected, leftInTransit, selectedCount };
  }, [list, rows, statementMode, statementDeductions]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const lines = list
      .filter((c) => isSettleable(c) && get(c).outcome === "COLLECTED")
      .map((c) => ({ consignmentId: c.id, collectedAmount: String(Math.max(0, Number(get(c).collected) || 0)) }))
      .filter((l) => Number(l.collectedAmount) >= 0);
    // في وضع الكشف نسمح بسطر بمبلغ صفر (إثبات تسليم بلا نقد)؛ خارج الكشف يجب أن يكون >0.
    const validLines = statementMode ? lines : lines.filter((l) => Number(l.collectedAmount) > 0);
    if (validLines.length === 0) {
      notify.err("لا أسطر للتسوية — حدّد ما حُصِّل فعلاً");
      return;
    }
    if (Math.abs(countedCash - totals.net) > 0.01) {
      notify.err(`النقد المعدود لا يطابق الصافي المتوقع. المعدود ${fmt(String(countedCash))} والمتوقع ${fmt(String(totals.net))} د.ع`);
      return;
    }
    const ok = await confirm({
      variant: "danger",
      title: "تأكيد تسوية تحصيلات المندوب",
      description: `المُحصَّل والمورّد للمكتبة ${fmt(String(totals.net))} د.ع.${statementMode && validLines.filter((l) => Number(l.collectedAmount) === 0).length > 0 ? ` سيُثبَت تسليم ${validLines.filter((l) => Number(l.collectedAmount) === 0).length} طرداً بلا نقد.` : ""}${totals.leftInTransit > 0 ? ` (${totals.leftInTransit} إرسالية تبقى بالطريق خارج هذا التوريد.)` : ""}`,
      confirmText: "تأكيد التسوية",
    });
    if (!ok) return;
    if (statementMode) {
      companyStatement.mutate({
        partyId: Number(partyId),
        statementNumber: statementNumber.trim(),
        statementDate: statementDate || null,
        deductionsTotal: statementDeductions ? String(statementDeductions) : null,
        notes: statementNotes.trim() || null,
        lines: validLines,
        countedCash: countedCash.toFixed(2),
        clientRequestId: remitReqId,
      });
      return;
    }
    remit.mutate({ partyId: Number(partyId), lines: validLines, countedCash: countedCash.toFixed(2), clientRequestId: remitReqId });
  };

  const selectAll = () => {
    const next: Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }> = {};
    for (const c of list) {
      if (isSettleable(c)) next[c.id] = { outcome: "COLLECTED", collected: String(remainingOf(c)) };
    }
    setRows(next);
  };

  const totalObligationExposure = (obligations.data ?? []).reduce((s, p) => s + Number(p.codDueTotal || 0), 0);
  const totalFeesDue = (obligations.data ?? []).reduce((s, p) => s + Number(p.feeDueTotal || 0), 0);

  return (
    <div className="space-y-4">
      {/* ─── Slice DFP1 (٣٠/٨/٢٦): الجهات المتأخّرة SLA — إشعارٌ اطّلاعيّ للمدير ─── */}
      {(staleParties.data ?? []).length > 0 && (
        <div className="rounded-xl border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-4">
          <div className="mb-2 flex items-center gap-2 font-bold text-[var(--sem-neg)]">
            <AlertTriangle aria-hidden className="size-4" />
            جهاتٌ متأخّرة SLA — طرودٌ تجاوزت العتبة بلا توريد ({staleParties.data?.length ?? 0})
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            الحارس التشغيليّ يرفض إسنادَ طرودٍ جديدة على هذه الجهات حتى تُصفّي القديم — لا حاجة لتدخّل مدير.
          </p>
          <div className="grid gap-1.5 text-sm">
            {(staleParties.data ?? []).slice(0, 10).map((sp) => (
              <div key={sp.partyId} className="flex items-center justify-between rounded-md border bg-card px-3 py-1.5">
                <span className="font-bold">{sp.name}</span>
                <span className="flex items-center gap-3 text-xs">
                  <span className="tabular-nums">{sp.staleParcelCount} طرداً</span>
                  <span className="tabular-nums text-[var(--sem-warn)]">أقدم: {sp.oldestParcelAgeDays} يوم</span>
                  <span className="tabular-nums text-destructive" dir="ltr">{fmt(sp.staleTotalAmount)} د.ع</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── جدول التزامات الجهات — الأقدم أولاً ─── */}
      {(obligations.data ?? []).length === 0 ? (
        <EmptyState icon={Wallet} title="لا التزامات مفتوحة" description="كل الجهات مسدَّدة الالتزامات — لا شيء بذمّة أحدٍ حالياً." />
      ) : (
        <div className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <span className="text-sm font-bold">التزامات الجهات ({(obligations.data ?? []).length})</span>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-md border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-2 py-1 font-bold text-[var(--sem-warn)]">
                تعرّض إجماليّ: <span className="tabular-nums" dir="ltr">{fmt(totalObligationExposure)}</span> د.ع
              </span>
              <span className="rounded-md border border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] px-2 py-1 font-bold text-[var(--sem-info)]">
                أجور مستحقة: <span className="tabular-nums" dir="ltr">{fmt(totalFeesDue)}</span> د.ع
              </span>
            </div>
          </div>
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-2 text-start">الجهة</th>
                  <th className="p-2 text-end">بذمّتها</th>
                  <th className="p-2 text-end">طرود مفتوحة</th>
                  <th className="p-2 text-end">تعرّض التحصيل</th>
                  <th className="p-2 text-end">أقدم طرد</th>
                  <th className="p-2 text-end">أجور مستحقة</th>
                  <th className="p-2 text-end">آخر توريد</th>
                </tr>
              </thead>
              <tbody>
                {(obligations.data ?? []).map((p) => {
                  const ageLevel = deliveryAgeLevel(p.oldestOpenAgeHours ?? 0);
                  const isSelected = String(p.partyId) === partyId;
                  return (
                    <tr
                      key={p.partyId}
                      className={cn("cursor-pointer border-b last:border-0 hover:bg-muted/30", isSelected && "bg-primary/5")}
                      onClick={() => { setPartyId(String(p.partyId)); setRows({}); setRemitReqId(crypto.randomUUID()); }}
                    >
                      <td className="p-2">
                        <div className="flex items-center gap-1.5 font-bold">
                          {p.name}
                          {!p.hasPortal && <span className="rounded bg-[var(--sem-info-bg)] px-1 py-px text-[9px] font-bold text-[var(--sem-info)]" title="تُدار بالكشف">كشف</span>}
                        </div>
                      </td>
                      <td className="p-2 text-end font-bold tabular-nums" dir="ltr">{fmt(p.currentBalance)}</td>
                      <td className="p-2 text-end">
                        <span className="tabular-nums">{p.openCount}</span>
                        {/* ٢٣/٨: جسر التسليم–التحصيل. طرودٌ سُلِّمت ونقدها بيد الجهة ⇒ شارةٌ صريحة. */}
                        {p.deliveredAwaitingRemitCount > 0 && (
                          <span
                            className="ms-1.5 rounded-md bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-[10px] font-black text-[var(--sem-pos)]"
                            title={`${p.deliveredAwaitingRemitCount} طرود سُلِّمت — النقد بذمّة الجهة`}
                          >
                            سُلِّم {p.deliveredAwaitingRemitCount}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-end font-black tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(p.codDueTotal)}</td>
                      <td className="p-2 text-end">
                        {p.oldestOpenAgeHours != null ? (
                          <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-black", DELIVERY_AGE_CLS[ageLevel])} dir="ltr">
                            {formatDeliveryAge(p.oldestOpenAgeHours)}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-2 text-end tabular-nums text-money-positive" dir="ltr">{fmt(p.feeDueTotal)}</td>
                      <td className="p-2 text-end text-[11px] text-muted-foreground">
                        {p.lastRemittanceAt ? fmtDateTime(p.lastRemittanceAt as unknown as string) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTableShell>
        </div>
      )}

      {/* ─── تسوية الجهة المختارة ─── */}
      <div className="rounded-xl border bg-card p-4">
        <label className="mb-1.5 block text-sm font-bold">اختر جهة التوصيل</label>
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-11 min-w-64 max-w-md rounded-md border bg-transparent px-3 text-sm" value={partyId} onChange={(e) => { setPartyId(e.target.value); setRows({}); setRemitReqId(crypto.randomUUID()); }}>
            <option value="">— اختر —</option>
            {(obligations.data ?? []).map((p) => (
              <option key={p.partyId} value={p.partyId}>{p.name} — بذمّته {fmt(p.currentBalance)} د.ع</option>
            ))}
          </select>
          {partyId && partyName && (
            <>
              <DeliveryManifestButton partyId={Number(partyId)} partyName={partyName} />
              {partyRow && Number(partyRow.feeDueTotal) > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={payPartyFees.isPending || !currentShift.data?.id}
                  title={!currentShift.data?.id ? "افتح وردية استقبال لصرف الأجور من درج موثَّق" : `صرف ${fmt(partyRow.feeDueTotal)} د.ع مستحقة`}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "صرف كل الأجور المستحقة",
                      description: `صرف ${fmt(partyRow.feeDueTotal)} د.ع عن ${partyName} بسندٍ واحد من وردية الاستقبال #${currentShift.data?.id}.`,
                      confirmText: "صرف",
                    });
                    if (!ok || !currentShift.data?.id) return;
                    payPartyFees.mutate({ partyId: Number(partyId), shiftId: currentShift.data.id, clientRequestId: crypto.randomUUID() });
                  }}
                >
                  <Wallet aria-hidden className="size-3.5" />
                  صرف كل الأجور ({fmt(partyRow.feeDueTotal)} د.ع)
                </Button>
              )}
            </>
          )}
        </div>
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
                  <th className="p-3 text-end">العمر</th>
                  <th className="p-3 text-left">المتوقَّع (COD)</th>
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
                  const ageHours = c.dispatchedAt ? Math.max(0, Math.floor((Date.now() - new Date(c.dispatchedAt as unknown as string).getTime()) / 3600000)) : 0;
                  const ageLevel = deliveryAgeLevel(ageHours);
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">
                        <button type="button" onClick={() => setDrawerId(c.id)} className="text-primary hover:underline">
                          {c.consignmentNumber}
                        </button>
                      </td>
                      <td className="p-3">
                        {c.invoiceId ? (
                          <Link className="font-mono text-xs text-primary hover:underline" dir="ltr" href={`/invoices/${c.invoiceId}`}>
                            {c.invoiceNumber ?? `#${c.invoiceId}`}
                          </Link>
                        ) : "—"}
                      </td>
                      <td className="p-3">{c.customerName ?? c.recipientName ?? "عميل نقدي"}</td>
                      <td className="p-3 text-end">
                        <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-black", DELIVERY_AGE_CLS[ageLevel])} dir="ltr">
                          {formatDeliveryAge(ageHours)}
                        </span>
                      </td>
                      <td className="p-3 text-left tabular-nums" dir="ltr">{fmt(String(remaining))}</td>
                      <td className="p-3 text-center">
                        <div className="inline-flex gap-1">
                          {remittable && (
                            <button
                              type="button"
                              className={cn("rounded px-2 py-1 text-xs font-bold", st.outcome === "COLLECTED" ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-muted text-muted-foreground")}
                              onClick={() => setRows((r) => ({ ...r, [c.id]: { outcome: st.outcome === "COLLECTED" ? "NONE" : "COLLECTED", collected: st.outcome === "COLLECTED" ? "0" : String(remaining) } }))}
                            ><Check aria-hidden className="inline size-3" /> {st.outcome === "COLLECTED" ? "مُحدَّد" : "حدّد"}</button>
                          )}
                          {canReturn && returnable && (
                            <button
                              type="button"
                              className="rounded bg-[var(--sem-warn-bg)] px-2 py-1 text-xs font-bold text-[var(--sem-warn)]"
                              onClick={async () => {
                                const ok = await confirm({ variant: "danger", title: "إرجاع الإرسالية", description: `عكس بيع الإرسالية ${c.consignmentNumber} وإعادة البضاعة للمخزون. متابعة؟`, confirmText: "إرجاع" });
                                if (ok) ret.mutate({ consignmentId: c.id, clientRequestId: crypto.randomUUID() });
                              }}
                            ><RotateCcw aria-hidden className="inline size-3" /> مُرتجَع</button>
                          )}
                          {!remittable && !returnable && feeDue > 0 && <span className="text-xs font-bold text-[var(--sem-warn)]">أجرة مستحقة</span>}
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

          {/* ─── كشف شركة التوصيل (يقلب الأهلية إلى opt-in) ─── */}
          <div className="rounded-xl border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)]/40 p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-black text-[var(--sem-info)]">
                <FileText aria-hidden className="size-4" />
                كشف شركة التوصيل (اختياريّ)
              </div>
              {statementMode && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded bg-card px-2 py-1 font-bold">المحدَّد: <span className="tabular-nums">{totals.selectedCount}</span> من {list.filter((c) => isSettleable(c)).length}</span>
                  <Button size="sm" variant="outline" onClick={selectAll}>تحديد الكل</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRows({})}>مسح التحديد</Button>
                </div>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="stmt-no" className="text-xs">رقم الكشف</Label>
                <Input id="stmt-no" value={statementNumber} maxLength={64} dir="ltr"
                  onChange={(e) => { setStatementNumber(e.target.value); setRows({}); }} placeholder="STMT-…" className="h-9" />
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
            {statementMode && (
              <p className="mt-2 text-[11px] font-bold text-[var(--sem-info)]">
                وضعُ الكشف مُفعَّل: الصفوف تبدأ **غير محدَّدة** (opt-in). حدّد ما ورد في الكشف الورقيّ يدوياً — الأسطر الصفرية تُثبِت التسليم بلا نقد.
              </p>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <div className="flex justify-between border-b py-1.5"><span className="text-muted-foreground">إجمالي التحصيل (COD)</span><span dir="ltr" className="font-bold tabular-nums">{fmt(String(totals.collected))} د.ع</span></div>
              <div className="flex justify-between border-b py-1.5"><span className="text-muted-foreground">الأجور</span><span className="text-xs text-muted-foreground">تُدفع بسند مستقل — استعمل زرّ الصرف المجمّع أعلاه</span></div>
              <div className="flex justify-between border-b py-1.5"><span className="font-bold">النقد المورَّد للمكتبة</span><span dir="ltr" className="font-extrabold tabular-nums text-primary">{fmt(String(totals.net))} د.ع</span></div>
              <div className={cn("flex items-center justify-between py-1.5 font-bold", totals.shortfall > 0.01 ? "text-destructive" : "text-money-positive")}>
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
                  disabled={remit.isPending || companyStatement.isPending || listStillLoading || Math.abs(countedCash - totals.net) > 0.01}
                  title={listStillLoading ? "جارٍ تحميل باقي الإرساليات — التوريد بعد اكتمال العدّ" : undefined}
                >
                  {remit.isPending || companyStatement.isPending
                    ? "جارٍ…"
                    : listStillLoading
                      ? "جارٍ تحميل باقي الإرساليات…"
                      : statementMode
                        ? `تسجيل كشف الشركة ${statementNumber.trim()} وتوريد الصافي`
                        : "تأكيد التسوية وتوريد الصافي"}
                </Button>
              )}
            </div>
            <CashCounter value={countedBreakdown} onChange={(c, total) => { setCountedBreakdown(c); setCountedCash(Number(total)); }} />
          </div>

          {/* ─── سجل التوريدات ─── */}
          {(remittances.data ?? []).length > 0 && (
            <div className="rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <span className="inline-flex items-center gap-2 text-sm font-bold">
                  <FileCheck2 aria-hidden className="size-4 text-primary" />
                  سجل توريدات {partyName} (آخر {(remittances.data ?? []).length})
                </span>
              </div>
              <ScrollTableShell bordered={false}>
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start">رقم السند</th>
                      <th className="p-2 text-start">التاريخ</th>
                      <th className="p-2 text-end">إجمالي التحصيل</th>
                      <th className="p-2 text-end">صافي المورَّد</th>
                      <th className="p-2 text-end">العجز</th>
                      <th className="p-2 text-start">المستلم</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(remittances.data ?? []).map((r) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="p-2 font-mono text-xs" dir="ltr">{r.remittanceNumber}</td>
                        <td className="p-2 text-[11px] text-muted-foreground" dir="ltr">{fmtDateTime(r.receivedAt as unknown as string)}</td>
                        <td className="p-2 text-end tabular-nums" dir="ltr">{fmt(r.collectedTotal)}</td>
                        <td className="p-2 text-end font-bold tabular-nums text-money-positive" dir="ltr">{fmt(r.netRemitted)}</td>
                        <td className="p-2 text-end tabular-nums text-destructive" dir="ltr">{Number(r.shortfallTotal) > 0 ? fmt(r.shortfallTotal) : "—"}</td>
                        <td className="p-2 text-[11px]">{r.receivedByName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTableShell>
            </div>
          )}
        </>
      )}

      {/* درج الخط الزمنيّ من صف التسوية */}
      <ConsignmentTimelineDrawer consignmentId={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}
