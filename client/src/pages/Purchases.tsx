import { balanceOptionText } from "@/components/BalanceBadge";
import { allocateLineTax } from "@/components/invoice";
import { CopyInline } from "@/components/CopyButton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { useEffect, useMemo, useState } from "react";

// نوع صفّ أمر الشراء (يوحّد فرعَي الإخراج: المُقنَّع cost=null وغير المُقنَّع).
type PurchaseRow = RouterOutputs["purchases"]["list"][number];

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** حجم صفحة القائمة — الخادم يُرقّم. */
const PAGE_SIZE = 50;

export default function Purchases() {
  const utils = trpc.useUtils();
  // فلاتر خادمية محفوظة في querystring (نمط Invoices.tsx): تعيش مع فتح التفاصيل والرجوع، وتُشارَك
  // رابطاً. لا فلترة محلية تُخفي صفحات الخادم — كل القيم نصوص تُحوَّل عند حدود الـAPI.
  const [f, setF, resetF] = useUrlFilters({
    q: "", from: "", to: "", supplierId: "", status: "", branchId: "",
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
  const statusArg = (f.status || undefined) as "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED" | undefined;

  const me = trpc.auth.me.useQuery();
  // فلتر الفرع وعموده — للمرتفعين العابرين للفروع فقط (الخادم يتجاهل branchId لغيرهم أصلاً:
  // scopedBranchId الحاكم في buildPurchasesListConds، فالإخفاء هنا عرضيّ لا أمنيّ — نمط Invoices.tsx).
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isElevated });
  const branchNames = useMemo(
    () => new Map((branches.data ?? []).map((b) => [b.id, b.name])),
    [branches.data],
  );
  const showBranchCol = isElevated && !f.branchId;

  const listInput = useMemo(
    () => ({
      from: f.from || undefined,
      to: f.to || undefined,
      supplierId: f.supplierId ? Number(f.supplierId) : undefined,
      status: statusArg,
      branchId: isElevated && f.branchId ? Number(f.branchId) : undefined,
      q: dq.trim() || undefined,
    }),
    [f.from, f.to, f.supplierId, statusArg, isElevated, f.branchId, dq],
  );

  // عدّاد الفلاتر المفعّلة (بلا حقل البحث — اتفاقية ListToolbar) لزرّ «مسح الفلاتر».
  const activeFilterCount = [f.from || f.to, f.supplierId, f.status, isElevated ? f.branchId : ""].filter(Boolean).length;

  const suppliers = trpc.suppliers.list.useQuery();
  const supplierContacts = useMemo(
    () => new Map((suppliers.data ?? []).map((s) => [Number(s.id), s])),
    [suppliers.data],
  );
  const query = trpc.purchases.list.useQuery({ ...listInput, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const rows: PurchaseRow[] = query.data ?? [];
  // الإجمالي من listCount (نفس buildPurchasesListConds ⇒ مطابق للصفوف بالبناء) — لا rows.length
  // الذي صار طول الصفحة بعد الترقيم.
  const countQ = trpc.purchases.listCount.useQuery(listInput);
  const total = countQ.data?.count;

  // أي تغيير في الفلاتر/البحث يعيدنا للصفحة الأولى.
  useEffect(() => { setPage(0); }, [listInput]);

  const cancelMut = trpc.purchases.cancel.useMutation({
    onSuccess: async () => {
      await utils.purchases.list.invalidate();
      notify.ok("أُلغي أمر الشراء");
    },
    onError: (e) => notify.err(e),
  });

  const confirmMut = trpc.purchases.confirmOrder.useMutation({
    onSuccess: async () => {
      await utils.purchases.list.invalidate();
      notify.ok("اعتُمد أمر الشراء — أصبح قابلاً للاستلام");
    },
    onError: (e) => notify.err(e),
  });

  // اعتماد مسوّدة (DRAFT ← CONFIRMED): يُتمّم دورة «حفظ مسوّدة» في شاشة الإنشاء — بعدها الأمر
  // قابل للاستلام عبر شاشة الاستلام.
  async function confirmOrder(p: { id: number; poNumber: string }) {
    const ok = await confirm({
      variant: "info",
      title: "اعتماد أمر الشراء",
      description: `سيُعتمَد الأمر ${p.poNumber} فيصبح قابلاً للاستلام. هل تتابع؟`,
      confirmText: "اعتماد",
      cancelText: "تراجع",
    });
    if (!ok) return;
    confirmMut.mutate({ purchaseOrderId: p.id });
  }

  // إلغاء أمر شراء لم يُستلم منه شيء — الحارس النهائي في الخادم (يرفض أي أمر استُلمت منه بضاعة).
  async function cancelOrder(p: { id: number; poNumber: string; total: string }) {
    const ok = await confirm({
      variant: "danger",
      title: "إلغاء أمر الشراء",
      description: `سيُعلَّم الأمر ${p.poNumber} (بإجمالي ${fmt(p.total)} د.ع) «ملغى». لا يُلغى أمرٌ استُلمت منه بضاعة — لذلك استعمل مرتجع شراء. هل تتابع؟`,
      confirmText: "إلغاء الأمر",
      cancelText: "تراجع",
    });
    if (!ok) return;
    cancelMut.mutate({ purchaseOrderId: p.id });
  }

  // طباعة أمر الشراء من القائمة: نجلب التفاصيل (purchases.get) ثم نطبع بالقالب عالي الدقّة V2
  // (gap-audit ٥/٧: printPurchaseInvoiceV2 كان مكتوباً في PR #140 بلا مستهلِك — رُبط هنا).
  async function printOrder(purchaseOrderId: number) {
    try {
      const d = await utils.purchases.get.fetch({ purchaseOrderId });
      if (!d) { notify.err("تعذّر جلب أمر الشراء"); return; }
      const remaining = positiveDiff(d.total, d.paidAmount);
      const taxShares = allocateLineTax(
        d.items.map((it) => ({ total: String(it.total ?? "0") })),
        String(d.taxAmount ?? "0"),
        round2(D(d.subtotal ?? "0")).toFixed(2),
      );
      const statusColor =
        d.status === "RECEIVED" ? "#0D6B52" : d.status === "CANCELLED" ? "#8A1F11" : "#92400E";
      // QR حقيقي ببيانات الأمر (كان القالب يطبع placeholder زخرفياً غير قابل للمسح).
      const qrSvg = await qrCodeSvg(
        [CO.sub, `أمر شراء: ${d.poNumber}`, `الإجمالي: ${fmt(d.total ?? 0)} د.ع`].join("\n"),
        { size: 88, margin: 1 },
      ).catch(() => "");
      printPurchaseInvoiceV2({
        qrSvg: qrSvg || null,
        invoiceNumber: d.poNumber,
        invoiceDate: d.orderDate as unknown as string | null,
        statusLabel: PO_STATUS[d.status] ?? d.status,
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
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المشتريات</h1>
      <p className="text-sm text-muted-foreground">أوامر الشراء وحالتها. أنشئ أمراً ثم استلمه ليُضاف للمخزون وتُسجَّل الذمم.</p>
      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={query.isLoading}
            search={{
              value: f.q,
              onChange: (v) => setF({ q: v }),
              placeholder: "بحث (رقم الأمر/المورد/ملاحظات)",
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            filters={
              <>
                {/* E (١٢/٨): FilterField يُظهر التسمية دائماً — Placeholder وحده يختفي عند الاختيار
                    فيضيع معنى الحقل. صندوق الفلاتر الموحّد (ListToolbar) يوفّر المساحة الآن. */}
                <FilterField label="من تاريخ">
                  <Input type="date" dir="ltr" className="h-8 w-36" value={f.from} onChange={(e) => setF({ from: e.target.value })} />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input type="date" dir="ltr" className="h-8 w-36" value={f.to} onChange={(e) => setF({ to: e.target.value })} />
                </FilterField>
                <FilterField label="المورد">
                  <select
                    className={selectCls}
                    value={f.supplierId}
                    onChange={(e) => setF({ supplierId: e.target.value })}
                  >
                    <option value="">— كل الموردين —</option>
                    {(suppliers.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {balanceOptionText((s as { currentBalance?: string | null }).currentBalance, "supplier")}
                      </option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="الحالة">
                  <select className={selectCls} value={f.status} onChange={(e) => setF({ status: e.target.value })}>
                    <option value="">— كل الحالات —</option>
                    {Object.entries(PO_STATUS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </FilterField>
                {isElevated && (
                  <FilterField label="الفرع">
                    <select className={selectCls} value={f.branchId} onChange={(e) => setF({ branchId: e.target.value })}>
                      <option value="">— كل الفروع —</option>
                      {(branches.data ?? []).map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
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
                { key: "orderDate", header: "التاريخ", map: (r) => fmtDate(r.orderDate) },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                { key: "usdTotal", header: "فاتورة المورد $", map: (r) => Number(r.usdTotal ?? 0) },
                { key: "agreedRate", header: "سعر التثبيت", map: (r) => Number(r.agreedRate ?? 0) },
                { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount ?? 0) },
                { key: "status", header: "الحالة", map: (r) => PO_STATUS[r.status] ?? r.status },
              ],
            }}
            add={{ href: "/purchases/new", label: "أمر شراء جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
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
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const terminal = p.status === "RECEIVED" || p.status === "CANCELLED";
                const isDraft = p.status === "DRAFT";
                const fr = rowProps(p.id);
                return (
                  <tr key={p.id} ref={fr.ref} className={`border-t ${fr.className}`}>
                    <td className="p-2"><CopyInline value={p.poNumber} /></td>
                    <td className="p-2">{p.supplierName ?? "—"}</td>
                    {showBranchCol && <td className="p-2">{branchNames.get(p.branchId ?? -1) ?? "—"}</td>}
                    <td className="p-2 whitespace-nowrap tabular-nums" dir="ltr">{fmtDate(p.orderDate)}</td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(p.total)}</td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {p.agreedCurrency === "USD" ? `${fmt(p.usdTotal)} $` : `${fmt(p.total)} د.ع`}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">{p.agreedCurrency === "USD" ? fmt(p.agreedRate) : "—"}</td>
                    <td className="p-2 text-right font-bold tabular-nums" dir="ltr">
                      {p.agreedCurrency === "USD"
                        ? `${D(p.usdTotal ?? 0).minus(D(p.paidUsd ?? 0)).toFixed(2)} $`
                        : `${positiveDiff(p.total ?? 0, p.paidAmount ?? 0).toFixed(2)} د.ع`}
                    </td>
                    <td className="p-2">{PO_STATUS[p.status] ?? p.status}</td>
                    <td className="p-2 text-center">
                      <RowActions
                        mode="auto"
                        contact={{
                          whatsapp: supplierContacts.get(Number(p.supplierId))?.whatsapp,
                          phone: supplierContacts.get(Number(p.supplierId))?.phone,
                          label: `واتساب ${p.supplierName ?? "المورّد"}`,
                          message: buildOperationalContactMessage({
                            entityLabel: "أمر شراء",
                            reference: p.poNumber,
                            partyName: p.supplierName,
                            title: `إجمالي الأمر: ${fmt(p.total)} د.ع`,
                            dueAt: p.orderDate,
                            status: PO_STATUS[p.status] ?? p.status,
                            nextAction: p.status === "CONFIRMED" ? "يرجى تأكيد موعد تجهيز الطلب." : undefined,
                          }),
                          gate: { module: "purchases", level: "READ" },
                        }}
                        actions={[
                          {
                            key: "confirm",
                            kind: "approve",
                            label: "اعتماد الأمر",
                            // اعتماد المسوّدة (DRAFT ← CONFIRMED) — بعده يصبح قابلاً للاستلام.
                            hidden: !isDraft,
                            disabled: confirmMut.isPending,
                            disabledReason: "توجد عملية اعتماد قيد التنفيذ",
                            onSelect: () => void confirmOrder({ id: p.id, poNumber: p.poNumber }),
                            gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" },
                          },
                          {
                            key: "edit",
                            kind: "edit",
                            label: "تعديل الأمر",
                            href: `/purchases/${p.id}/edit`,
                            // الأهليّة الكاملة خادمية (لا استلام/لا دفعة)؛ هنا نُخفيه عن النهائيّ
                            // فقط — والشاشة نفسها تشرح سبب المنع لو تعذّر التعديل.
                            hidden: terminal,
                            gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" },
                          },
                          {
                            key: "receive",
                            kind: terminal ? "view" : "approve",
                            label: terminal ? "عرض" : "استلام",
                            href: `/purchases/${p.id}/receive`,
                            // مسوّدة غير قابلة للاستلام قبل الاعتماد (receive يشترط status=CONFIRMED خادمياً).
                            hidden: isDraft,
                            gate: terminal
                              ? { module: "purchases", level: "READ" }
                              : { roles: ["warehouse", "manager", "purchasing"], module: "purchases", level: "FULL" },
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
                            // الإرجاع للمورد ممكن فقط بعد استلام البضاعة فعلياً.
                            hidden: p.status !== "RECEIVED" && p.status !== "CONFIRMED",
                            gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" },
                          },
                          {
                            key: "cancel",
                            kind: "reverse",
                            label: "إلغاء الأمر",
                            variant: "destructive",
                            // الحارس النهائي خادمي (يرفض المستلَم جزئياً) — رسالته العربية تظهر عبر notify.err.
                            hidden: p.status === "RECEIVED" || p.status === "CANCELLED",
                            disabled: cancelMut.isPending,
                            disabledReason: "توجد عملية إلغاء قيد التنفيذ",
                            onSelect: () => void cancelOrder({ id: p.id, poNumber: p.poNumber, total: String(p.total ?? "0") }),
                            gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!query.isLoading && rows.length === 0 && (
                <tr><td colSpan={showBranchCol ? 10 : 9} className="p-6 text-center text-muted-foreground">لا أوامر شراء مطابقة.</td></tr>
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
    </div>
  );
}
