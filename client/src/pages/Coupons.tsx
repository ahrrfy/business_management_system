import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Plus, Printer, Search, Ticket, XCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { TablePager } from "@/components/table/TablePager";
import { Field } from "@/components/product/variantBits";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { confirm } from "@/lib/confirm";
import { exportSheets, type SheetSpec } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D, fmtAr, formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printCouponCards, type CouponPrintLayout } from "@/lib/printing/couponCard";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type IssuedCoupon = RouterOutputs["crm"]["coupons"]["listIssued"]["rows"][number];
type CouponStatusFilter = "ALL" | "ACTIVE" | "REDEEMED" | "VOID";
type LastIssue = { codes: string[]; batchReference: string; issuedAt: Date };

const PAGE_SIZE = 50;
const PROGRAM_STATUS_AR: Record<string, string> = { DRAFT: "مسوّدة", ACTIVE: "نشط", PAUSED: "موقوف", ENDED: "منتهٍ" };
const COUPON_STATUS_AR: Record<string, string> = { ACTIVE: "نشط", REDEEMED: "مستخدم", VOID: "ملغى" };

function today() { return new Date().toISOString().slice(0, 10); }
function displayDate(value: unknown) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" });
}
function clampInt(value: string, min: number, max: number) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}
function Kpi({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-bold tabular-nums">{value}</div>{note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}</CardContent></Card>;
}

export default function Coupons() {
  const utils = trpc.useUtils();
  const programs = trpc.crm.coupons.programs.useQuery();
  const campaigns = trpc.crm.campaigns.list.useQuery();
  const offers = trpc.salesPromotions.list.useQuery({ includeInactive: false });
  const couponOffers = useMemo(() => (offers.data ?? []).filter((offer) => offer.applicationMode === "COUPON"), [offers.data]);
  const offerById = useMemo(() => new Map((offers.data ?? []).map((offer) => [offer.id, offer])), [offers.data]);

  const [showForm, setShowForm] = useState(false);
  const [promotionId, setPromotionId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [name, setName] = useState("");
  const [validFrom, setValidFrom] = useState(today());
  const [validTo, setValidTo] = useState("");
  const [prefix, setPrefix] = useState("CRM");
  const [perCouponLimit, setPerCouponLimit] = useState("1");
  const [perCustomerLimit, setPerCustomerLimit] = useState("1");
  const [title, setTitle] = useState("هدية خاصة لك");
  const [subtitle, setSubtitle] = useState("");
  const [terms, setTerms] = useState("");
  const [color, setColor] = useState("#0D6B52");

  const [selected, setSelected] = useState<number | null>(null);
  const selectedProgram = programs.data?.find((program) => program.id === selected) ?? null;
  const [count, setCount] = useState("10");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState("");
  const customerSearch = trpc.customers.search.useQuery(
    { q: customerQuery.trim(), limit: 20, offset: 0 },
    { enabled: customerId == null && customerQuery.trim().length >= 2 },
  );
  const [lastIssue, setLastIssue] = useState<LastIssue | null>(null);
  const [printing, setPrinting] = useState(false);

  const [page, setPage] = useState(0);
  const [codeQuery, setCodeQuery] = useState("");
  const [debouncedCodeQuery, setDebouncedCodeQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CouponStatusFilter>("ALL");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCodeQuery(codeQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [codeQuery]);
  useEffect(() => {
    setPage(0); setCodeQuery(""); setDebouncedCodeQuery(""); setStatusFilter("ALL");
    setLastIssue(null); setCustomerId(null); setCustomerName(""); setCustomerQuery("");
  }, [selected]);
  useEffect(() => setPage(0), [debouncedCodeQuery, statusFilter]);

  const issuedInput = selected == null ? null : {
    programId: selected,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    q: debouncedCodeQuery || undefined,
    status: statusFilter === "ALL" ? undefined : statusFilter,
  };
  const issued = trpc.crm.coupons.listIssued.useQuery(issuedInput!, { enabled: issuedInput != null });
  const batches = trpc.crm.coupons.batches.useQuery({ programId: selected!, limit: 50 }, { enabled: selected != null });
  const issuedRows = issued.data?.rows ?? [];
  const issuedTotal = issued.data?.total ?? 0;
  const activeCount = issued.data?.activeCount ?? selectedProgram?.activeCoupons ?? 0;

  const totals = useMemo(() => (programs.data ?? []).reduce((acc, program) => ({
    issued: acc.issued + program.issued,
    active: acc.active + program.activeCoupons,
    redeemed: acc.redeemed + program.redeemed,
    discount: acc.discount.plus(program.redeemedDiscount),
    sales: acc.sales.plus(program.linkedNetSales),
    profit: acc.profit.plus(program.linkedGrossProfit),
  }), { issued: 0, active: 0, redeemed: 0, discount: D(0), sales: D(0), profit: D(0) }), [programs.data]);

  const create = trpc.crm.coupons.createProgram.useMutation({
    onSuccess: async () => { await programs.refetch(); setShowForm(false); notify.ok("تم إنشاء برنامج الكوبونات كمسوّدة"); },
    onError: (error) => notify.err(error),
  });
  const status = trpc.crm.coupons.setProgramStatus.useMutation({
    onSuccess: async () => { await programs.refetch(); await utils.crm.dashboard.invalidate(); notify.ok("تم تحديث حالة البرنامج"); },
    onError: (error) => notify.err(error),
  });
  const issue = trpc.crm.coupons.issue.useMutation({
    onSuccess: async (result) => {
      setLastIssue(result);
      await Promise.all([issued.refetch(), batches.refetch(), programs.refetch()]);
      notify.ok(`أُصدرت دفعة ${result.batchReference} بعدد ${result.codes.length} كوبون`);
    },
    onError: (error) => notify.err(error),
  });
  const voidCoupon = trpc.crm.coupons.void.useMutation({
    onSuccess: async () => { await Promise.all([issued.refetch(), programs.refetch()]); notify.ok("أُبطل الكوبون"); },
    onError: (error) => notify.err(error),
  });

  function couponCards(codes: string[]) {
    const design = (selectedProgram?.designJson ?? {}) as { title?: string; subtitle?: string; terms?: string; color?: string };
    return codes.map((code) => ({ code, title: design.title ?? selectedProgram?.name, subtitle: design.subtitle, terms: design.terms, validTo: selectedProgram?.validTo, color: design.color }));
  }
  async function printCodes(codes: string[], layout: CouponPrintLayout) {
    if (!codes.length) return;
    const ok = await printCouponCards(couponCards(codes), { layout });
    if (!ok) notify.err("اسمح بنافذة الطباعة؛ ومنها يمكن الطباعة أو الحفظ PDF");
  }
  async function printActive() {
    if (!selected) return;
    setPrinting(true);
    try {
      const all = await fetchAllPaged<IssuedCoupon>((offset, limit) => utils.crm.coupons.listIssued.fetch({ programId: selected, limit, offset, status: "ACTIVE" }).then((result) => ({ rows: result.rows, total: result.total })), { pageSize: 500 });
      await printCodes(all.map((coupon) => coupon.code), "A4");
    } catch (error) { notify.err(error); } finally { setPrinting(false); }
  }
  async function endProgram(programId: number, programName: string) {
    const ok = await confirm({ variant: "danger", title: "إنهاء برنامج الكوبونات", description: `إنهاء «${programName}» نهائي ولا يمكن إعادة فتحه.`, confirmText: "إنهاء" });
    if (ok) status.mutate({ programId, status: "ENDED" });
  }
  async function doVoid(couponId: number, code: string) {
    const ok = await confirm({ variant: "danger", title: "إبطال الكوبون", description: `سيصبح الرمز «${code}» غير صالح نهائياً.`, confirmText: "إبطال" });
    if (ok) voidCoupon.mutate({ couponId });
  }
  function exportWorkbook() {
    if (!selected || !selectedProgram) return;
    const q = debouncedCodeQuery || undefined;
    const filterStatus = statusFilter === "ALL" ? undefined : statusFilter;
    exportSheets(`كوبونات-${selectedProgram.name}`, async () => {
      const all = await fetchAllPaged<IssuedCoupon>((offset, limit) => utils.crm.coupons.listIssued.fetch({ programId: selected, limit, offset, q, status: filterStatus }).then((result) => ({ rows: result.rows, total: result.total })), { pageSize: 500 });
      const batchRows = await utils.crm.coupons.batches.fetch({ programId: selected, limit: 200 });
      return [
        {
          sheetName: "الكوبونات", title: `سجل كوبونات — ${selectedProgram.name}`,
          meta: [{ label: "الحالة", value: statusFilter === "ALL" ? "كل الحالات" : COUPON_STATUS_AR[statusFilter] }, { label: "البحث", value: q || "بلا فلتر" }],
          rows: all,
          columns: [
            { key: "code", header: "الرمز" },
            { key: "status", header: "الحالة", map: (row) => COUPON_STATUS_AR[row.status] ?? row.status },
            { key: "assignedCustomerName", header: "العميل المخصص" },
            { key: "issuedAt", header: "تاريخ الإصدار", map: (row) => displayDate(row.issuedAt) },
            { key: "lastInvoiceNumber", header: "آخر فاتورة" },
            { key: "lastRedeemedAt", header: "آخر استخدام", map: (row) => displayDate(row.lastRedeemedAt) },
            { key: "redeemedDiscount", header: "الخصم المستخدم", money: true, map: (row) => D(row.redeemedDiscount).toNumber() },
          ],
        },
        {
          sheetName: "دفعات الإصدار", title: `دفعات الإصدار — ${selectedProgram.name}`,
          rows: batchRows,
          columns: [
            { key: "batchReference", header: "مرجع الدفعة" },
            { key: "count", header: "العدد" },
            { key: "customerId", header: "رقم العميل" },
            { key: "issuedAt", header: "وقت الإصدار", map: (row) => displayDate(row.issuedAt) },
            { key: "issuedBy", header: "أصدرها" },
          ],
        },
      ] as SheetSpec<any>[];
    });
  }

  return <div className="mx-auto max-w-7xl space-y-4 pb-8">
    <PageHeader title="الكوبونات" description="برامج وإصدارات قابلة للتدقيق، مرتبطة بعرض مالي حقيقي، مع Excel وطباعة 54×84 مم أو A4/PDF." actions={<Button onClick={() => setShowForm((value) => !value)}><Plus className="size-4" /> برنامج جديد</Button>} />

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <Kpi label="البرامج" value={programs.data?.length ?? 0} />
      <Kpi label="الكوبونات الصادرة" value={totals.issued} note={`${totals.active} صالحة الآن`} />
      <Kpi label="الكوبونات المستخدمة" value={totals.redeemed} note={totals.issued ? `${D(totals.redeemed).div(totals.issued).times(100).toDecimalPlaces(1)}٪ استخدام` : "لا إصدار بعد"} />
      <Kpi label="الخصم المسترد" value={formatIqd(totals.discount.toString())} />
      <Kpi label="مبيعات مرتبطة" value={formatIqd(totals.sales.toString())} />
      <Kpi label="ربح إجمالي مرتبط" value={formatIqd(totals.profit.toString())} note="بعد تكلفة البضاعة" />
    </div>

    {showForm && <Card>
      <CardHeader><CardTitle className="text-base">برنامج كوبونات جديد</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-4">
        <Field label="اسم البرنامج" required className="md:col-span-2"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="كوبونات العملاء العائدين" /></Field>
        <Field label="عرض بنمط كوبون" required className="md:col-span-2"><select className="h-9 w-full rounded-md border bg-transparent px-3" value={promotionId} onChange={(event) => setPromotionId(event.target.value)}><option value="">اختر العرض المالي</option>{couponOffers.map((offer) => <option key={offer.id} value={offer.id}>{offer.name} — {offer.type === "PERCENT" ? `${offer.discountPercent}٪` : `${fmtAr(offer.discountAmount)} د.ع لكل وحدة`}</option>)}</select></Field>
        <Field label="الحملة"><select className="h-9 w-full rounded-md border bg-transparent px-3" value={campaignId} onChange={(event) => setCampaignId(event.target.value)}><option value="">من العرض / بلا حملة</option>{(campaigns.data ?? []).map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></Field>
        <Field label="صالح من" required><Input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></Field>
        <Field label="صالح إلى"><Input type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} /></Field>
        <Field label="بادئة الرمز"><Input dir="ltr" maxLength={12} value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} /></Field>
        <Field label="مرات استخدام الكوبون"><Input type="number" min={1} max={1000} value={perCouponLimit} onChange={(event) => setPerCouponLimit(event.target.value)} /></Field>
        <Field label="حد الاستخدام لكل عميل"><Input type="number" min={1} max={1000} value={perCustomerLimit} onChange={(event) => setPerCustomerLimit(event.target.value)} /></Field>
        <Field label="عنوان البطاقة" className="md:col-span-2"><Input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label="عبارة قصيرة" className="md:col-span-2"><Input value={subtitle} maxLength={140} onChange={(event) => setSubtitle(event.target.value)} /></Field>
        <Field label="لون الهوية"><Input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></Field>
        <Field label="شروط مختصرة" className="md:col-span-3"><Input value={terms} maxLength={500} onChange={(event) => setTerms(event.target.value)} placeholder="لا يجمع مع سعر تعاقدي" /></Field>
        <div className="md:col-span-4 flex items-center justify-between gap-3 border-t pt-4"><div className="text-xs text-muted-foreground">يُنشأ البرنامج مسوّدة، ثم يُفعّل بعد مراجعة العرض والحملة.</div><Button disabled={!name.trim() || !promotionId || !validFrom || (!!validTo && validTo < validFrom) || create.isPending} onClick={() => create.mutate({ name: name.trim(), promotionId: Number(promotionId), campaignId: campaignId ? Number(campaignId) : null, validFrom, validTo: validTo || null, codePrefix: prefix || "CRM", perCouponLimit: clampInt(perCouponLimit, 1, 1000), perCustomerLimit: clampInt(perCustomerLimit, 1, 1000), design: { title: title || undefined, subtitle: subtitle || undefined, terms: terms || undefined, color } })}>حفظ كمسوّدة</Button></div>
      </CardContent>
    </Card>}

    <Card><CardHeader><CardTitle className="text-base">البرامج والأثر المالي</CardTitle></CardHeader><CardContent><div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[1050px] text-sm"><thead className="bg-muted/60 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-right">البرنامج / العرض</th><th className="px-3 py-2 text-right">الحالة</th><th className="px-3 py-2 text-right">صادر / صالح / مستخدم</th><th className="px-3 py-2 text-right">معدل الاستخدام</th><th className="px-3 py-2 text-right">الخصم</th><th className="px-3 py-2 text-right">المبيعات</th><th className="px-3 py-2 text-right">الربح الإجمالي</th><th className="px-3 py-2 text-right">الإجراء</th></tr></thead>
      <tbody>{(programs.data ?? []).map((program) => { const offer = offerById.get(program.promotionId); const redemptionRate = program.issued ? D(program.redeemed).div(program.issued).times(100).toDecimalPlaces(1).toString() : "0"; return <tr key={program.id} className={`border-t ${selected === program.id ? "bg-primary/5" : ""}`}><td className="px-3 py-2"><button type="button" className="text-right" onClick={() => setSelected(program.id)}><div className="font-medium text-primary">{program.name}</div><div className="text-xs text-muted-foreground">{offer?.name ?? `عرض #${program.promotionId}`} · {offer?.type === "PERCENT" ? `${offer.discountPercent}٪` : `${fmtAr(offer?.discountAmount)} د.ع/وحدة`}</div></button></td><td className="px-3 py-2"><Badge variant={program.status === "ACTIVE" ? "default" : "secondary"}>{PROGRAM_STATUS_AR[program.status] ?? program.status}</Badge></td><td className="px-3 py-2 tabular-nums">{program.issued} / {program.activeCoupons} / {program.redeemed}</td><td className="px-3 py-2 tabular-nums">{redemptionRate}٪</td><td className="px-3 py-2 tabular-nums">{formatIqd(program.redeemedDiscount)}</td><td className="px-3 py-2 tabular-nums">{formatIqd(program.linkedNetSales)}</td><td className={`px-3 py-2 tabular-nums ${D(program.linkedGrossProfit).isNegative() ? "text-destructive" : ""}`}>{formatIqd(program.linkedGrossProfit)}</td><td className="px-3 py-2"><div className="flex gap-1">{program.status === "DRAFT" && <Button size="sm" onClick={() => status.mutate({ programId: program.id, status: "ACTIVE" })}>تفعيل</Button>}{program.status === "ACTIVE" && <Button size="sm" variant="outline" onClick={() => status.mutate({ programId: program.id, status: "PAUSED" })}>إيقاف</Button>}{program.status === "PAUSED" && <Button size="sm" onClick={() => status.mutate({ programId: program.id, status: "ACTIVE" })}>استئناف</Button>}{program.status !== "ENDED" && <Button size="sm" variant="ghost" onClick={() => void endProgram(program.id, program.name)}>إنهاء</Button>}<Button size="sm" variant="ghost" onClick={() => setSelected(program.id)}>فتح</Button></div></td></tr>; })}{(programs.data?.length ?? 0) === 0 && <tr><td colSpan={8} className="py-10 text-center text-muted-foreground">لا برامج بعد. أنشئ عرضاً بنمط كوبون أولاً، ثم أنشئ البرنامج.</td></tr>}</tbody></table></div></CardContent></Card>

    {selectedProgram && <div className="grid gap-4 xl:grid-cols-[0.8fr_1.5fr]">
      <div className="space-y-4">
        <Card><CardHeader><CardTitle className="text-base">إصدار دفعة — {selectedProgram.name}</CardTitle></CardHeader><CardContent className="space-y-4"><div className="grid grid-cols-2 gap-3"><Field label="عدد الكوبونات"><Input type="number" min={1} max={500} value={count} onChange={(event) => setCount(event.target.value)} /></Field><Field label="تخصيص لعميل (اختياري)"><Input value={customerId == null ? customerQuery : customerName} onChange={(event) => { setCustomerId(null); setCustomerName(""); setCustomerQuery(event.target.value); }} placeholder="ابحث بالاسم أو الهاتف" /></Field></div>
          {customerId == null && customerQuery.trim().length >= 2 && <div className="max-h-36 overflow-auto rounded-md border">{(customerSearch.data?.rows ?? []).map((customer) => <button type="button" key={customer.id} className="block w-full border-b px-3 py-2 text-right text-sm last:border-0 hover:bg-muted" onClick={() => { setCustomerId(customer.id); setCustomerName(customer.name); setCustomerQuery(""); }}>{customer.name}</button>)}{customerSearch.isFetched && (customerSearch.data?.rows.length ?? 0) === 0 && <div className="p-3 text-xs text-muted-foreground">لا عميل مطابق.</div>}</div>}
          {customerId != null && <div className="flex items-center justify-between rounded-md border bg-muted/30 p-2 text-sm"><span>مخصص إلى: <b>{customerName}</b></span><Button size="sm" variant="ghost" onClick={() => { setCustomerId(null); setCustomerName(""); }}>إزالة</Button></div>}
          <Button className="w-full" disabled={selectedProgram.status === "ENDED" || issue.isPending} onClick={() => issue.mutate({ programId: selectedProgram.id, count: clampInt(count, 1, 500), customerId })}><Ticket className="size-4" /> {issue.isPending ? "جارٍ الإصدار…" : "إصدار الدفعة"}</Button><div className="text-xs text-muted-foreground">الإصدار عملية ذرية مسجلة: إما تُنشأ الدفعة كاملة أو لا يُنشأ شيء.</div>
          {lastIssue && <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3"><div className="font-medium">تم الإصدار: <span dir="ltr">{lastIssue.batchReference}</span></div><div className="text-xs text-muted-foreground">{lastIssue.codes.length} كوبون · {displayDate(lastIssue.issuedAt)}</div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void printCodes(lastIssue.codes, "CARD")}><Printer className="size-4" /> بطاقات 54×84</Button><Button size="sm" variant="outline" onClick={() => void printCodes(lastIssue.codes, "A4")}><FileText className="size-4" /> A4 / حفظ PDF</Button></div></div>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">دفعات الإصدار الأخيرة</CardTitle></CardHeader><CardContent><div className="max-h-72 overflow-auto rounded-md border"><table className="w-full text-sm"><thead className="bg-muted/60 text-xs"><tr><th className="p-2 text-right">المرجع</th><th className="p-2 text-right">العدد</th><th className="p-2 text-right">الوقت / المستخدم</th></tr></thead><tbody>{(batches.data ?? []).map((batch) => <tr key={batch.id} className="border-t"><td className="p-2 font-mono text-xs" dir="ltr">{batch.batchReference}</td><td className="p-2">{batch.count}</td><td className="p-2 text-xs">{displayDate(batch.issuedAt)}<div className="text-muted-foreground">{batch.issuedBy}</div></td></tr>)}{batches.isFetched && (batches.data?.length ?? 0) === 0 && <tr><td colSpan={3} className="py-8 text-center text-muted-foreground">لا دفعات مسجلة.</td></tr>}</tbody></table></div></CardContent></Card>
      </div>
      <Card><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-base">سجل الكوبونات</CardTitle><span className="text-xs text-muted-foreground">حقل الرمز في الطباعة: 40×8 مم</span></CardHeader><CardContent><div className="mb-3 flex flex-wrap items-center gap-2"><div className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="h-8 pr-8" value={codeQuery} onChange={(event) => setCodeQuery(event.target.value)} placeholder="بحث خادمي بالرمز…" /></div><AppSelect value={statusFilter} onValueChange={(value) => setStatusFilter(value as CouponStatusFilter)} className="h-8 w-32" size="sm"><option value="ALL">كل الحالات</option><option value="ACTIVE">نشط</option><option value="REDEEMED">مستخدم</option><option value="VOID">ملغى</option></AppSelect><Button size="sm" variant="outline" onClick={exportWorkbook}><Download className="size-4" /> Excel شامل</Button><Button size="sm" variant="outline" disabled={activeCount === 0 || printing} onClick={() => void printActive()}><FileText className="size-4" /> {printing ? "تحضير…" : `A4 / PDF للنشطة (${activeCount})`}</Button></div>
        <div className="max-h-[620px] overflow-auto rounded-md border"><table className="w-full min-w-[900px] text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-2 text-right">الرمز</th><th className="p-2 text-right">الحالة</th><th className="p-2 text-right">العميل</th><th className="p-2 text-right">الإصدار</th><th className="p-2 text-right">الاستخدام / الفاتورة</th><th className="p-2 text-right">الخصم</th><th className="p-2"></th></tr></thead><tbody>{issuedRows.map((coupon) => <tr key={coupon.id} className="border-t"><td className="p-2 font-mono font-bold" dir="ltr">{coupon.code}</td><td className="p-2"><Badge variant={coupon.status === "ACTIVE" ? "default" : "secondary"}>{COUPON_STATUS_AR[coupon.status] ?? coupon.status}</Badge></td><td className="p-2">{coupon.assignedCustomerName ?? "عام"}</td><td className="p-2 text-xs">{displayDate(coupon.issuedAt)}</td><td className="p-2 text-xs">{coupon.lastInvoiceNumber ? <><div>{coupon.lastInvoiceNumber}</div><div className="text-muted-foreground">{displayDate(coupon.lastRedeemedAt)}</div></> : "—"}</td><td className="p-2 tabular-nums">{formatIqd(coupon.redeemedDiscount)}</td><td className="p-1">{coupon.status === "ACTIVE" && <Button size="sm" variant="ghost" title="إبطال" onClick={() => void doVoid(coupon.id, coupon.code)}><XCircle className="size-4 text-destructive" /></Button>}</td></tr>)}{issued.isFetched && issuedRows.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-muted-foreground">لا كوبونات مطابقة.</td></tr>}</tbody></table></div>
        <TablePager page={page} onPageChange={setPage} pageSize={PAGE_SIZE} rowsOnPage={issuedRows.length} total={issuedTotal} isLoading={issued.isFetching} />
      </CardContent></Card>
    </div>}
  </div>;
}
