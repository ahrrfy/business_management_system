import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  AlertTriangle,
  Check,
  FileCheck2,
  RotateCcw,
  Truck,
  Wallet,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { CashCounter } from "@/components/CashCounter";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { ConsignmentTimelineDrawer } from "@/components/delivery/ConsignmentTimelineDrawer";
import { ReturnConsignmentDialog, type ReturnConsignmentTarget } from "@/components/delivery/ReturnConsignmentDialog";
import { DeliveryManifestButton } from "@/components/delivery/DeliveryManifestButton";
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";
import { CompanyStatementBox } from "@/components/delivery/CompanyStatementBox";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PARTY_EXPOSURE_LABEL_AR } from "@shared/partyExposure";
import { DELIVERY_TERMS as DT } from "@shared/deliveryTerminology";
import { ACTION_LABELS } from "@shared/actionLabels";
import { cn } from "@/lib/utils";
import {
  DELIVERY_AGE_CLS,
  deliveryAgeLevel,
  formatDeliveryAge,
} from "@shared/deliveryAging";

type OpenConsignment = RouterOutputs["delivery"]["openConsignments"]["rows"][number];
type PartyObligation = RouterOutputs["delivery"]["obligations"][number];
type RemittanceRow = RouterOutputs["delivery"]["remittances"][number];

// ───────────────────────── تبويب: تسوية المناديب ─────────────────────────

export function DeliverySettleTab() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ? Number(me.data.branchId) : 0;
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
  /** الطردُ المفتوحُ حوارُ إرجاعه — نفسُ منتقي الدرج المستعمَل في «قيد التوصيل». */
  const [returnTarget, setReturnTarget] = useState<ReturnConsignmentTarget | null>(null);
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

  // note-I (م١): المتبقّي الحيّ للتوريد يطرح **العجزَ المُصنَّف** (`shortfallAssigned` من الخادم) — نقدٌ لم
  // تقبضه الجهة قطّ وحُمِّل عليها ذمّةً. بدونه يحسب هذا أعلى من الحدّ الخادميّ (`recordDeliveryRemittanceInTx`)
  // فيُرفَض كلُّ توريدٍ بعد عجز. مطابقٌ لصيغة `queries.ts`: cod − collected − counterSettled − shortfallAssigned.
  const remainingOf = (c: OpenConsignment) => Math.max(0, Number(c.codAmount) - Number(c.collectedAmount) - Number(c.counterSettledAmount ?? "0") - Number(c.shortfallAssigned ?? "0"));
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
    remit.mutate({
      partyId: Number(partyId),
      lines: validLines,
      countedCash: countedCash.toFixed(2),
      clientRequestId: remitReqId,
    });
  };

  const selectAll = () => {
    const next: Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }> = {};
    for (const c of list) {
      if (isSettleable(c)) next[c.id] = { outcome: "COLLECTED", collected: String(remainingOf(c)) };
    }
    setRows(next);
  };

  /**
   * أعمدةُ «مسؤولية الجهات» — موجة الجداول (٢/٩/٢٦). قائمةُ قراءةٍ خالصة يُختار منها الطرفُ
   * بنقرة صفّ ⇒ `DataTable` بـ`onRowClick`.
   * ⚠️ الترويسة **نصّ** لا عنصر: `DataTable` يشتقّ منها تسميةَ منتقي الأعمدة ورأسَ «نسخ
   * العمود»، فالعنصرُ يُفقدهما ويُرجع `id` الإنجليزيّ. شروحُ المصطلحات (`DELIVERY_TERMS`)
   * انتقلت إلى `title` على الخليّة نفسها — تبقى متاحةً بالمرور ولا تُفسد النسخ.
   */
  const obligationColumns = useMemo<ColumnDef<PartyObligation, unknown>[]>(
    () => [
      {
        id: "party",
        header: "الجهة",
        accessorFn: (p) => p.name,
        meta: { width: "wide" },
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 font-bold">
            {row.original.name}
            {!row.original.hasPortal && (
              <span className="rounded bg-[var(--sem-info-bg)] px-1 py-px text-[9px] font-bold text-[var(--sem-info)]" title="تُدار بكشف الشركة لا ببوّابة سائق">كشف</span>
            )}
          </div>
        ),
      },
      {
        id: "currentBalance",
        header: "بذمته",
        accessorFn: (p) => fmt(p.currentBalance),
        meta: { kind: "money" },
        /* شرحُ الترويسة القديم مدموجٌ في `title` الخليّة: الترويسة نصٌّ لا عنصر، فلا `title` عليها. */
        cell: ({ row }) => (
          <span className="font-bold" title="مسؤوليّة الدفتر على المندوب (نقدٌ قبضه + عجزٌ قبله ذمّةً بموجب SHORTFALL_ASSIGNED). قد تحوي جزءاً غير نقديّ.">
            {fmt(row.original.currentBalance)}
          </span>
        ),
      },
      {
        id: "openCount",
        header: DT.openParcelsCount.compact,
        accessorFn: (p) => String(p.openCount),
        /* خليّةٌ مركَّبة (عددٌ + شارةٌ عربية) — مثل «العمر» أدناه: `kind: "number"` كان يلفّها
           بـ`<bdi dir="ltr">` فينقلب ترتيبُها البصريّ في RTL (تسبق الشارةُ العددَ)، فنكتفي
           بالمحاذاة ونفرز على العدد الخام. */
        meta: { align: "end" },
        sortingFn: (a, b) => Number(a.original.openCount) - Number(b.original.openCount),
        cell: ({ row }) => (
          <span title={DT.openParcelsCount.tooltip}>
            <span className="tabular-nums">{row.original.openCount}</span>
            {/* Slice DFP2: النصّ بلا تشكيل («سلم» بدل «سُلِّم») + فاصلة بصريّة كبيرة. */}
            {row.original.deliveredAwaitingRemitCount > 0 && (
              <span
                className="ms-2 rounded-md bg-[var(--sem-pos-bg)] px-1.5 py-0.5 text-[10px] font-black text-[var(--sem-pos)]"
                title={`${row.original.deliveredAwaitingRemitCount} طرود سُلِّمت للعميل — النقد بعدُ بيد المندوب`}
              >
                سلم {row.original.deliveredAwaitingRemitCount}
              </span>
            )}
          </span>
        ),
      },
      {
        id: "codDueTotal",
        header: "قيد التحصيل",
        accessorFn: (p) => fmt(p.codDueTotal),
        meta: { kind: "money" },
        /* شرحُ الترويسة القديم مدموجٌ في `title` الخليّة — وهو الأدقّ: العمود يجمع **كلّ**
           الطرود المفتوحة لا المسلَّمة منها وحدها، فلا يكفي `deliveredUncollected` وحده. */
        cell: ({ row }) => (
          <span
            className="font-black text-[var(--sem-warn)]"
            title={`متبقّي COD على كلّ الطرود المفتوحة (بالطريق + مسلَّمة بلا قبض). ${DT.deliveredUncollected.tooltip}`}
          >
            {fmt(row.original.codDueTotal)}
          </span>
        ),
      },
      {
        id: "oldestOpenAge",
        header: DT.oldestOpenAge.compact,
        accessorFn: (p) => (p.oldestOpenAgeHours != null ? formatDeliveryAge(p.oldestOpenAgeHours) : "—"),
        meta: { align: "end", width: "status" },
        /* استثناءٌ مقصود: «37 س» و«5 أيام» لا تُقارَنان نصّياً ولا رقمياً — نفرز على الساعات. */
        sortingFn: (a, b) => Number(a.original.oldestOpenAgeHours ?? -1) - Number(b.original.oldestOpenAgeHours ?? -1),
        cell: ({ row }) =>
          row.original.oldestOpenAgeHours != null ? (
            <span
              className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-black", DELIVERY_AGE_CLS[deliveryAgeLevel(row.original.oldestOpenAgeHours)])}
              dir="ltr"
              title={DT.oldestOpenAge.tooltip}
            >
              {formatDeliveryAge(row.original.oldestOpenAgeHours)}
            </span>
          ) : (
            "—"
          ),
      },
      {
        id: "feeDueTotal",
        header: PARTY_EXPOSURE_LABEL_AR.feesOwedToThem,
        accessorFn: (p) => fmt(p.feeDueTotal),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className="text-money-positive" title={DT.feesOwedToCourier.tooltip}>
            {fmt(row.original.feeDueTotal)}
          </span>
        ),
      },
      {
        id: "lastRemittanceAt",
        header: DT.lastRemittanceAt.compact,
        accessorFn: (p) => (p.lastRemittanceAt ? fmtDateTime(p.lastRemittanceAt as unknown as string) : "—"),
        meta: { kind: "datetime", align: "end" },
        cell: ({ row }) => (
          <span className="text-[11px] text-muted-foreground" title={DT.lastRemittanceAt.tooltip}>
            {row.original.lastRemittanceAt ? fmtDateTime(row.original.lastRemittanceAt as unknown as string) : "—"}
          </span>
        ),
      },
    ],
    [],
  );

  /** أعمدةُ «سجل التوريدات» — قائمةُ سنداتٍ للقراءة وحدها (٢٠ الأحدث). */
  const remittanceColumns = useMemo<ColumnDef<RemittanceRow, unknown>[]>(
    () => [
      { id: "remittanceNumber", header: "رقم السند", accessorFn: (r) => r.remittanceNumber ?? "—", meta: { kind: "code" }, cell: ({ row }) => row.original.remittanceNumber ?? "—" },
      {
        id: "receivedAt",
        header: "التاريخ",
        accessorFn: (r) => fmtDateTime(r.receivedAt as unknown as string),
        meta: { kind: "datetime", align: "start" },
        cell: ({ row }) => <span className="text-[11px] text-muted-foreground">{fmtDateTime(row.original.receivedAt as unknown as string)}</span>,
      },
      { id: "collectedTotal", header: "إجمالي التحصيل", accessorFn: (r) => fmt(r.collectedTotal), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.collectedTotal) },
      {
        id: "netRemitted",
        header: "صافي التوريد",
        accessorFn: (r) => fmt(r.netRemitted),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="font-bold text-money-positive">{fmt(row.original.netRemitted)}</span>,
      },
      {
        id: "shortfallTotal",
        header: "العجز",
        accessorFn: (r) => (Number(r.shortfallTotal) > 0 ? fmt(r.shortfallTotal) : "—"),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className="text-destructive">{Number(row.original.shortfallTotal) > 0 ? fmt(row.original.shortfallTotal) : "—"}</span>
        ),
      },
      {
        id: "receivedByName",
        header: "المستلم",
        accessorFn: (r) => r.receivedByName ?? "—",
        meta: { kind: "actor" },
        cell: ({ row }) => <span className="text-[11px]">{row.original.receivedByName ?? "—"}</span>,
      },
    ],
    [],
  );

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

      {/* ─── جدول التزامات الجهات — الأقدم أولاً (Slice DFP2: تسميات مُوحَّدة من deliveryTerminology) ─── */}
      {(obligations.data ?? []).length === 0 ? (
        <EmptyState icon={Wallet} title="لا مسؤوليات مالية مفتوحة" description="كل الجهات سوّت مسؤوليّاتها الماليّة — لا نقدٌ بيد أحدٍ ولا طرودٌ مفتوحة." />
      ) : (
        <div className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <span className="text-sm font-bold">مسؤولية الجهات ({(obligations.data ?? []).length})</span>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className="rounded-md border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] px-2 py-1 font-bold text-[var(--sem-warn)]"
                title="متبقّي COD على كلّ الطرود المفتوحة (بالطريق للعميل + مسلَّمة بلا قبض) — يشمل كلّ إرساليّة لم تُغلَق ماليّاً بعد."
              >
                إجمالي COD المفتوح: <span className="tabular-nums" dir="ltr">{fmt(totalObligationExposure)}</span> د.ع
              </span>
              <span
                className="rounded-md border border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] px-2 py-1 font-bold text-[var(--sem-info)]"
                title={DT.feesOwedToCourier.tooltip}
              >
                {DT.feesOwedToCourier.compact}: <span className="tabular-nums" dir="ltr">{fmt(totalFeesDue)}</span> د.ع
              </span>
            </div>
          </div>
          {/* `embedded`: العنوان والعدّ في ترويسة البطاقة أعلاه ⇒ لا شريطَ حالةٍ ثانياً. */}
          <DataTable<PartyObligation>
            columns={obligationColumns}
            data={obligations.data ?? []}
            embedded
            searchable={false}
            pageSize={Infinity}
            loading={obligations.isLoading}
            errorState={{ isError: obligations.isError, message: obligations.error?.message, onRetry: () => void obligations.refetch() }}
            onRowClick={(p) => { setPartyId(String(p.partyId)); setRows({}); setRemitReqId(crypto.randomUUID()); }}
            getRowClassName={(p) => (String(p.partyId) === partyId ? "bg-primary/5" : undefined)}
            emptyText="لا مسؤوليات مالية مفتوحة."
          />
        </div>
      )}

      {/* ─── تسوية الجهة المختارة ─── */}
      <div className="rounded-xl border bg-card p-4">
        <label htmlFor="delivery-settle-party" className="mb-1.5 block text-sm font-bold">اختر جهة التوصيل</label>
        <div className="flex flex-wrap items-center gap-2">
          {/* w-auto يُبطل w-full المدمج في الـtrigger كي تبقى الأزرار على نفس السطر (السلوك القائم). */}
          <AppSelect
            id="delivery-settle-party"
            className="w-auto min-w-64 max-w-md"
            value={partyId}
            onValueChange={(value) => { setPartyId(value); setRows({}); setRemitReqId(crypto.randomUUID()); }}
          >
            <option value="">— اختر —</option>
            {(obligations.data ?? []).map((p) => (
              <option key={p.partyId} value={p.partyId}>{p.name} — نقد بيده {fmt(p.currentBalance)} د.ع</option>
            ))}
          </AppSelect>
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
        <div className="p-8 text-center text-muted-foreground">{ACTION_LABELS.loading}</div>
      ) : list.length === 0 ? (
        <EmptyState icon={Truck} title="لا التزامات مفتوحة" description="لا توجد مبالغ للتوريد أو أجور للدفع أو إرساليات قابلة للإرجاع لهذه الجهة." />
      ) : (
        <>
          {/* شبكةُ تحرير لا عرض (موجة الجداول ٢/٩/٢٦): كل صفٍّ يحمل مفتاحَ «حصل/لم يحصل»
              وحقلَ «المبلغ المقبوض» يكتبان في حالة `rows` المحلّية التي يُبنى منها سندُ
              التوريد — `DataTable` أداةُ عرضٍ فتبقى هذه خامّةً عن قصد. */}
          <ScrollTableShell className="bg-card">
            <table className="w-full text-sm">
              {/* Slice DFP2: أسماء أعمدة صريحة — «الحالة» تحوّلت إلى «قرار المندوب»
                  لأنّ محتواها زرّ إجراء لا شارة حالة. «المتوقَّع (COD)» → «المطلوب تحصيله». */}
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-right">الإرسالية</th>
                  <th className="p-3 text-right">الفاتورة</th>
                  <th className="p-3 text-right">العميل</th>
                  <th className="p-3 text-end">العمر</th>
                  <th className="p-3 text-left" title="مبلغُ COD المطلوب تحصيله من الزبون">المطلوب تحصيله</th>
                  <th className="p-3 text-center">قرار المندوب</th>
                  <th className="p-3 text-left">المبلغ المقبوض</th>
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
                              title={st.outcome === "COLLECTED" ? "المندوب حصّل هذا الطرد — انقر لإلغاء" : "انقر لتأكيد أنّ المندوب حصّل هذا الطرد"}
                            ><Check aria-hidden className="inline size-3" /> {st.outcome === "COLLECTED" ? "حصل" : "لم يحصل"}</button>
                          )}
                          {canReturn && returnable && (
                            <button
                              type="button"
                              className="rounded bg-[var(--sem-warn-bg)] px-2 py-1 text-xs font-bold text-[var(--sem-warn)]"
                              onClick={() => setReturnTarget({
                                consignmentId: c.id,
                                label: `الإرسالية ${c.consignmentNumber}`,
                              })}
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

          {/* ─── كشف شركة التوصيل (يقلب الأهلية إلى opt-in) + مطابقته الحيّة مطابق/مختلف/مفقود (م١ PR-C) ─── */}
          <CompanyStatementBox
            statementNumber={statementNumber} onStatementNumberChange={(v) => { setStatementNumber(v); setRows({}); }}
            statementDate={statementDate} onStatementDateChange={setStatementDate}
            deductions={statementDeductions} onDeductionsChange={setStatementDeductions}
            notes={statementNotes} onNotesChange={setStatementNotes}
            onSelectAll={selectAll} onClearSelection={() => setRows({})}
            lines={list.filter((c) => isSettleable(c)).map((c) => ({ consignmentId: c.id, consignmentNumber: c.consignmentNumber, remaining: String(remainingOf(c)), selected: get(c).outcome === "COLLECTED", collected: get(c).collected }))}
          />

          {/**
           * Slice DFP2 (٣١/٨/٢٦) — إعادة تصميم بطاقة توريد التسوية:
           *   ١) حذف صفّ «الأجور» الفارغ من الرقم (كان نصّاً وحسب — يبدو خالياً).
           *   ٢) تصحيح كذبة «عجز يبقى ذمّةً على المندوب» — مسار remittance يبقي العجز على
           *      **العميل** (moneyStatus=PARTIAL بلا SHORTFALL_ASSIGNED). التسمية القديمة كانت
           *      كذبةً محاسبيّة على الكاشير.
           *   ٣) إزالة اللون الأحمر من «فرق العدّ» عند countedCash=0 (لم يبدأ العدّ بعد) —
           *      كان يفتح الشاشة برسالة خطأ مقلقة بلا سبب.
           *   ٤) الزرّ بلون رمادي واضح عند تعذّر التسوية بدل أزرق نشط مضلِّل.
           */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <div className="flex justify-between border-b py-1.5">
                <span className="text-muted-foreground">إجمالي التحصيل (COD)</span>
                <span dir="ltr" className="font-bold tabular-nums">{fmt(String(totals.collected))} د.ع</span>
              </div>
              <div className="flex justify-between border-b py-1.5">
                <span className="font-bold">النقد المتوقَّع توريده</span>
                <span dir="ltr" className="font-extrabold tabular-nums text-primary">{fmt(String(totals.net))} د.ع</span>
              </div>
              {totals.shortfall > 0.01 && (
                <div className="flex items-center justify-between border-b py-1.5 font-bold text-[var(--sem-warn)]">
                  <span className="inline-flex items-center gap-1" title={DT.requestedFromCustomer.tooltip}>
                    <AlertTriangle aria-hidden className="size-3.5" />
                    متبقٍّ على العميل (لم يُقبَض من المندوب بعد)
                  </span>
                  <span dir="ltr" className="tabular-nums">{fmt(String(totals.shortfall))} د.ع</span>
                </div>
              )}
              {(() => {
                /**
                 * Codex #908 P1: كشفٌ بأسطرَ صفريّةٍ فقط (إثبات تسليم بلا نقد) يجعل
                 * `totals.net = 0` و`countedCash = 0` — يجب أن يمرّ كمطابقةٍ صحيحة.
                 * المقارنةُ المباشرةُ الآن: (0, 0) → مطابق تام (وليس «لم يبدأ العدّ»).
                 * الاختلاف عن الحالة «لم يبدأ» = وجود صافٍ متوقَّع (`totals.net > 0`).
                 */
                const cashDiff = countedCash - totals.net;
                const isMatch = Math.abs(cashDiff) < 0.01;
                const needsInput = totals.net > 0.01 && countedCash === 0;
                const tone = needsInput ? "text-muted-foreground"
                  : isMatch ? "text-money-positive"
                  : "text-money-negative";
                const label = needsInput ? "أدخل النقد المعدود لبدء التسوية"
                  : isMatch ? "النقد المعدود مطابق للصافي"
                  : "فرق العد — سو المعدود قبل التسوية";
                return (
                  <div className={cn("flex items-center justify-between border-t py-1.5 font-bold", tone)}>
                    <span>{label}</span>
                    <span dir="ltr" className="tabular-nums">{needsInput ? "—" : `${fmt(String(cashDiff))} د.ع`}</span>
                  </div>
                );
              })()}
              {canRemit && (() => {
                // Codex P1: مقارنة مباشرة (تسمح بـ 0=0 لكشف الإثبات الصفريّ).
                const cashMatched = Math.abs(countedCash - totals.net) < 0.01;
                const needsInput = totals.net > 0.01 && countedCash === 0;
                const isBlocked = remit.isPending || companyStatement.isPending || listStillLoading || !cashMatched;
                return (
                  <Button
                    className="mt-3 w-full"
                    variant={isBlocked ? "secondary" : "default"}
                    onClick={submit}
                    disabled={isBlocked}
                    title={
                      listStillLoading ? "جارٍ تحميل باقي الإرساليات — التوريد بعد اكتمال العدّ"
                      : needsInput ? "أدخل النقد المعدود المطابق للصافي المتوقَّع قبل التوريد"
                      : !cashMatched ? "النقد المعدود لا يطابق الصافي — سو الفرق قبل التوريد"
                      : undefined
                    }
                  >
                    {remit.isPending || companyStatement.isPending
                      ? "جار…"
                      : listStillLoading
                        ? "جار تحميل باقي الإرساليات…"
                        : statementMode
                          ? `تسجيل كشف الشركة ${statementNumber.trim()} وتوريد الصافي`
                          : "تأكيد التسوية وتوريد الصافي"}
                  </Button>
                );
              })()}

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
              {/* `embedded`: العنوان والعدّ في ترويسة البطاقة أعلاه ⇒ لا شريطَ حالةٍ ثانياً. */}
              <DataTable<RemittanceRow>
                columns={remittanceColumns}
                data={remittances.data ?? []}
                embedded
                searchable={false}
                pageSize={Infinity}
                loading={remittances.isLoading}
                errorState={{ isError: remittances.isError, message: remittances.error?.message, onRetry: () => void remittances.refetch() }}
                emptyText="لا توريدات سابقة لهذه الجهة."
              />
            </div>
          )}
        </>
      )}

      {/* حوار إرجاع الطرد — يحمل منتقي درج الردّ الذي كان مفقوداً */}
      <ReturnConsignmentDialog
        target={returnTarget}
        pending={ret.isPending}
        onClose={() => setReturnTarget(null)}
        onConfirm={({ consignmentId, refundShiftId }) => {
          ret.mutate({ consignmentId, clientRequestId: crypto.randomUUID(), refundShiftId });
          setReturnTarget(null);
        }}
      />

      {/* درج الخط الزمنيّ من صف التسوية */}
      <ConsignmentTimelineDrawer consignmentId={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}
