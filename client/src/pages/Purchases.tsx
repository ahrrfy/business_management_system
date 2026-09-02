import { Link } from "wouter";
import { balanceOptionText } from "@/components/BalanceBadge";
import { allocateLineTax } from "@/components/invoice";
import { PurchaseIntegrityPanel } from "@/components/purchases/PurchaseIntegrityPanel";
import { PurchaseCancellationDialog } from "@/components/purchases/PurchaseCancellationDialog";
import { CopyInline } from "@/components/CopyButton";
import { ActorCell } from "@/components/data-table/ActorCell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { useFocusHighlight } from "@/components/search/useFocusHighlight";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D, fmt, positiveDiff, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { CO } from "@/lib/printing/brand";
import { printPurchaseInvoiceV2 } from "@/lib/printing/printTemplatesV2";
import { qrCodeSvg } from "@/lib/printing/qr";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";

// نوع صفّ أمر الشراء (يوحّد فرعَي الإخراج: المُقنَّع cost=null وغير المُقنَّع).
type PurchaseRow = RouterOutputs["purchases"]["list"][number];

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

// ٢٤/٨ (تدقيق): شارات ألوان بدل نصٍّ خام — الفحص البصريّ للطابور صار ممكناً بلمحة.
// pending: مسوّدة/مُرسَل — لم يُعتمَد بعد.
// active: مؤكّد/مُستلَم — سارٍ.
// cancelled: ملغى.
const PO_STATUS_CLASS: Record<string, string> = {
  DRAFT: "badge-status-pending",
  SENT: "badge-status-pending",
  CONFIRMED: "badge-status-active",
  RECEIVED: "badge-status-active",
  CANCELLED: "badge-status-cancelled",
};

const SETTLEMENT_TYPE: Record<string, string> = {
  CASH: "نقدي",
  CREDIT: "آجل",
};

const SETTLEMENT_CLASS: Record<string, string> = {
  CASH: "badge-status-active",
  CREDIT: "badge-status-pending",
};

/** حجم صفحة القائمة — الخادم يُرقّم. */
const PAGE_SIZE = 50;

export default function Purchases() {
  const utils = trpc.useUtils();
  const controlKeysRef = useRef(new Map<string, string>());
  const [cancelTarget, setCancelTarget] = useState<{
    id: number;
    poNumber: string;
    total: string;
    version: number;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  function controlKey(kind: "SUBMIT" | "CANCEL", id: number, version: number) {
    const key = `${kind}:${id}:${version}`;
    const existing = controlKeysRef.current.get(key);
    if (existing) return existing;
    const created = `purchase-${kind.toLowerCase()}-${id}-${version}-${crypto.randomUUID()}`;
    controlKeysRef.current.set(key, created);
    return created;
  }
  // فلاتر خادمية محفوظة في querystring (نمط Invoices.tsx): تعيش مع فتح التفاصيل والرجوع، وتُشارَك
  // رابطاً. لا فلترة محلية تُخفي صفحات الخادم — كل القيم نصوص تُحوَّل عند حدود الـAPI.
  const [f, setF, resetF] = useUrlFilters({
    q: "",
    from: "",
    to: "",
    supplierId: "",
    status: "",
    branchId: "",
  });
  // الترقيم خادميّ: كانت تُحمَّل ٢٠٠ دفعةً بلا offset ⇒ الأمر ٢٠١ غير قابل للوصول.
  const [page, setPage] = useState(0);

  // الميل الأخير للبحث الشامل: عند الوصول بـ?q=&focus= نبذر البحث (يُصفّي للأمر) ثمّ نُبرز صفّه.
  const { seedQuery, rowProps } = useFocusHighlight();
  useEffect(() => {
    if (seedQuery) setF({ q: seedQuery });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery]);

  // البحث خادمي الآن (q ممهَّل) ⇒ يطابق رقم الأمر/اسم المورد/الملاحظات عبر كل النتائج لا الصفحة فقط.
  const dq = useDebouncedValue(f.q, 250);
  const statusArg = (f.status || undefined) as
    | "DRAFT"
    | "SENT"
    | "CONFIRMED"
    | "RECEIVED"
    | "CANCELLED"
    | undefined;

  const me = trpc.auth.me.useQuery();
  const canManagePurchases =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "purchases",
      "FULL",
      ["manager", "purchasing"],
    );
  const pendingControls = trpc.purchases.pendingControls.useQuery(
    { limit: 200 },
    { enabled: canManagePurchases },
  );
  const pendingOrderIds = useMemo(
    () =>
      new Set(
        (pendingControls.data?.rows ?? [])
          .filter((row) => row.documentType === "PURCHASE_ORDER")
          .map((row) => Number(row.purchaseOrderId)),
      ),
    [pendingControls.data],
  );
  const controlStateUnavailable =
    canManagePurchases &&
    (pendingControls.isLoading || pendingControls.isError);
  // فلتر الفرع وعموده — للمرتفعين العابرين للفروع فقط (الخادم يتجاهل branchId لغيرهم أصلاً:
  // scopedBranchId الحاكم في buildPurchasesListConds، فالإخفاء هنا عرضيّ لا أمنيّ — نمط Invoices.tsx).
  const canCrossBranches =
    me.data?.role === "admin" || me.data?.isOwner === true;
  // ٢٤/٨ (Codex P2 على PR #749): تبويبُ الوجهة `statement` في `SuppliersHub` مُحصَّنٌ
  // بـ`managerOnly` صراحةً — لا يحترم `permissionsOverride`. مستخدمُ شراءٍ مخصَّصٌ مُنِح
  // `reports:READ` صراحةً كان يرى الرابط ثمّ يُدفَع خارج التبويب. البوّابة الصحيحة الوحيدة
  // هنا: **الدور** (لا `moduleAccessAllowed`). حين يُحدَّث الوجهةُ لتحترم reports، ترجع
  // البوّابةُ إليها؛ إلى ذلك الحين نُطابق `managerOnly` بالحرف.
  const canOpenSupplierStatement =
    me.data?.role === "admin" || me.data?.role === "manager";
  const canViewIntegrity = canManagePurchases;
  const integrityBranchId =
    me.data?.role === "admin"
      ? f.branchId
        ? Number(f.branchId)
        : undefined
      : undefined;
  const branches = trpc.branches.list.useQuery(undefined, {
    enabled: canCrossBranches,
  });
  const branchNames = useMemo(
    () => new Map((branches.data ?? []).map((b) => [b.id, b.name])),
    [branches.data],
  );
  const showBranchCol = canCrossBranches && !f.branchId;

  const listInput = useMemo(
    () => ({
      from: f.from || undefined,
      to: f.to || undefined,
      supplierId: f.supplierId ? Number(f.supplierId) : undefined,
      status: statusArg,
      branchId: canCrossBranches && f.branchId ? Number(f.branchId) : undefined,
      q: dq.trim() || undefined,
    }),
    [f.from, f.to, f.supplierId, statusArg, canCrossBranches, f.branchId, dq],
  );

  // عدّاد الفلاتر المفعّلة (بلا حقل البحث — اتفاقية ListToolbar) لزرّ «مسح الفلاتر».
  const activeFilterCount = [
    f.from || f.to,
    f.supplierId,
    f.status,
    canCrossBranches ? f.branchId : "",
  ].filter(Boolean).length;

  const suppliers = trpc.suppliers.list.useQuery();
  const supplierContacts = useMemo(
    () => new Map((suppliers.data ?? []).map((s) => [Number(s.id), s])),
    [suppliers.data],
  );
  const query = trpc.purchases.list.useQuery({
    ...listInput,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const rows: PurchaseRow[] = query.data ?? [];
  // الإجمالي من listCount (نفس buildPurchasesListConds ⇒ مطابق للصفوف بالبناء) — لا rows.length
  // الذي صار طول الصفحة بعد الترقيم.
  const countQ = trpc.purchases.listCount.useQuery(listInput);
  const total = countQ.data?.count;

  // أي تغيير في الفلاتر/البحث يعيدنا للصفحة الأولى.
  useEffect(() => {
    setPage(0);
  }, [listInput]);

  const cancelMut = trpc.purchases.cancel.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.purchases.list.invalidate(),
        utils.purchases.pendingControls.invalidate(),
      ]);
      notify.ok(
        "أُرسل طلب إلغاء صفري الأثر — لا يتغيّر الأمر قبل اعتماد مستخدم مستقل",
      );
      setCancelTarget(null);
      setCancelReason("");
    },
    onError: (e) => notify.err(e),
  });

  const confirmMut = trpc.purchases.confirmOrder.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.purchases.list.invalidate(),
        utils.purchases.pendingControls.invalidate(),
      ]);
      notify.ok(
        "أُرسلت الفاتورة للاعتماد المستقل؛ الاعتماد النهائي سيضيف كامل الكميات إلى المخزون",
      );
    },
    onError: (e) => notify.err(e),
  });

  // الإرسال صفري الأثر؛ الاعتماد المستقل اللاحق يستلم الفاتورة ويرحّلها كاملةً.
  async function confirmOrder(p: {
    id: number;
    poNumber: string;
    version: number;
  }) {
    const ok = await confirm({
      variant: "info",
      title: "إرسال أمر الشراء للاعتماد",
      description: `سيُرسل الأمر ${p.poNumber} إلى مراجع مستقل. عند اعتماده تُضاف كامل الكميات إلى المخزون مباشرةً.`,
      confirmText: "إرسال للاعتماد",
      cancelText: "تراجع",
      requireText: p.poNumber,
      requireTextLabel: `اكتب رقم الأمر ${p.poNumber} لتأكيد المراجعة والاعتماد المستقل`,
    });
    if (!ok) return;
    confirmMut.mutate({
      purchaseOrderId: p.id,
      expectedVersion: p.version,
      reason: `إرسال المراجعة الحالية للأمر ${p.poNumber} بعد إكمال بيانات المورد والبنود والأسعار`,
      clientRequestId: controlKey("SUBMIT", p.id, p.version),
    });
  }

  // إلغاء أمر شراء لم يُستلم منه شيء — الحارس النهائي في الخادم (يرفض أي أمر استُلمت منه بضاعة).
  function cancelOrder(p: {
    id: number;
    poNumber: string;
    total: string;
    version: number;
  }) {
    setCancelReason("");
    setCancelTarget(p);
  }

  function submitCancellation() {
    if (!cancelTarget || cancelReason.trim().length < 3) return;
    cancelMut.mutate({
      purchaseOrderId: cancelTarget.id,
      expectedVersion: cancelTarget.version,
      reason: cancelReason.trim(),
      requestKey: controlKey("CANCEL", cancelTarget.id, cancelTarget.version),
    });
  }

  // طباعة أمر الشراء من القائمة: نجلب التفاصيل (purchases.get) ثم نطبع بالقالب عالي الدقّة V2
  // (gap-audit ٥/٧: printPurchaseInvoiceV2 كان مكتوباً في PR #140 بلا مستهلِك — رُبط هنا).
  async function printOrder(purchaseOrderId: number) {
    try {
      const d = await utils.purchases.get.fetch({ purchaseOrderId });
      if (!d) {
        notify.err("تعذّر جلب أمر الشراء");
        return;
      }
      const remaining = positiveDiff(d.total, d.paidAmount);
      const taxShares = allocateLineTax(
        d.items.map((it) => ({ total: String(it.total ?? "0") })),
        String(d.taxAmount ?? "0"),
        round2(D(d.subtotal ?? "0")).toFixed(2),
      );
      const statusColor =
        d.status === "RECEIVED"
          ? "#0D6B52"
          : d.status === "CANCELLED"
            ? "#8A1F11"
            : "#92400E";
      // QR حقيقي ببيانات الأمر (كان القالب يطبع placeholder زخرفياً غير قابل للمسح).
      const qrSvg = await qrCodeSvg(
        [
          CO.sub,
          `أمر شراء: ${d.poNumber}`,
          `الإجمالي: ${fmt(d.total ?? 0)} د.ع`,
        ].join("\n"),
        { size: 88, margin: 1 },
      ).catch(() => "");
      printPurchaseInvoiceV2({
        qrSvg: qrSvg || null,
        invoiceNumber: d.poNumber,
        invoiceDate: d.orderDate as unknown as string | null,
        statusLabel: `${PO_STATUS[d.status] ?? d.status} · ${SETTLEMENT_TYPE[d.settlementType] ?? d.settlementType}`,
        statusColor,
        supplierName: d.supplierName,
        items: d.items.map((it, index) => ({
          productName: it.productName ?? "",
          unitName: it.unitName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          taxAmount: taxShares[index] ?? "0",
          total: it.total,
        })),
        subtotal: d.subtotal ?? "0",
        taxAmount: d.taxAmount ?? "0",
        taxRate: Number(d.taxRatePercent ?? 0),
        total: d.total ?? "0",
        paidAmount: d.paidAmount ?? "0",
        remainingAmount: remaining.toFixed(2),
      });
    } catch (e) {
      notify.err(e);
    }
  }

  return (
    <div className="space-y-2.5">
      <Card className="gap-0 py-0">
        <CardHeader className="p-0">
          <ListToolbar
            title="المشتريات"
            pageTitle
            count={total}
            loading={query.isLoading}
            search={{
              value: f.q,
              onChange: (v) => setF({ q: v }),
              placeholder: "بحث (رقم الأمر/المورد/ملاحظات)",
              // ٢٤/٨ (تدقيق): مسؤول المشتريات يفتح ويكتب فوراً — تركيزٌ تلقائيّ يمنع ضياع الحرف الأوّل.
              autoFocus: true,
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            filters={
              <>
                {/* E (١٢/٨): FilterField يُظهر التسمية دائماً — Placeholder وحده يختفي عند الاختيار
                    فيضيع معنى الحقل. صندوق الفلاتر الموحّد (ListToolbar) يوفّر المساحة الآن. */}
                <FilterField label="من تاريخ">
                  <Input
                    type="date"
                    dir="ltr"
                    className="h-8 w-36"
                    value={f.from}
                    onChange={(e) => setF({ from: e.target.value })}
                  />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input
                    type="date"
                    dir="ltr"
                    className="h-8 w-36"
                    value={f.to}
                    onChange={(e) => setF({ to: e.target.value })}
                  />
                </FilterField>
                <FilterField label="المورد">
                  <AppSelect
                    size="sm"
                    value={f.supplierId || "ALL"}
                    onValueChange={(supplierId) =>
                      setF({
                        supplierId: supplierId === "ALL" ? "" : supplierId,
                      })
                    }
                  >
                    <option value="ALL">— كل الموردين —</option>
                    {(suppliers.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {balanceOptionText(
                          (s as { currentBalance?: string | null })
                            .currentBalance,
                          "supplier",
                        )}
                      </option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="الحالة">
                  <AppSelect
                    size="sm"
                    value={f.status || "ALL"}
                    onValueChange={(status) =>
                      setF({ status: status === "ALL" ? "" : status })
                    }
                  >
                    <option value="ALL">— كل الحالات —</option>
                    {Object.entries(PO_STATUS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </AppSelect>
                </FilterField>
                {canCrossBranches && (
                  <FilterField label="الفرع">
                    <AppSelect
                      size="sm"
                      value={f.branchId || "ALL"}
                      onValueChange={(branchId) =>
                        setF({ branchId: branchId === "ALL" ? "" : branchId })
                      }
                    >
                      <option value="ALL">— كل الفروع —</option>
                      {(branches.data ?? []).map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </AppSelect>
                  </FilterField>
                )}
              </>
            }
            exportSpec={{
              filename: "المشتريات",
              rows,
              fetchAll: () =>
                fetchAllPaged<PurchaseRow>(
                  (offset, limit) =>
                    utils.purchases.list
                      .fetch({ ...listInput, limit, offset })
                      .then((arr) => ({ rows: (arr ?? []) as PurchaseRow[] })),
                  { pageSize: 500 },
                ),
              columns: [
                { key: "poNumber", header: "رقم الأمر" },
                { key: "supplierName", header: "المورد" },
                {
                  key: "createdByName",
                  header: "منشئ الأمر",
                  map: (r) =>
                    r.createdByName ??
                    (r.createdBy ? `مستخدم #${r.createdBy}` : "بيانات قديمة"),
                },
                {
                  key: "orderDate",
                  header: "التاريخ",
                  map: (r) => fmtDate(r.orderDate),
                },
                {
                  key: "total",
                  header: "الإجمالي",
                  map: (r) => Number(r.total ?? 0),
                },
                {
                  key: "usdTotal",
                  header: "فاتورة المورد $",
                  map: (r) => Number(r.usdTotal ?? 0),
                },
                {
                  key: "agreedRate",
                  header: "سعر التثبيت",
                  map: (r) => Number(r.agreedRate ?? 0),
                },
                {
                  key: "paidAmount",
                  header: "المدفوع",
                  map: (r) => Number(r.paidAmount ?? 0),
                },
                {
                  key: "settlementType",
                  header: "التسوية",
                  map: (r) =>
                    SETTLEMENT_TYPE[r.settlementType] ?? r.settlementType,
                },
                {
                  key: "status",
                  header: "الحالة",
                  map: (r) => PO_STATUS[r.status] ?? r.status,
                },
              ],
            }}
            add={
              canManagePurchases
                ? { href: "/purchases/new", label: "أمر شراء جديد" }
                : undefined
            }
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false} showColumnVisibility={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">رقم الأمر</th>
                  <th className="p-2">المورد</th>
                  {/* عمود «الفرع» — للمرتفعين حين الفلتر «كل الفروع» فقط (نمط Invoices.tsx). */}
                  {showBranchCol && <th className="p-2">الفرع</th>}
                  <th className="p-2">التاريخ</th>
                  <th className="p-2 text-right">الإجمالي</th>
                  <th className="p-2 text-right">فاتورة المورد</th>
                  <th className="p-2 text-right">سعر التثبيت</th>
                  <th className="p-2 text-right">المتبقي</th>
                  <th className="p-2">التسوية</th>
                  <th className="p-2">الحالة</th>
                  <th className="p-2">منشئ الأمر</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const terminal =
                    p.status === "RECEIVED" || p.status === "CANCELLED";
                  const needsConfirmation = p.status === "DRAFT";
                  const awaitingApproval = p.status === "SENT";
                  const hasPendingControl = pendingOrderIds.has(Number(p.id));
                  const fr = rowProps(p.id);
                  return (
                    <tr
                      key={p.id}
                      ref={fr.ref}
                      className={`border-t ${fr.className}`}
                    >
                      <td className="p-2">
                        <CopyInline value={p.poNumber} />
                      </td>
                      <td className="p-2">
                        {/* ٢٤/٨ (تدقيق): اسم المورّد رابطٌ لكشف حسابه — بلا حاجةٍ لفتح ⋯. */}
                        {p.supplierName &&
                        p.supplierId &&
                        canOpenSupplierStatement ? (
                          <Link
                            href={`/suppliers-statement?id=${p.supplierId}`}
                            className="text-primary hover:underline"
                            title="فتح كشف حساب المورّد"
                          >
                            {p.supplierName}
                          </Link>
                        ) : (
                          (p.supplierName ?? "—")
                        )}
                      </td>
                      {showBranchCol && (
                        <td className="p-2">
                          {branchNames.get(p.branchId ?? -1) ?? "—"}
                        </td>
                      )}
                      <td
                        className="p-2 whitespace-nowrap tabular-nums"
                        dir="ltr"
                      >
                        {fmtDate(p.orderDate)}
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {fmt(p.total)}
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {p.agreedCurrency === "USD"
                          ? `${fmt(p.usdTotal)} $`
                          : `${fmt(p.total)} د.ع`}
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {p.agreedCurrency === "USD" ? fmt(p.agreedRate) : "—"}
                      </td>
                      {/* ٢٤/٨ (تدقيق): `title` يشرح صيغة الرقم — «المتبقّي = الإجمالي − المدفوع». */}
                      <td
                        className="p-2 text-right font-bold tabular-nums"
                        dir="ltr"
                        title="المتبقّي = الإجمالي − المدفوع"
                      >
                        {p.agreedCurrency === "USD"
                          ? `${D(p.usdTotal ?? 0)
                              .minus(D(p.paidUsd ?? 0))
                              .toFixed(2)} $`
                          : `${positiveDiff(p.total ?? 0, p.paidAmount ?? 0).toFixed(2)} د.ع`}
                      </td>
                      <td className="p-2">
                        {/* ٢٤/٨ (تدقيق): شارةُ لون بدل نصٍّ خام. */}
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${SETTLEMENT_CLASS[p.settlementType] ?? "badge-status-pending"}`}
                        >
                          {SETTLEMENT_TYPE[p.settlementType] ??
                            p.settlementType}
                        </span>
                      </td>
                      <td className="p-2">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${PO_STATUS_CLASS[p.status] ?? "badge-status-pending"}`}
                        >
                          {PO_STATUS[p.status] ?? p.status}
                        </span>
                      </td>
                      <td className="p-2">
                        <ActorCell
                          actor={{
                            userId: p.createdBy,
                            name: p.createdByName,
                            source: p.createdBy == null ? "legacy" : "user",
                          }}
                        />
                      </td>
                      <td className="p-2 text-center">
                        <RowActions
                          mode="auto"
                          contact={{
                            whatsapp: supplierContacts.get(Number(p.supplierId))
                              ?.whatsapp,
                            phone: supplierContacts.get(Number(p.supplierId))
                              ?.phone,
                            label: `واتساب ${p.supplierName ?? "المورّد"}`,
                            message: buildOperationalContactMessage({
                              entityLabel: "أمر شراء",
                              reference: p.poNumber,
                              partyName: p.supplierName,
                              title: `إجمالي الأمر: ${fmt(p.total)} د.ع`,
                              dueAt: p.orderDate,
                              status: PO_STATUS[p.status] ?? p.status,
                              nextAction:
                                p.status === "CONFIRMED"
                                  ? "يرجى تأكيد موعد تجهيز الطلب."
                                  : undefined,
                            }),
                            gate: { module: "purchases", level: "READ" },
                          }}
                          actions={[
                            {
                              key: "confirm",
                              kind: "approve",
                              label: "إرسال للاعتماد",
                              // الإرسال لا يعني الاعتماد؛ يبقى SENT حتى يحسمه مراجع مستقل.
                              hidden: !needsConfirmation,
                              disabled:
                                confirmMut.isPending ||
                                hasPendingControl ||
                                controlStateUnavailable,
                              disabledReason: controlStateUnavailable
                                ? "تعذّر التحقق من طلبات التحكم"
                                : hasPendingControl
                                  ? "يوجد طلب تحكم معلّق"
                                  : "توجد عملية إرسال قيد التنفيذ",
                              onSelect: () =>
                                void confirmOrder({
                                  id: p.id,
                                  poNumber: p.poNumber,
                                  version: Number(p.version),
                                }),
                              gate: {
                                roles: ["manager", "purchasing"],
                                module: "purchases",
                                level: "FULL",
                              },
                            },
                            {
                              key: "edit",
                              kind: "edit",
                              label: "تعديل الأمر",
                              href: `/purchases/${p.id}/edit`,
                              // الأهليّة الكاملة خادمية (لا استلام/لا دفعة)؛ هنا نُخفيه عن النهائيّ
                              // فقط — والشاشة نفسها تشرح سبب المنع لو تعذّر التعديل.
                              hidden:
                                terminal ||
                                awaitingApproval ||
                                p.status === "CONFIRMED",
                              gate: {
                                roles: ["manager", "purchasing"],
                                module: "purchases",
                                level: "FULL",
                              },
                            },
                            {
                              key: "receive",
                              kind: "view",
                              label: "عرض التفاصيل",
                              href: `/purchases/${p.id}`,
                              gate: { module: "purchases", level: "READ" },
                            },
                            {
                              key: "print",
                              kind: "print",
                              label: "طباعة أمر الشراء",
                              onSelect: () => void printOrder(p.id),
                              gate: { module: "purchases", level: "READ" },
                            },
                            {
                              key: "stmt",
                              kind: "view",
                              label: "كشف حساب المورد",
                              href: `/suppliers-statement?id=${p.supplierId}`,
                              hidden: p.supplierId == null,
                              gate: { module: "suppliers", level: "READ" },
                            },
                            {
                              key: "preturn",
                              kind: "reverse",
                              label: "مرتجع شراء",
                              href: `/purchase-returns/new?po=${encodeURIComponent(p.poNumber)}`,
                              // الإرجاع للمورد ممكن فقط بعد اعتماد الفاتورة وترحيلها.
                              hidden: p.status !== "RECEIVED",
                              gate: {
                                roles: ["manager", "purchasing"],
                                module: "purchases",
                                level: "FULL",
                              },
                            },
                            {
                              key: "cancel",
                              kind: "reverse",
                              label: "إلغاء الأمر",
                              variant: "destructive",
                              // الحارس النهائي خادمي (يرفض المستلَم جزئياً) — رسالته العربية تظهر عبر notify.err.
                              hidden:
                                p.status === "RECEIVED" ||
                                p.status === "CANCELLED",
                              disabled:
                                cancelMut.isPending ||
                                hasPendingControl ||
                                controlStateUnavailable,
                              disabledReason: controlStateUnavailable
                                ? "تعذّر التحقق من طلبات التحكم"
                                : hasPendingControl
                                  ? "يوجد طلب تحكم معلّق"
                                  : "توجد عملية إلغاء قيد التنفيذ",
                              onSelect: () =>
                                void cancelOrder({
                                  id: p.id,
                                  poNumber: p.poNumber,
                                  total: String(p.total ?? "0"),
                                  version: Number(p.version),
                                }),
                              gate: {
                                roles: ["manager", "purchasing"],
                                module: "purchases",
                                level: "FULL",
                              },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {!query.isLoading && rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={showBranchCol ? 12 : 11}
                      className="p-6 text-center text-muted-foreground"
                    >
                      لا أوامر شراء مطابقة.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
        <TablePager
          page={page}
          onPageChange={setPage}
          pageSize={PAGE_SIZE}
          rowsOnPage={rows.length}
          total={total}
          isLoading={query.isFetching}
        />
      </Card>
      {canViewIntegrity && (
        <PurchaseIntegrityPanel
          branchId={integrityBranchId}
          requiresBranchSelection={
            me.data?.role === "admin" && integrityBranchId == null
          }
        />
      )}
      <PurchaseCancellationDialog
        open={cancelTarget != null}
        reference={cancelTarget?.poNumber ?? "أمر الشراء"}
        description={
          cancelTarget
            ? `الطلب صفري الأثر: لن تتغير حالة الأمر أو قيمته (${fmt(cancelTarget.total)} د.ع) قبل اعتماد مستخدم مستقل.`
            : ""
        }
        reason={cancelReason}
        pending={cancelMut.isPending}
        onReasonChange={setCancelReason}
        onClose={() => {
          setCancelTarget(null);
          setCancelReason("");
        }}
        onSubmit={submitCancellation}
      />
    </div>
  );
}
