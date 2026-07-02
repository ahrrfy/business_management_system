import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { StatementReconcile } from "@/components/StatementReconcile";
import { buildStatementMessage } from "@/lib/whatsapp";
import { printSupplierStmt } from "@/lib/printing/printTemplates";
import { exportRows } from "@/lib/export";
import { fmtDate } from "@/lib/date";
import { D, fmt, positiveDiff } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatStatementAsWhatsApp, formatTableAsTSV } from "@/lib/copy/formatters";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** تاريخ محلي YYYY-MM-DD — لا toISOString: بغداد UTC+3 فينزاح اليوم قرب منتصف الليل. */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** اختصارات الفترة: اليوم / هذا الشهر / الشهر الماضي / الكل (فارغة). */
const PERIOD_PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: "اليوم", range: () => ({ from: ymd(new Date()), to: ymd(new Date()) }) },
  {
    label: "هذا الشهر",
    range: () => {
      const n = new Date();
      return { from: ymd(new Date(n.getFullYear(), n.getMonth(), 1)), to: ymd(n) };
    },
  },
  {
    label: "الشهر الماضي",
    range: () => {
      const n = new Date();
      return {
        from: ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)),
        to: ymd(new Date(n.getFullYear(), n.getMonth(), 0)),
      };
    },
  },
  { label: "الكل", range: () => ({ from: "", to: "" }) },
];

const PO_STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};
const PO_STATUS_CLS: Record<string, string> = {
  DRAFT: "badge-status-cancelled",
  SENT: "badge-status-pending",
  CONFIRMED: "badge-stock-low",
  RECEIVED: "badge-status-active",
  CANCELLED: "badge-stock-out",
};

export default function SupplierStatement() {
  // الـURL مصدر الحقيقة لهوية المورد ⇒ رابط مستقلّ قابل للمشاركة + يتحدّث فوراً عند تغيّر ?id=
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const supplierId = useMemo(() => Number(new URLSearchParams(search).get("id")) || 0, [search]);
  // اختيار المورد يكتب المعرّف في الـURL (مع حفظ بقية المعاملات مثل tab) فيبقى الكشف مشاركاً ومستقلاً.
  const selectSupplier = (id: number) => {
    const p = new URLSearchParams(search);
    if (id) p.set("id", String(id)); else p.delete("id");
    const qs = p.toString();
    navigate(qs ? `${loc}?${qs}` : loc, { replace: true });
  };
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const index = trpc.reports.suppliersIndex.useQuery();
  const stmt = trpc.reports.supplierStatement.useQuery(
    { supplierId: supplierId || 0, from: from || undefined, to: to || undefined },
    { enabled: !!supplierId }
  );

  // يبني دفتر الحركات (مدين/دائن/رصيد جارٍ) — يُشارَك بين الطباعة وتصدير Excel.
  const ledger = useMemo(() => {
    if (!stmt.data) return null;
    const d = stmt.data;
    const poTxs = d.purchaseOrders.map((p) => ({
      t: new Date(p.orderDate).getTime(),
      date: fmtDate(p.orderDate),
      ref: p.poNumber, description: "أمر شراء",
      debit: null as string | null, credit: p.total as string | null,
    }));
    // F7 (تدقيق ٢/٧): إشارة الأثر على AP لكل نوع قيد (مطابقة reconcileSupplierBalances):
    //  PAYMENT_OUT/EXCHANGE_SETTLE ⇒ يخفض AP (−amount) = مدين؛ PAYMENT_IN/PURCHASE (يتيم) ⇒ يزيد (+amount) = دائن؛
    //  RETURN ⇒ amount مخزَّن سالباً فأثره يخفض AP = مدين. كان الكود السابق يضع كل الدفعات مديناً بلا نظر للنوع
    //  ⇒ مرتجع الشراء/الاسترداد/الشراء اليتيم بإشارة معكوسة والرصيد الجاري لا يتّزن مع currentBalance.
    const payTxs = d.payments.map((p) => {
      const amt = D(p.amount);
      const reducesAP = p.entryType === "PAYMENT_OUT" || p.entryType === "EXCHANGE_SETTLE";
      // signed = أثر AP الموقَّع (موجب=يزيد، سالب=يخفض). RETURN وحده amount سالب أصلاً ⇒ نستعمله كما هو.
      const signed = p.entryType === "RETURN" ? amt : (reducesAP ? amt.neg() : amt);
      const description =
        p.entryType === "RETURN" ? "مرتجع شراء"
        : p.entryType === "PAYMENT_IN" ? "استرداد من المورد"
        : p.entryType === "EXCHANGE_SETTLE" ? "تسوية عبر صيرفة"
        : p.entryType === "PURCHASE" ? "شراء (بلا أمر)"
        : (p.purchaseOrderId ? "دفعة للمورد" : "دفعة مستقلة للمورد");
      return {
        t: new Date(p.entryDate).getTime(),
        date: fmtDate(p.entryDate),
        ref: "دفعة",
        description,
        debit: signed.isNegative() ? signed.neg().toFixed(2) : (null as string | null),
        credit: signed.isPositive() ? signed.toFixed(2) : (null as string | null),
      };
    });
    // الفرز على طابع زمني خام — فرز نصّي على dd/mm/yyyy يخلط الشهور.
    const merged = [...poTxs, ...payTxs].sort((a, b) => a.t - b.t);
    // §٥: AP بـDecimal (دائن − مدين)، يبدأ من الرصيد المُرحَّل عند تقييد الفترة.
    let bal = from ? D(d.summary.openingBalance) : D(0);
    let totDebit = D(0), totCredit = D(0);
    const rows = merged.map(({ t: _t, ...x }) => {
      bal = bal.plus(D(x.credit)).minus(D(x.debit));
      totDebit = totDebit.plus(D(x.debit));
      totCredit = totCredit.plus(D(x.credit));
      return { ...x, balance: bal.toFixed(2) };
    });
    return {
      rows,
      totalDebit: totDebit.toFixed(2),
      totalCredit: totCredit.toFixed(2),
      // مع فترة: الختامي = المُرحَّل + حركة الفترة؛ بلا فترة: الرصيد الجاري (السلوك القديم).
      closingBalance: from ? bal.toFixed(2) : d.summary.currentBalance,
    };
  }, [stmt.data, from]);

  // حُمولة نَسخ الكَشف بِثَلاث صِيَغ (نَصّ مُلَخَّص / واتساب مُفَصَّل / TSV لِلَصق في Excel).
  // تُبنى مَرّة واحِدة على دَفتَر الحَرَكات المُجمَّع لِضَمان اتِّساق المَجاميع مَع الطِباعة والتَصدير.
  const copyPayload = useMemo(() => {
    if (!stmt.data || !ledger) return { plain: "", whatsapp: "", tsv: "" };
    const d = stmt.data;
    const plain = buildStatementMessage({
      entityName: d.supplier.name,
      entityType: "supplier",
      currentBalance: d.summary.currentBalance,
      totalSales: d.summary.totalPurchases,
      totalPaid: d.summary.totalPaid,
      unpaid: d.summary.unpaid,
    });
    const whatsapp = formatStatementAsWhatsApp({
      entityName: d.supplier.name,
      entityType: "supplier",
      lines: ledger.rows.map((r) => ({
        date: r.date,
        doc: `${r.ref} — ${r.description}`,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
      })),
      closingBalance: ledger.closingBalance,
      asOfDate: to || undefined,
    });
    const tsv = formatTableAsTSV(
      ["التاريخ", "المرجع", "البيان", "مدين", "دائن", "الرصيد"],
      ledger.rows.map((r) => ({
        "التاريخ": r.date,
        "المرجع": r.ref,
        "البيان": r.description,
        "مدين": r.debit == null ? "" : r.debit,
        "دائن": r.credit == null ? "" : r.credit,
        "الرصيد": r.balance,
      })),
    );
    return { plain, whatsapp, tsv };
  }, [stmt.data, ledger, to]);

  // يفتح نافذة الطباعة (المتصفّح: «حفظ كـ PDF»).
  const printStatement = () => {
    if (!stmt.data || !ledger) return;
    const d = stmt.data;
    printSupplierStmt({
      supplierName: d.supplier.name, supplierPhone: d.supplier.phone ?? undefined,
      fromDate: from ? new Date(`${from}T00:00:00`).toLocaleDateString("en-GB") : undefined,
      toDate: (to ? new Date(`${to}T00:00:00`) : new Date()).toLocaleDateString("en-GB"),
      transactions: ledger.rows,
      // مجاميع المدين/الدائن = جمع عمودي الجدول المطبوع نفسه (اتساق بصري ومحاسبي).
      totalDebit: ledger.totalDebit, totalCredit: ledger.totalCredit,
      openingBalance: from ? d.summary.openingBalance : undefined,
      closingBalance: ledger.closingBalance,
    });
  };

  // يصدّر دفتر الحركات نفسه (تاريخ/مرجع/بيان/مدين/دائن/رصيد) إلى Excel.
  const exportStatement = () => {
    if (!stmt.data || !ledger) return;
    exportRows(ledger.rows, {
      filename: `كشف-حساب-مورد-${stmt.data.supplier.name}`,
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "ref", header: "المرجع" },
        { key: "description", header: "البيان" },
        { key: "debit", header: "مدين", map: (r) => (r.debit == null ? null : Number(r.debit)) },
        { key: "credit", header: "دائن", map: (r) => (r.credit == null ? null : Number(r.credit)) },
        { key: "balance", header: "الرصيد", map: (r) => Number(r.balance) },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "الموردون", href: "/suppliers" }, { label: "كشف حساب" }]}
        title="كشف حساب مورد"
        description="كل أوامر الشراء والدفعات لمورد واحد، مع ملخّص الرصيد الحالي."
        actions={
          <>
            {stmt.data && (
              <Button variant="outline" size="sm" onClick={printStatement}>طباعة / PDF الكشف</Button>
            )}
            {stmt.data && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ledger?.rows.length}
                onClick={exportStatement}
              >
                تصدير Excel
              </Button>
            )}
            {stmt.data && (
              <CopyAsMenu
                plain={copyPayload.plain}
                whatsapp={copyPayload.whatsapp}
                tsv={copyPayload.tsv}
                label="نسخ الكشف"
              />
            )}
            {stmt.data && (
              <WhatsAppShare
                phone={stmt.data.supplier.phone}
                message={buildStatementMessage({
                  entityName: stmt.data.supplier.name,
                  entityType: "supplier",
                  currentBalance: stmt.data.summary.currentBalance,
                  totalSales: stmt.data.summary.totalPurchases,
                  totalPaid: stmt.data.summary.totalPaid,
                  unpaid: stmt.data.summary.unpaid,
                })}
                label="إرسال كشف الحساب"
              />
            )}
            <Link href="/ap-aging"><Button variant="outline">أعمار الذمم الدائنة</Button></Link>
          </>
        }
      />

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">المورد</Label>
            <select className={selectCls} value={supplierId} onChange={(e) => selectSupplier(Number(e.target.value))}>
              <option value={0}>— اختر مورداً —</option>
              {(index.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.phone ? `· ${s.phone}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="md:col-span-4 flex flex-wrap gap-2">
            {PERIOD_PRESETS.map((p) => (
              <Button key={p.label} variant="secondary" size="sm" onClick={() => { const r = p.range(); setFrom(r.from); setTo(r.to); }}>
                {p.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {!supplierId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر مورداً لعرض كشف الحساب.</p>
      )}

      {supplierId > 0 && stmt.isLoading && <LoadingState />}

      {supplierId > 0 && stmt.isError && (
        <ErrorState message={stmt.error.message} onRetry={() => stmt.refetch()} />
      )}

      {stmt.data && (
        <>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-semibold">{stmt.data.supplier.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.supplier.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.supplier.city ?? "—"}
                    {stmt.data.supplier.paymentTerms ? ` · شروط الدفع: ${stmt.data.supplier.paymentTerms}` : ""}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                  <Stat label="إجمالي المشتريات" value={stmt.data.summary.totalPurchases} />
                  <Stat label="إجمالي المدفوع" value={stmt.data.summary.totalPaid} />
                  <Stat label="غير مدفوع" value={stmt.data.summary.unpaid} emphasis />
                  {/* عقد import-integration §٦: رصيد غير مفوتر = الرصيد الجاري − غير المدفوع (Decimal لا parseFloat) — يشمل الافتتاحي المستورد. */}
                  <Stat
                    label="رصيد غير مفوتر — يشمل الافتتاحي المستورد"
                    value={D(stmt.data.summary.currentBalance).minus(D(stmt.data.summary.unpaid)).toFixed(2)}
                  />
                  <StatBalance label="الرصيد الحالي" value={stmt.data.summary.currentBalance} entityType="supplier" />
                </div>
              </div>
            </CardContent>
          </Card>

          <StatementReconcile
            entityName={stmt.data.supplier.name}
            entityType="supplier"
            phone={stmt.data.supplier.phone}
            currentBalance={stmt.data.summary.currentBalance}
            onPdf={printStatement}
          />

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">أوامر الشراء</div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">أمر الشراء</th>
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">الاستحقاق</th>
                    <th className="p-2 text-right">الإجمالي</th>
                    <th className="p-2 text-right">المدفوع</th>
                    <th className="p-2 text-right">المتبقّي</th>
                    <th className="p-2">الحالة</th>
                    <th className="p-2 text-center">فتح</th>
                  </tr>
                </thead>
                <tbody>
                  {/* الرصيد المُرحَّل = افتتاحي مستورد + مشتريات ملتزمة − دفعات قبل from — صف أول يجعل رصيد الفترة قابلاً للتتبّع. */}
                  {from && (
                    <tr className="border-t bg-amber-50/60 font-medium">
                      <td className="p-2 text-xs">رصيد مُرحَّل</td>
                      <td className="p-2 text-xs" dir="ltr">{fmtDate(from)}</td>
                      <td className="p-2 text-xs text-muted-foreground" colSpan={3}>ما قبل الفترة (افتتاحي + نشاط سابق)</td>
                      <td className="p-2 text-right tabular-nums font-semibold" dir="ltr">{fmt(stmt.data.summary.openingBalance)}</td>
                      <td className="p-2" colSpan={2} />
                    </tr>
                  )}
                  {stmt.data.purchaseOrders.map((p) => {
                    // §٥: نستعمل Decimal للطرح (positiveDiff) لا Number() float.
                    const remaining = positiveDiff(p.total, p.paidAmount).toFixed(2);
                    return (
                      <tr key={p.id} className="border-t">
                        <td className="p-2"><CopyInline value={p.poNumber} /></td>
                        <td className="p-2 text-xs" dir="ltr">{new Date(p.orderDate).toLocaleDateString("ar-IQ-u-nu-latn")}</td>
                        <td className="p-2 text-xs" dir="ltr">{p.expectedDeliveryDate ? String(p.expectedDeliveryDate).slice(0, 10) : "—"}</td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(p.total)}</td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(p.paidAmount)}</td>
                        <td className="p-2 text-right tabular-nums font-semibold" dir="ltr">{fmt(remaining)}</td>
                        <td className="p-2">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${PO_STATUS_CLS[p.status] ?? "bg-muted"}`}>
                            {PO_STATUS_LABEL[p.status] ?? p.status}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <Link href={`/purchases/${p.id}/receive`}>
                            <Button variant="outline" size="sm">فتح</Button>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                  {stmt.data.purchaseOrders.length === 0 && (
                    <TableEmptyRow colSpan={8} message="لا أوامر شراء لهذا المورد." />
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الدفعات المسجّلة</div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">أمر الشراء</th>
                    <th className="p-2 text-right">المبلغ</th>
                    <th className="p-2">ملاحظات</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.data.payments.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 text-xs" dir="ltr">{new Date(p.entryDate).toLocaleDateString("ar-IQ-u-nu-latn")}</td>
                      <td className="p-2">
                        {p.purchaseOrderId ? (
                          <CopyInline value={p.purchaseOrderId} />
                        ) : (
                          // دفعة بلا أمر شراء (سند صرف مستقل للمورد) — وسمها يمنع الالتباس.
                          <span className="inline-block rounded badge-status-done px-2 py-0.5 text-xs">دفعة مستقلة</span>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(p.amount)}</td>
                      <td className="p-2 text-xs">{p.notes ?? "—"}</td>
                    </tr>
                  ))}
                  {stmt.data.payments.length === 0 && (
                    <TableEmptyRow colSpan={4} message="لا دفعات مسجّلة لهذا المورد." />
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string | number; emphasis?: boolean }) {
  return (
    <div className={`rounded-md p-2 ${emphasis ? "bg-primary/5" : "bg-muted/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-xl font-bold" : "text-base font-semibold"}`} dir="ltr">{fmt(value)}</div>
    </div>
  );
}

function StatBalance({ label, value, entityType }: { label: string; value: string | number; entityType: "customer" | "supplier" }) {
  const num = Number(value);
  // للمورد: الموجب = "له علينا" (أحمر)؛ للعميل: الموجب = "لنا عليه" (أخضر)
  const weHaveClaim = entityType === "customer" ? num > 0 : num < 0;
  const hasBalance = num !== 0;
  return (
    <div className={`rounded-md p-2 ${hasBalance ? (weHaveClaim ? "badge-status-active" : "badge-stock-out") : "bg-muted/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums text-xl font-bold ${hasBalance ? (weHaveClaim ? "text-money-positive" : "text-money-negative") : ""}`} dir="ltr">
        {fmt(Math.abs(num))}
      </div>
      <div className={`text-xs font-semibold mt-0.5 ${hasBalance ? (weHaveClaim ? "text-money-positive" : "text-money-negative") : "text-muted-foreground"}`}>
        {!hasBalance ? "لا ذمم" : weHaveClaim ? "لنا عليه" : "له علينا"}
      </div>
    </div>
  );
}
