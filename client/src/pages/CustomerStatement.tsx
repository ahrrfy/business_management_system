import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { StatementReconcile } from "@/components/StatementReconcile";
import { buildStatementMessage } from "@/lib/whatsapp";
import { exportRows } from "@/lib/export";
import { printCustomerStmt } from "@/lib/printing/printTemplates";
import { D, fmt, positiveDiff } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Search, X as XIcon } from "lucide-react";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatStatementAsWhatsApp, formatTableAsTSV } from "@/lib/copy/formatters";

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

const STATUS_LABEL: Record<string, string> = {
  PENDING: "معلّقة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  PAID: "مدفوعة",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
  CONFIRMED: "مؤكّدة",
};
const STATUS_CLS: Record<string, string> = {
  PENDING: "badge-status-pending",
  PARTIALLY_PAID: "badge-status-pending",
  PAID: "badge-status-active",
  CANCELLED: "badge-stock-out",
  RETURNED: "badge-stock-out",
  CONFIRMED: "bg-muted text-muted-foreground",
};
const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة",
};

export default function CustomerStatement() {
  // الـURL مصدر الحقيقة لهوية العميل ⇒ رابط مستقلّ قابل للمشاركة + يتحدّث فوراً عند تغيّر ?id=
  // (يُصلح فقدان الاستقلالية: كان يُقرأ مرّة واحدة عند التركيب فلا يتبع تغيّر الرابط داخل الـhub).
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const customerId = useMemo(() => Number(new URLSearchParams(search).get("id")) || 0, [search]);
  // اختيار العميل يكتب المعرّف في الـURL (مع حفظ بقية المعاملات مثل tab) فيبقى الكشف مشاركاً ومستقلاً.
  const selectCustomer = (id: number) => {
    const p = new URLSearchParams(search);
    if (id) p.set("id", String(id)); else p.delete("id");
    const qs = p.toString();
    navigate(qs ? `${loc}?${qs}` : loc, { replace: true });
  };
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const index = trpc.reports.customersIndex.useQuery();
  const stmt = trpc.reports.customerStatement.useQuery(
    { customerId: customerId || 0, from: from || undefined, to: to || undefined },
    { enabled: !!customerId }
  );

  // دفتر الحركات (مدين/دائن/رصيد جارٍ) — يُبنى مرّة ويُشارَك بين الطباعة وتصدير Excel.
  const ledger = useMemo(() => {
    if (!stmt.data) return null;
    const d = stmt.data;
    const invTxs = d.invoices.map((i) => ({
      t: new Date(i.invoiceDate).getTime(),
      date: new Date(i.invoiceDate).toLocaleDateString("en-GB"),
      ref: i.invoiceNumber, description: "فاتورة مبيعات",
      debit: i.total as string | null, credit: null as string | null,
    }));
    const payTxs = d.payments.map((p) => ({
      t: new Date(p.createdAt).getTime(),
      date: new Date(p.createdAt).toLocaleDateString("en-GB"),
      ref: p.voucherNumber ?? "دفعة",
      description: p.isStandalone
        ? (p.direction === "IN" ? "سند قبض مستقل" : "سند صرف مستقل")
        : (p.direction === "IN" ? "دفعة وارد" : "استرداد"),
      // الاتجاه المحاسبي: IN ينقص ذمة العميل (دائن)، OUT (استرداد/صرف له) يزيدها (مدين).
      debit: p.direction === "OUT" ? (p.amount as string | null) : null,
      credit: p.direction === "IN" ? (p.amount as string | null) : null,
    }));
    // الفرز على طابع زمني خام — فرز نصّي على dd/mm/yyyy يخلط الشهور.
    const merged = [...invTxs, ...payTxs].sort((a, b) => a.t - b.t);
    // §٥: الرصيد الجاري بـDecimal، يبدأ من الرصيد المُرحَّل عند تقييد الفترة.
    let bal = from ? D(d.summary.openingBalance) : D(0);
    let totDebit = D(0), totCredit = D(0);
    const txs = merged.map(({ t: _t, ...x }) => {
      bal = bal.plus(D(x.debit)).minus(D(x.credit));
      totDebit = totDebit.plus(D(x.debit));
      totCredit = totCredit.plus(D(x.credit));
      return { ...x, balance: bal.toFixed(2) };
    });
    return { txs, totDebit: totDebit.toFixed(2), totCredit: totCredit.toFixed(2), closingBalance: bal.toFixed(2) };
  }, [stmt.data, from]);

  // حُمولة نَسخ الكَشف بِثَلاث صِيَغ (نَصّ مُلَخَّص / واتساب مُفَصَّل / TSV لِلَصق في Excel).
  // تُبنى مَرّة واحِدة على دَفتَر الحَرَكات المُجمَّع لِضَمان اتِّساق المَجاميع مَع الطِباعة والتَصدير.
  const copyPayload = useMemo(() => {
    if (!stmt.data || !ledger) return { plain: "", whatsapp: "", tsv: "" };
    const d = stmt.data;
    const plain = buildStatementMessage({
      entityName: d.customer.name,
      entityType: "customer",
      currentBalance: d.summary.currentBalance,
      totalSales: d.summary.totalSales,
      totalPaid: d.summary.totalPaid,
      unpaid: d.summary.unpaid,
    });
    const whatsapp = formatStatementAsWhatsApp({
      entityName: d.customer.name,
      entityType: "customer",
      lines: ledger.txs.map((r) => ({
        date: r.date,
        doc: `${r.ref} — ${r.description}`,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
      })),
      closingBalance: from ? ledger.closingBalance : d.summary.currentBalance,
      asOfDate: to || undefined,
    });
    const tsv = formatTableAsTSV(
      ["التاريخ", "المرجع", "البيان", "مدين", "دائن", "الرصيد"],
      ledger.txs.map((r) => ({
        "التاريخ": r.date,
        "المرجع": r.ref,
        "البيان": r.description,
        "مدين": r.debit == null ? "" : r.debit,
        "دائن": r.credit == null ? "" : r.credit,
        "الرصيد": r.balance,
      })),
    );
    return { plain, whatsapp, tsv };
  }, [stmt.data, ledger, from, to]);

  // يفتح نافذة الطباعة (المتصفّح: «حفظ كـ PDF») اعتماداً على دفتر الحركات المُجمَّع.
  const printStatement = () => {
    if (!stmt.data || !ledger) return;
    const d = stmt.data;
    const { txs, totDebit, totCredit, closingBalance } = ledger;
    printCustomerStmt({
      customerName: d.customer.name, customerPhone: d.customer.phone ?? undefined,
      fromDate: from ? new Date(`${from}T00:00:00`).toLocaleDateString("en-GB") : undefined,
      toDate: (to ? new Date(`${to}T00:00:00`) : new Date()).toLocaleDateString("en-GB"),
      transactions: txs,
      // مجاميع المدين/الدائن = جمع عمودي الجدول المطبوع نفسه (اتساق بصري ومحاسبي).
      totalDebit: totDebit, totalCredit: totCredit,
      openingBalance: from ? d.summary.openingBalance : undefined,
      // مع فترة: الختامي = المُرحَّل + حركة الفترة؛ بلا فترة: الرصيد الجاري (السلوك القديم).
      closingBalance: from ? closingBalance : d.summary.currentBalance,
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "العملاء", href: "/customers" }, { label: "كشف حساب" }]}
        title="كشف حساب عميل"
        description="كل الفواتير والدفعات لعميل واحد، مع ملخّص الرصيد الحالي."
        actions={
          <>
            {stmt.data && (
              <Button variant="outline" size="sm" onClick={printStatement}>طباعة / PDF الكشف</Button>
            )}
            {stmt.data && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ledger?.txs.length}
                onClick={() =>
                  exportRows(ledger?.txs ?? [], {
                    filename: `كشف-حساب-${stmt.data!.customer.name}`,
                    columns: [
                      { key: "date", header: "التاريخ" },
                      { key: "ref", header: "المرجع" },
                      { key: "description", header: "البيان" },
                      { key: "debit", header: "مدين", map: (r) => (r.debit == null ? 0 : Number(r.debit)) },
                      { key: "credit", header: "دائن", map: (r) => (r.credit == null ? 0 : Number(r.credit)) },
                      { key: "balance", header: "الرصيد", map: (r) => Number(r.balance) },
                    ],
                  })
                }
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
                phone={stmt.data.customer.phone}
                message={buildStatementMessage({
                  entityName: stmt.data.customer.name,
                  entityType: "customer",
                  currentBalance: stmt.data.summary.currentBalance,
                  totalSales: stmt.data.summary.totalSales,
                  totalPaid: stmt.data.summary.totalPaid,
                  unpaid: stmt.data.summary.unpaid,
                })}
                label="إرسال كشف الحساب"
              />
            )}
            <Link href="/ar-aging"><Button variant="outline">أعمار الذمم</Button></Link>
          </>
        }
      />

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">العميل</Label>
            <CustomerSearchPicker
              customers={index.data ?? []}
              value={customerId}
              onChange={selectCustomer}
            />
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

      {!customerId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر عميلاً لعرض كشف الحساب.</p>
      )}

      {customerId > 0 && stmt.isLoading && <LoadingState />}

      {customerId > 0 && stmt.isError && (
        <ErrorState message={stmt.error?.message} onRetry={() => stmt.refetch()} />
      )}

      {stmt.data && (
        <>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-semibold">{stmt.data.customer.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.customer.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.customer.customerType} · فئة سعرية {stmt.data.customer.defaultPriceTier}
                    {stmt.data.customer.creditLimit && Number(stmt.data.customer.creditLimit) > 0
                      ? ` · سقف ائتمان ${fmt(stmt.data.customer.creditLimit)}`
                      : ""}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                  <Stat label="إجمالي المبيعات" value={stmt.data.summary.totalSales} />
                  <Stat label="إجمالي المدفوع" value={stmt.data.summary.totalPaid} />
                  <Stat label="غير مدفوع" value={stmt.data.summary.unpaid} emphasis />
                  {/* عقد import-integration §٦: رصيد غير مفوتر = الرصيد الجاري − غير المدفوع (Decimal لا parseFloat) — يشمل الافتتاحي المستورد. */}
                  <Stat
                    label="رصيد غير مفوتر — يشمل الافتتاحي المستورد"
                    value={D(stmt.data.summary.currentBalance).minus(D(stmt.data.summary.unpaid)).toFixed(2)}
                  />
                  <StatBalance label="الرصيد الحالي" value={stmt.data.summary.currentBalance} />
                </div>
              </div>
            </CardContent>
          </Card>

          <StatementReconcile
            entityName={stmt.data.customer.name}
            entityType="customer"
            phone={stmt.data.customer.phone}
            currentBalance={stmt.data.summary.currentBalance}
            onPdf={printStatement}
          />

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الفواتير</div>
              <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">الفاتورة</th>
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">الاستحقاق</th>
                    <th className="p-2">المصدر</th>
                    <th className="p-2 text-right">الإجمالي</th>
                    <th className="p-2 text-right">المدفوع</th>
                    <th className="p-2 text-right">المتبقّي</th>
                    <th className="p-2">الحالة</th>
                    <th className="p-2 text-center">فتح</th>
                  </tr>
                </thead>
                <tbody>
                  {/* الرصيد المُرحَّل = افتتاحي مستورد + كل النشاط قبل from — صف أول يجعل رصيد نهاية الفترة قابلاً للتتبّع. */}
                  {from && (
                    <tr className="border-t bg-amber-50/60 font-medium">
                      <td className="p-2 text-xs">رصيد مُرحَّل</td>
                      <td className="p-2 text-xs" dir="ltr">{from}</td>
                      <td className="p-2 text-xs text-muted-foreground" colSpan={4}>ما قبل الفترة (افتتاحي + نشاط سابق)</td>
                      <td className="p-2 text-right tabular-nums font-semibold" dir="ltr">{fmt(stmt.data.summary.openingBalance)}</td>
                      <td className="p-2" colSpan={2} />
                    </tr>
                  )}
                  {stmt.data.invoices.map((i) => {
                    // §٥: نستعمل Decimal للطرح (positiveDiff) لا Number() float.
                    const remaining = positiveDiff(i.total, i.paidAmount).toFixed(2);
                    return (
                      <tr key={i.id} className="border-t">
                        <td className="p-2"><CopyInline value={i.invoiceNumber} /></td>
                        <td className="p-2 text-xs" dir="ltr">{new Date(i.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn")}</td>
                        <td className="p-2 text-xs" dir="ltr">{i.dueDate ? String(i.dueDate).slice(0, 10) : "—"}</td>
                        <td className="p-2 text-xs">{i.sourceType}</td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(i.total)}</td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(i.paidAmount)}</td>
                        <td className="p-2 text-right tabular-nums font-semibold" dir="ltr">{fmt(remaining)}</td>
                        <td className="p-2">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[i.status] ?? "bg-muted"}`}>
                            {STATUS_LABEL[i.status] ?? i.status}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <Link href={`/invoices/${i.id}`}>
                            <Button variant="outline" size="sm">فتح</Button>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                  {stmt.data.invoices.length === 0 && (
                    <TableEmptyRow colSpan={9} message="لا فواتير لهذا العميل." />
                  )}
                </tbody>
              </table>
              </ScrollTableShell>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الدفعات والاستردادات</div>
              <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">الفاتورة</th>
                    <th className="p-2">الاتجاه</th>
                    <th className="p-2">طريقة الدفع</th>
                    <th className="p-2 text-right">المبلغ</th>
                    <th className="p-2">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.data.payments.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 text-xs" dir="ltr">{new Date(p.createdAt).toLocaleString("ar-IQ-u-nu-latn")}</td>
                      <td className="p-2">
                        {p.isStandalone ? (
                          // سند مستقل (بلا فاتورة): كان غائباً عن الكشف فيبدو الرصيد منحرفاً بلا تفسير.
                          <span className="inline-flex items-center gap-1" title={p.description ?? undefined}>
                            <span className="inline-block rounded badge-status-done px-2 py-0.5 text-xs">سند مستقل</span>
                            {p.voucherNumber && <CopyInline value={p.voucherNumber} />}
                          </span>
                        ) : (
                          <CopyInline value={p.invoiceId} />
                        )}
                      </td>
                      <td className="p-2">
                        <span className={`inline-block rounded px-2 py-0.5 text-xs ${p.direction === "IN" ? "badge-status-active" : "badge-stock-out"}`}>
                          {p.direction === "IN" ? "وارد" : "صادر/استرداد"}
                        </span>
                      </td>
                      <td className="p-2 text-xs">{METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(p.amount)}</td>
                      <td className="p-2 text-xs">{p.status}</td>
                    </tr>
                  ))}
                  {stmt.data.payments.length === 0 && (
                    <TableEmptyRow colSpan={6} message="لا دفعات." />
                  )}
                </tbody>
              </table>
              </ScrollTableShell>
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

function StatBalance({ label, value }: { label: string; value: string | number }) {
  const num = Number(value);
  return (
    <div className={`rounded-md p-2 ${num > 0 ? "badge-status-active" : num < 0 ? "badge-stock-out" : "bg-muted/40"}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className={`tabular-nums text-xl font-bold ${num > 0 ? "text-money-positive" : num < 0 ? "text-money-negative" : ""}`} dir="ltr">
        {fmt(Math.abs(num))}
      </div>
      <div className={`text-xs font-semibold mt-0.5 ${num > 0 ? "text-money-positive" : num < 0 ? "text-money-negative" : "text-muted-foreground"}`}>
        {num > 0 ? "لنا عليه" : num < 0 ? "له علينا" : "لا ذمم"}
      </div>
    </div>
  );
}

/** منتقي عميل قابل للبحث بالكتابة (اسم/هاتف) — يَستبدل native select الذي لا يَدعم filter حيّاً مع 300+ عميل. */
function CustomerSearchPicker({
  customers,
  value,
  onChange,
}: {
  customers: { id: number; name: string; phone?: string | null }[];
  value: number;
  onChange: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => customers.find((c) => c.id === value) ?? null, [customers, value]);

  // النص المعروض في الحقل: اسم العميل المختار حين الإغلاق، أو نص البحث حين الفتح.
  const display = open ? q : selected ? `${selected.name}${selected.phone ? ` · ${selected.phone}` : ""}` : "";

  const filtered = useMemo(() => {
    const needle = q.trim();
    if (!needle) return customers.slice(0, 50);
    const lower = needle.toLowerCase();
    return customers
      .filter((c) => c.name.toLowerCase().includes(lower) || (c.phone ?? "").toLowerCase().includes(lower))
      .slice(0, 50);
  }, [customers, q]);

  useEffect(() => { setHighlight(0); }, [q, open]);

  // إغلاق عند النقر خارج المركّب.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function pick(id: number) {
    onChange(id);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && filtered[highlight]) { e.preventDefault(); pick(filtered[highlight].id); }
    else if (e.key === "Escape") { setOpen(false); setQ(""); }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Search aria-hidden className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          value={display}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="ابحث بالاسم أو الهاتف…"
          className="pr-9 pl-9"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
        />
        {(selected || q) && (
          <button
            type="button"
            onClick={() => { onChange(0); setQ(""); inputRef.current?.focus(); }}
            aria-label="مسح"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">لا نتائج لـ«{q}»</div>
          ) : (
            filtered.map((c, i) => (
              <button
                type="button"
                key={c.id}
                role="option"
                aria-selected={c.id === value}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(c.id)}
                className={`w-full text-right px-3 py-2 text-sm hover:bg-accent ${i === highlight ? "bg-accent" : ""} ${c.id === value ? "font-bold" : ""}`}
              >
                <div>{c.name}</div>
                {c.phone && <div className="text-xs text-muted-foreground" dir="ltr">{c.phone}</div>}
              </button>
            ))
          )}
          {customers.length > filtered.length && q.trim() === "" && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/30 text-center">
              يَعرض ٥٠ من أصل {customers.length} — اكتب للبحث
            </div>
          )}
        </div>
      )}
    </div>
  );
}
