import { AlertTriangle } from "lucide-react";
import { CopyInline } from "@/components/CopyButton";
import { ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { POS_METHODS, type PaymentMethod } from "@/lib/paymentMethod";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";

function shiftTypeLabel(t: string): string {
  return t === "RECEPTION" ? "استقبال" : t === "PRINT_SERVICES" ? "خدمات طباعة" : "تجزئة";
}

const INVOICE_STATUS: Record<string, string> = {
  PENDING: "معلّقة",
  CONFIRMED: "مؤكّدة",
  PAID: "مدفوعة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
};

/** حجم صفحة قائمة الفواتير — الترقيم خادميّ (نمط Invoices). */
const PAGE_SIZE = 50;

export default function Returns() {
  const utils = trpc.useUtils();

  const searchStr = useSearch();
  const urlInvoiceId = useMemo(() => {
    const p = new URLSearchParams(searchStr);
    const v = p.get("invoiceId");
    return v ? parseInt(v, 10) : null;
  }, [searchStr]);

  const [selectedId, setSelectedId] = useState<number | null>(urlInvoiceId);
  // الـURL مصدر الحقيقة: مزامنة الفاتورة المختارة عند الوصول بـ?invoiceId= (رابط مستقلّ من تفاصيل الفاتورة).
  useEffect(() => {
    if (urlInvoiceId != null && urlInvoiceId !== selectedId) setSelectedId(urlInvoiceId);
  }, [urlInvoiceId]); // eslint-disable-line
  const [qty, setQty] = useState<Record<number, string>>({});
  const [restock, setRestock] = useState(true);
  const [refundAmount, setRefundAmount] = useState("");
  // ش٥: TELECOM خارج طرق الاسترداد (رصيد زين لا «يُعاد شحنه» للزبون) — النوع مضيَّق على عقد الخادم.
  const [refundMethod, setRefundMethod] = useState<Exclude<PaymentMethod, "TELECOM">>("CASH");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  // #5 (تدقيق التثبيت): idempotency للمرتجع — الشاشة كانت ترسل create.mutate بلا clientRequestId
  // (بخلاف SalesReturnNew) ⇒ على شبكة جوّال متذبذبة (CGNAT): commit ينجح لكن الاستجابة تنتهي مهلتها،
  // فيضغط المستخدم مرّةً ثانية ⇒ مرتجع مكرَّر (RETURN restock مكرَّر + adjustCustomerBalance مكرَّر
  // + استرداد نقدي يخرج مرّتين). المفتاح ثابت للفاتورة المختارة، يتجدَّد عند pick()/بعد النجاح.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  // درج الاسترداد النقدي — الدرج مورد فرعٍ لا مستخدم؛ منفِّذ المرتجع هنا مديرٌ (صلاحية الشاشة) قد
  // يختلف عن الكاشير صاحب الدرج الفعليّ. راجع resolveBranchCashShiftTx على الخادم + SalesReturnNew.
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);

  // البحث والفلترة خادميان (sales.listPage): كان البحث محلياً في آخر ٥٠ فاتورة فقط ⇒ فاتورة
  // أقدم تُعطي «لا نتائج» وهي موجودة. q يشمل رقم الفاتورة واسم العميل (نفس بحث شاشة المبيعات).
  const [page, setPage] = useState(0);
  const qDebounced = useDebouncedValue(q.trim(), 300);
  // أي تغيير في البحث/الفلتر يعيد للصفحة الأولى (وإلا بقي offset قديماً على مجموعة أصغر).
  useEffect(() => { setPage(0); }, [qDebounced, statusFilter]);
  const invoicesQuery = trpc.sales.listPage.useQuery({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    q: qDebounced || undefined,
    status: (statusFilter || undefined) as
      | "PENDING" | "CONFIRMED" | "PAID" | "PARTIALLY_PAID" | "CANCELLED" | "RETURNED"
      | undefined,
  });
  const invoiceRows = invoicesQuery.data?.rows ?? [];
  // إجمالي المطابق للفلتر (نفس buildSalesListConds خادمياً) — يغذّي TablePager بعدّاد «من N»
  // كنمط شاشة المبيعات؛ عند تأخّره يعمل الترقيم بوضع hasMore (keyset) بلا انتظار.
  const summaryQ = trpc.sales.listSummary.useQuery({
    q: qDebounced || undefined,
    status: (statusFilter || undefined) as
      | "PENDING" | "CONFIRMED" | "PAID" | "PARTIALLY_PAID" | "CANCELLED" | "RETURNED"
      | undefined,
  });
  const detail = trpc.returns.getInvoice.useQuery(
    { invoiceId: selectedId ?? 0 },
    { enabled: !!selectedId },
  );

  // درج الاسترداد النقدي — نجلب ورديات الفرع المفتوحة (أيّ صاحب) فقط حين الاسترداد نقديّ فعلاً.
  const isCashRefundPending = refundMethod === "CASH" && D(refundAmount.trim() || "0").gt(0);
  const branchId = detail.data?.branchId;
  const openShiftsQ = trpc.treasury.getOpenShifts.useQuery(
    { branchId },
    { enabled: isCashRefundPending && !!branchId }
  );
  const drawerShifts = openShiftsQ.data ?? [];

  useEffect(() => {
    setRefundShiftId(null);
  }, [branchId, refundMethod]);

  // Default the actual refund to the selected return value (capped by what was paid).
  // Previously this legacy screen left it blank, so stock/ledger were reversed while no DRAWER OUT
  // was recorded; the cashier then physically refunded cash and closing showed a fictitious shortage.
  const suggestedRefund = useMemo(() => {
    const inv = detail.data;
    if (!inv) return "";
    let gross = D(0);
    for (const item of inv.items) {
      const raw = (qty[item.invoiceItemId] ?? "").trim();
      if (!/^\d+$/.test(raw)) continue;
      const amount = D(raw);
      if (!amount.gt(0) || !D(item.baseQuantity).gt(0)) continue;
      gross = gross.plus(D(item.total).times(amount.div(item.baseQuantity)));
    }
    const subtotal = D(inv.subtotal);
    const discountRatio = subtotal.gt(0) ? D(inv.discountAmount).div(subtotal) : D(0);
    const taxable = subtotal.minus(inv.discountAmount);
    const taxRate = taxable.gt(0) ? D(inv.taxAmount).div(taxable) : D(0);
    const revenue = round2(gross.times(D(1).minus(discountRatio)));
    const total = round2(revenue.plus(round2(revenue.times(taxRate))));
    const paid = D(inv.paidAmount);
    return (total.lte(paid) ? total : paid).toFixed(2);
  }, [detail.data, qty]);

  useEffect(() => {
    setRefundAmount(suggestedRefund === "0.00" ? "" : suggestedRefund);
    const originalMethod = detail.data?.paymentMethod;
    // ش٥: فاتورة دُفعت برصيد زين تُستردّ بطريقةٍ أخرى (الرصيد لا «يُعاد شحنه») ⇒ تبقى CASH.
    if (originalMethod && originalMethod !== "TELECOM" && POS_METHODS.some((m) => m.v === originalMethod)) {
      setRefundMethod(originalMethod as Exclude<PaymentMethod, "TELECOM">);
    }
  }, [suggestedRefund, detail.data?.paymentMethod]);

  function pick(id: number) {
    setSelectedId(id);
    setQty({});
    setRefundAmount("");
    setRefundMethod("CASH");
    setRestock(true);
    setRefundShiftId(null);
    setError("");
    setDone("");
    // #5: مفتاح جديد لكل فاتورة مختارة — يمنع خلط idempotency بين فواتير مختلفة.
    setClientRequestId(crypto.randomUUID());
  }

  function resetFields() {
    setQty({});
    setRefundAmount("");
    setRefundMethod("CASH");
    setRestock(true);
    setRefundShiftId(null);
  }

  const create = trpc.returns.create.useMutation({
    onSuccess: async () => {
      setDone("تمّ تسجيل المرتجع بنجاح.");
      resetFields();
      // #5: مفتاح جديد للمرتجع التالي على نفس الفاتورة (مرتجعات جزئية متكرّرة).
      setClientRequestId(crypto.randomUUID());
      await Promise.all([
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
        utils.returns.getInvoice.invalidate(),
      ]);
    },
    onError: (e) => setError(e.message),
  });

  async function submit() {
    setError("");
    setDone("");
    const data = detail.data;
    if (!data) return;
    if (data.status === "RETURNED" || data.status === "CANCELLED") {
      return setError("الفاتورة ملغاة أو مرتجعة بالكامل — لا يمكن تسجيل مرتجع جديد.");
    }

    // مصدر واحد لقراءة الكمية: نصّ ⇒ تحقّق ⇒ عدد صحيح موجب ضمن المتبقّي.
    const lines: { invoiceItemId: number; baseQuantity: number }[] = [];
    for (const it of data.items) {
      const raw = (qty[it.invoiceItemId] ?? "").trim();
      if (!raw) continue;
      if (!/^\d+$/.test(raw)) {
        return setError(`كمية إرجاع غير صحيحة للمنتج «${it.productName}» — أدخل عدداً صحيحاً موجباً.`);
      }
      const want = parseInt(raw, 10);
      if (want <= 0) continue;
      if (want > it.remaining) {
        return setError(`كمية إرجاع المنتج «${it.productName}» تتجاوز المتبقّي (${it.remaining}).`);
      }
      lines.push({ invoiceItemId: it.invoiceItemId, baseQuantity: want });
    }
    if (!lines.length) return setError("أدخل كمية إرجاع واحدة على الأقل.");

    // مبلغ الاسترداد اختياري — تحقّق من صحّته قبل D() (decimal.js يرمي على غير الرقمي).
    let refund: { amount: string; method: typeof refundMethod; shiftId?: number } | undefined;
    const refundStr = refundAmount.trim();
    if (refundStr) {
      if (!/^\d+(\.\d+)?$/.test(refundStr)) {
        return setError("مبلغ الاسترداد غير صالح — أدخل رقماً.");
      }
      // حمولة API لا عرض — أرقام صرفة بلا فواصل آلاف (zod moneyStr يرفض الفواصل).
      if (D(refundStr).gt(0)) {
        refund = { amount: round2(D(refundStr)).toFixed(2), method: refundMethod };
        if (refund.method === "CASH") {
          // الدرج مورد فرعٍ لا مستخدم — يجب تحديد أيّ درجٍ سيخرج منه النقد فعلياً قبل الحفظ
          // (مرآةً لِما يفرضه resolveBranchCashShiftTx خادمياً) كي لا يظهر عجزٌ لكاشيرٍ لم يَرَ هذا المرتجع.
          if (openShiftsQ.isLoading || openShiftsQ.isFetching) {
            return setError("جارٍ فحص الورديات المفتوحة بالفرع — أعد المحاولة بعد لحظة.");
          }
          if (drawerShifts.length === 0) {
            return setError("لا توجد وردية مفتوحة في هذا الفرع لاسترداد نقدي — افتح وردية أو غيّر طريقة الاسترداد.");
          }
          if (drawerShifts.length > 1) {
            if (refundShiftId == null) {
              return setError("أكثر من درجٍ مفتوح بالفرع — حدّد أعلاه أيّ درجٍ سيخرج منه النقد فعلياً.");
            }
            refund.shiftId = refundShiftId;
          } else {
            refund.shiftId = drawerShifts[0].shiftId;
          }
        }
      }
    }

    if (
      !(await confirm({
        variant: "danger",
        title: "تأكيد مرتجع البيع",
        description: `تسجيل مرتجع البيع للفاتورة «${data.invoiceNumber}» سينقل المخزون والذمم. متابعة؟`,
        confirmText: "تسجيل",
      }))
    )
      return;

    create.mutate({ invoiceId: data.id, lines, refund, restock, clientRequestId });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="مرتجعات البيع"
        description="اختر فاتورة، حدّد كميات الإرجاع (بالوحدة الأساس)، ثم أكّد. يُعاد للمخزون اختيارياً ويُسجَّل الاسترداد."
        actions={<Link href="/invoices" className="text-sm text-muted-foreground">← رجوع للمبيعات</Link>}
      />

      <div className="grid gap-4 lg:grid-cols-2 items-start">
      <Card>
        <CardHeader>
          <ListToolbar
            title="اختيار الفاتورة"
            // العدّاد = إجمالي المطابق خادمياً (لا صفوف الصفحة المعروضة وحدها) متى ما توفّر.
            count={summaryQ.data?.count ?? invoiceRows.length}
            loading={invoicesQuery.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث (رقم الفاتورة/اسم العميل)",
            }}
            filters={
              // قيمة «ALL» الحارسة: Radix يرفض بند القيمة الفارغة فلا يمكن الرجوع لـ«كل الحالات» بدونها.
              <AppSelect
                size="sm"
                className="w-44"
                aria-label="فلتر حالة الفاتورة"
                value={statusFilter || "ALL"}
                onValueChange={(v) => setStatusFilter(v === "ALL" ? "" : v)}
              >
                <option value="ALL">كل الحالات</option>
                {Object.entries(INVOICE_STATUS).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </AppSelect>
            }
            exportSpec={{
              filename: "فواتير-للمرتجعات",
              rows: invoiceRows,
              columns: [
                { key: "invoiceNumber", header: "رقم الفاتورة" },
                { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "عميل نقدي" },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                { key: "status", header: "الحالة", map: (r) => INVOICE_STATUS[r.status] ?? r.status },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">رقم الفاتورة</th>
                <th className="p-2 text-right">الإجمالي</th>
                <th className="p-2 text-start">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {invoiceRows.map((inv) => {
                const id = Number(inv.id);
                const isPicked = selectedId === id;
                return (
                  <tr key={inv.id} className={`border-t ${isPicked ? "bg-muted/40" : ""}`}>
                    <td className="p-2"><CopyInline value={inv.invoiceNumber} /></td>
                    <td className="p-2 text-right" dir="ltr">{fmt(inv.total)}</td>
                    <td className="p-2">{INVOICE_STATUS[inv.status] ?? inv.status}</td>
                    <td className="p-2 text-center">
                      <RowActions
                        mode="inline"
                        actions={[
                          {
                            key: "pick",
                            kind: "reverse",
                            label: isPicked ? "محدّدة" : "اختيار",
                            disabled: isPicked, // منع مسح الكميات المُدخَلة بنقرة سهو
                            disabledReason: "الفاتورة محددة بالفعل",
                            onSelect: () => pick(id),
                            gate: { roles: ["manager"], module: "sales", level: "FULL" },
                          },
                          {
                            key: "view",
                            kind: "view",
                            label: "عرض الفاتورة",
                            href: `/invoices/${id}`,
                            gate: { module: "sales", level: "READ" },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!invoicesQuery.isLoading && invoiceRows.length === 0 && (
                <TableEmptyRow
                  colSpan={4}
                  // صفر نتائج بلا أي بحث/فلتر وعلى الصفحة الأولى = لا فواتير في النظام أصلاً؛
                  // غير ذلك فالمجموعة مفلترة خادمياً والرسالة تُوجّه لتغيير الفلتر.
                  message={!qDebounced && !statusFilter && page === 0 ? "لا فواتير بعد." : "لا فواتير مطابقة. غيّر البحث أو الفلتر."}
                />
              )}
              {invoicesQuery.isLoading && (
                <tr><td colSpan={4} className="p-0"><LoadingState /></td></tr>
              )}
            </tbody>
          </table>
          </ScrollTableShell>
          <TablePager
            page={page}
            onPageChange={setPage}
            pageSize={PAGE_SIZE}
            rowsOnPage={invoiceRows.length}
            total={summaryQ.data?.count}
            hasMore={invoicesQuery.data?.hasMore}
            isLoading={invoicesQuery.isLoading || invoicesQuery.isFetching}
          />
        </CardContent>
      </Card>

      <div className="space-y-4">
      {!selectedId && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          اختر فاتورة من القائمة لعرض بنودها وتسجيل المرتجع.
        </div>
      )}
      {selectedId && detail.isLoading && (
        <LoadingState message="جارٍ تحميل بنود الفاتورة…" />
      )}
      {selectedId && !detail.isLoading && !detail.data && (
        <div className="p-6 text-center text-muted-foreground">الفاتورة غير موجودة.</div>
      )}

      {detail.data && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">بيانات الفاتورة</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 text-sm">
              <div><div className="text-muted-foreground text-xs">رقم الفاتورة</div><div className="font-mono" dir="ltr">{detail.data.invoiceNumber}</div></div>
              <div><div className="text-muted-foreground text-xs">العميل</div><div>{detail.data.customerName ?? "عميل نقدي"}</div></div>
              <div><div className="text-muted-foreground text-xs">الحالة</div><div>{INVOICE_STATUS[detail.data.status] ?? detail.data.status}</div></div>
              <div><div className="text-muted-foreground text-xs">الإجمالي</div><div dir="ltr">{fmt(detail.data.total)}</div></div>
              <div><div className="text-muted-foreground text-xs">المدفوع</div><div dir="ltr">{fmt(detail.data.paidAmount)}</div></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">البنود</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">المنتج</th>
                    <th className="p-2 text-start">الوحدة</th>
                    <th className="p-2 text-center">المُباع (أساس)</th>
                    <th className="p-2 text-center">المُرتجع</th>
                    <th className="p-2 text-center">المتبقّي</th>
                    <th className="p-2 text-right">السعر</th>
                    <th className="p-2 w-32 text-start">إرجاع الآن (أساس)</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.items.map((it) => (
                    <tr key={it.invoiceItemId} className="border-t">
                      <td className="p-2">{it.productName}{it.variantLabel ? ` — ${it.variantLabel}` : ""}</td>
                      <td className="p-2 text-muted-foreground">{it.unitName}</td>
                      <td className="p-2 text-center">{it.baseQuantity}</td>
                      <td className="p-2 text-center">{it.returnedBaseQuantity}</td>
                      <td className="p-2 text-center">{it.remaining}</td>
                      <td className="p-2 text-right" dir="ltr">{fmt(it.unitPrice)}</td>
                      <td className="p-2">
                        <Input
                          dir="ltr"
                          className="h-8 text-center"
                          value={qty[it.invoiceItemId] ?? ""}
                          placeholder="0"
                          disabled={it.remaining <= 0}
                          onChange={(e) => setQty((prev) => ({ ...prev, [it.invoiceItemId]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">خيارات المرتجع</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div className="space-y-1">
                <Label>إعادة للمخزون</Label>
                <label className="flex items-center gap-2 h-9 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={restock}
                    onChange={(e) => setRestock(e.target.checked)}
                  />
                  <span className="text-muted-foreground">{restock ? "نعم، تُضاف للمخزون" : "لا تُضاف"}</span>
                </label>
              </div>
              <div className="space-y-1">
                <Label>مبلغ الاسترداد (اختياري)</Label>
                <MoneyInput value={refundAmount} onChange={setRefundAmount} ariaLabel="مبلغ الاسترداد" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ret-refund-method">طريقة الاسترداد</Label>
                <AppSelect
                  id="ret-refund-method"
                  value={refundMethod}
                  onValueChange={(v) => setRefundMethod(v as Exclude<PaymentMethod, "TELECOM">)}
                >
                  {POS_METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </AppSelect>
              </div>

              {/* مصدر النقد المسترَد — الدرج مورد فرعٍ لا مستخدم؛ راجع resolveBranchCashShiftTx (الخادم). */}
              {isCashRefundPending && (
                <div className="space-y-1 md:col-span-3 rounded-lg border bg-muted/30 p-3 text-xs">
                  <div className="mb-1.5 font-bold text-foreground">مصدر النقد المسترَد</div>
                  {openShiftsQ.isFetching ? (
                    <div className="text-muted-foreground">جارٍ فحص الورديات المفتوحة بالفرع…</div>
                  ) : drawerShifts.length === 0 ? (
                    <div className="badge-stock-low flex items-start gap-2 rounded-md border px-2.5 py-2">
                      <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                      <span>لا توجد وردية مفتوحة في هذا الفرع — لا يمكن استرداد نقدٍ حتى تُفتح وردية، أو غيّر طريقة الاسترداد.</span>
                    </div>
                  ) : drawerShifts.length === 1 ? (
                    <div className="text-muted-foreground">
                      سيُخصَم هذا المبلغ من درج: <span className="font-semibold text-foreground">{drawerShifts[0].userName}</span>
                      {" — "}{shiftTypeLabel(drawerShifts[0].shiftType)} (وردية #{drawerShifts[0].shiftId})
                    </div>
                  ) : (
                    <>
                      <div className="mb-1.5 text-muted-foreground">
                        أكثر من درجٍ مفتوح بالفرع — حدّد أيّ درجٍ سيخرج منه النقد فعلياً:
                      </div>
                      <AppSelect
                        size="sm"
                        className="text-xs"
                        value={refundShiftId != null ? String(refundShiftId) : ""}
                        onValueChange={(v) => setRefundShiftId(v ? Number(v) : null)}
                        placeholder="اختر الدرج…"
                      >
                        {drawerShifts.map((s) => (
                          <option key={s.shiftId} value={String(s.shiftId)}>
                            {s.userName} — {shiftTypeLabel(s.shiftType)} (وردية #{s.shiftId})
                          </option>
                        ))}
                      </AppSelect>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {(detail.data.status === "RETURNED" || detail.data.status === "CANCELLED") && (
            <p className="text-sm text-[var(--stock-low)]">هذه الفاتورة {INVOICE_STATUS[detail.data.status]} — لا يمكن تسجيل مرتجع جديد.</p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && <p className="text-sm text-money-positive">{done}</p>}

          <div className="flex gap-2">
            <Button
              onClick={submit}
              disabled={create.isPending || detail.data.status === "RETURNED" || detail.data.status === "CANCELLED"}
            >
              {create.isPending ? "جارٍ التسجيل…" : "تأكيد المرتجع"}
            </Button>
            <Button variant="outline" onClick={() => { resetFields(); setError(""); setDone(""); }}>إعادة ضبط</Button>
          </div>
        </>
      )}
      </div>
      </div>
    </div>
  );
}
