import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { CopyInline } from "@/components/CopyButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { RowActions } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printVoucherReceipt, printVoucherA4, type VoucherPrintData } from "@/lib/printing/voucherPrint";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, XCircle, Paperclip, ShieldQuestion } from "lucide-react";

type VoucherRow = RouterOutputs["vouchers"]["list"][number];

/** سجلّ السندات المستقلّة (قبض + صرف) — vouchers-pro: تَصنيف + اعتماد + بَصمة + مُرفق. */
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const TYPE_LABEL: Record<string, string> = { IN: "قبض", OUT: "صرف" };
const PARTY_LABEL: Record<string, string> = { CUSTOMER: "عميل", SUPPLIER: "مورّد", OTHER: "أخرى" };
const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صكّ", TRANSFER: "تحويل", WALLET: "محفظة",
};
const APPROVAL_LABEL: Record<string, string> = {
  APPROVED: "مُعتمَد",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  REJECTED: "مَرفوض",
};

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("ar-IQ-u-nu-latn");
}

function shortHash(h?: string | null): string {
  return h ? String(h).slice(0, 8).toUpperCase() : "—";
}

export default function Vouchers() {
  const utils = trpc.useUtils();
  const [voucherType, setVoucherType] = useState<"" | "RECEIPT" | "PAYMENT">("");
  const [partyType, setPartyType] = useState<"" | "CUSTOMER" | "SUPPLIER" | "OTHER">("");
  const [paymentMethod, setPaymentMethod] = useState<"" | "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET">("");
  const [approvalStatus, setApprovalStatus] = useState<"" | "APPROVED" | "PENDING_APPROVAL" | "REJECTED">("");
  const [voucherCategoryId, setVoucherCategoryId] = useState<"" | number>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const limit = 100;

  const categories = trpc.voucherCategories.list.useQuery({ includeInactive: true });

  const filterInput = useMemo(
    () => ({
      voucherType: voucherType || undefined,
      partyType: partyType || undefined,
      paymentMethod: paymentMethod || undefined,
      approvalStatus: approvalStatus || undefined,
      voucherCategoryId: voucherCategoryId === "" ? undefined : Number(voucherCategoryId),
      from: from || undefined,
      to: to || undefined,
    }),
    [voucherType, partyType, paymentMethod, approvalStatus, voucherCategoryId, from, to],
  );

  const input = useMemo(
    () => ({ ...filterInput, limit, offset: page * limit }),
    [filterInput, page],
  );
  const list = trpc.vouchers.list.useQuery(input);
  const all = list.data ?? [];

  const cancelMut = trpc.vouchers.cancel.useMutation({
    onSuccess: async (res) => {
      await utils.vouchers.list.invalidate();
      notify.ok(`أُلغي السند ${res.voucherNumber} وعُكست آثاره المالية`);
    },
    onError: (e) => notify.err(e),
  });

  const approveMut = trpc.vouchers.approve.useMutation({
    onSuccess: async (res) => {
      await utils.vouchers.list.invalidate();
      notify.ok(`اعتُمد السند ${res.voucherNumber} — بَصمة ${shortHash(res.signatureHash)}`);
    },
    onError: (e) => notify.err(e),
  });

  const rejectMut = trpc.vouchers.reject.useMutation({
    onSuccess: async (res) => {
      await utils.vouchers.list.invalidate();
      notify.ok(`رُفض السند ${res.voucherNumber}`);
    },
    onError: (e) => notify.err(e),
  });

  async function approveVoucher(r: VoucherRow) {
    const ok = await confirm({
      variant: "info",
      title: "اعتماد السند",
      description: `سَيُصبح السند ${r.voucherNumber ?? ""} مُعتمَداً ويُسجَّل قيد الدفتر ويُؤثّر على ${
        r.partyType === "CUSTOMER" ? "ذمة العميل" : r.partyType === "SUPPLIER" ? "ذمة المورّد" : "الصندوق"
      } بمبلغ ${fmt(r.amount)} د.ع. هل تتابع؟`,
      confirmText: "اعتماد",
      cancelText: "تراجع",
    });
    if (!ok) return;
    approveMut.mutate({ receiptId: Number(r.id) });
  }

  async function rejectVoucher(r: VoucherRow) {
    const reason = window.prompt(`سبب رفض السند ${r.voucherNumber ?? ""}؟ (إلزامي للسجل التَدقيقي)`);
    if (!reason || !reason.trim()) return;
    rejectMut.mutate({ receiptId: Number(r.id), reason: reason.trim() });
  }

  async function cancelVoucher(r: VoucherRow) {
    const partyLabel = PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—";
    const ok = await confirm({
      variant: "danger",
      title: "إلغاء السند",
      description: `سيُعلَّم السند ${r.voucherNumber ?? ""} «مُلغى» ويُعكس مبلغ ${fmt(r.amount)} د.ع (الطرف: ${partyLabel}) في الصندوق والدفتر ورصيد الطرف. هل تتابع؟`,
      confirmText: "إلغاء السند",
      cancelText: "تراجع",
    });
    if (!ok) return;
    cancelMut.mutate({ receiptId: Number(r.id) });
  }

  // فلتر بحث محلّي (وصف/رقم السند/اسم المُستفيد).
  const rows = useMemo(() => {
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all.filter((r) =>
      String(r.voucherNumber ?? "").toLowerCase().includes(needle) ||
      String(r.description ?? "").toLowerCase().includes(needle) ||
      String(r.counterpartyName ?? "").toLowerCase().includes(needle),
    );
  }, [all, q]);

  // المَجاميع تَستثني الملغاة و«بانتظار الاعتماد» (لم يُسجَّل أَثَر مالي بَعد).
  const totals = useMemo(() => {
    let inn = 0;
    let out = 0;
    let pending = 0;
    for (const r of rows) {
      if (r.status === "REVERSED") continue;
      const amt = Number(r.amount ?? 0);
      if (r.approvalStatus === "PENDING_APPROVAL") { pending += amt; continue; }
      if (r.direction === "IN") inn += amt;
      else out += amt;
    }
    return { inn, out, pending, net: inn - out };
  }, [rows]);

  const categoryMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories.data ?? []) m.set(Number(c.id), c.name);
    return m;
  }, [categories.data]);

  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      const fetched = await fetchAllPaged<VoucherRow>(
        (offset, lim) =>
          utils.vouchers.list
            .fetch({ ...filterInput, limit: lim, offset })
            .then((arr) => ({ rows: (arr ?? []) as VoucherRow[] })),
        { pageSize: 200 },
      );
      const needle = q.trim().toLowerCase();
      const exportData = needle
        ? fetched.filter(
            (r) =>
              String(r.voucherNumber ?? "").toLowerCase().includes(needle) ||
              String(r.description ?? "").toLowerCase().includes(needle) ||
              String(r.counterpartyName ?? "").toLowerCase().includes(needle),
          )
        : fetched;
      exportRows(exportData, {
        filename: "السندات",
        columns: [
          { key: "voucherNumber", header: "رقم السند" },
          { key: "voucherDate", header: "تاريخ السند", map: (r) => fmtDate(r.voucherDate as any) },
          { key: "createdAt", header: "تاريخ الإدخال", map: (r) => fmtDate(r.createdAt as any) },
          { key: "direction", header: "النوع", map: (r) => TYPE_LABEL[r.direction] ?? r.direction },
          { key: "partyType", header: "نوع الطرف", map: (r) => PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—" },
          { key: "counterpartyName", header: "اسم المُستفيد" },
          {
            key: "voucherCategoryId",
            header: "الفئة",
            map: (r) => (r.voucherCategoryId ? (categoryMap.get(Number(r.voucherCategoryId)) ?? "—") : "—"),
          },
          { key: "description", header: "الوصف" },
          { key: "amount", header: "المبلغ", map: (r) => Number(r.amount ?? 0) },
          { key: "paymentMethod", header: "الدفع", map: (r) => METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod },
          { key: "referenceNumber", header: "الرقم المرجعي" },
          { key: "checkNumber", header: "رقم الصكّ" },
          { key: "cardLastFour", header: "آخر ٤ بطاقة" },
          { key: "approvalStatus", header: "حالة الاعتماد", map: (r) => APPROVAL_LABEL[r.approvalStatus ?? "APPROVED"] ?? "—" },
          { key: "status", header: "الحالة", map: (r) => (r.status === "REVERSED" ? "مُلغى" : "مكتمل") },
          { key: "attachmentUrl", header: "المُرفَق" },
          { key: "signatureHash", header: "بَصمة", map: (r) => shortHash(r.signatureHash) },
          { key: "cashBucket", header: "نوع النَقد", map: (r) => (r.cashBucket === "DRAWER" ? "درج كاشير" : r.cashBucket === "TREASURY" ? "خزينة إدارية" : "—") },
        ],
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  // طباعة السند: نَطلب السند الكامل من السيرفر (يَتضمَّن createdByName/approvedByName/categoryName/partyName).
  async function printVoucher(r: VoucherRow, mode: "thermal" | "a4") {
    try {
      const v = await utils.vouchers.get.fetch({ receiptId: Number(r.id) });
      if (!v) { notify.err("تعذّر جَلب تفاصيل السند"); return; }
      const branchName = null; // يُمكن إضافة branches.list هنا لاحقاً إذا لَزِم
      const payload: VoucherPrintData = {
        voucherNumber: v.voucherNumber ?? "",
        direction: v.direction as "IN" | "OUT",
        voucherDate: String(v.voucherDate ?? fmtDate(v.createdAt as any)).slice(0, 10),
        createdAt: String(v.createdAt),
        branchName,
        amount: fmt(v.amount),
        paymentMethod: v.paymentMethod,
        paymentMethodLabel: METHOD_LABEL[v.paymentMethod] ?? v.paymentMethod,
        referenceNumber: v.referenceNumber,
        checkNumber: v.checkNumber,
        cardLastFour: v.cardLastFour,
        partyTypeLabel: PARTY_LABEL[v.partyType ?? "OTHER"] ?? "—",
        partyName: v.partyName ?? (v.counterpartyName ?? "—"),
        partyBalance: null,
        categoryName: v.categoryName,
        description: v.description ?? "",
        counterpartyName: v.counterpartyName,
        approvalStatus: v.approvalStatus as "APPROVED" | "PENDING_APPROVAL" | "REJECTED",
        approvedByName: v.approvedByName,
        approvedAt: v.approvedAt ? String(v.approvedAt) : null,
        createdByName: v.createdByName,
        cashBucket: v.cashBucket as "DRAWER" | "TREASURY" | null,
        signatureHash: v.signatureHash,
        attachmentUrl: v.attachmentUrl,
      };
      if (mode === "a4") await printVoucherA4(payload);
      else await printVoucherReceipt(payload);
    } catch (e) {
      notify.err(e);
    }
  }

  const statementHref = (r: VoucherRow) =>
    r.partyType === "CUSTOMER" ? `/customers-statement?id=${r.partyId}` : `/suppliers-statement?id=${r.partyId}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="سندات القبض والصرف"
        description="سندات مستقلّة بلا فاتورة — رواتب، إيجارات، إيرادات متفرّقة، دفعات لعميل/مورّد بلا ربط بفاتورة محدّدة."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/voucher-categories">
              <Button variant="outline" size="sm">إدارة الفئات</Button>
            </Link>
            <Link href="/vouchers/receipt/new">
              <Button className="bg-emerald-600 hover:bg-emerald-700">+ سند قبض</Button>
            </Link>
            <Link href="/vouchers/payment/new">
              <Button className="bg-rose-600 hover:bg-rose-700">+ سند صرف</Button>
            </Link>
          </div>
        }
      />

      <Card>
        <CardHeader><CardTitle className="text-base">فلاتر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-7 gap-3 items-end">
          <div className="space-y-1">
            <Label>النوع</Label>
            <select className={selectCls} value={voucherType} onChange={(e) => { setVoucherType(e.target.value as any); setPage(0); }}>
              <option value="">الكل</option>
              <option value="RECEIPT">قبض</option>
              <option value="PAYMENT">صرف</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>الطرف</Label>
            <select className={selectCls} value={partyType} onChange={(e) => { setPartyType(e.target.value as any); setPage(0); }}>
              <option value="">الكل</option>
              <option value="CUSTOMER">عميل</option>
              <option value="SUPPLIER">مورّد</option>
              <option value="OTHER">أخرى</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>طريقة الدفع</Label>
            <select className={selectCls} value={paymentMethod} onChange={(e) => { setPaymentMethod(e.target.value as any); setPage(0); }}>
              <option value="">الكل</option>
              <option value="CASH">نقدي</option>
              <option value="CARD">بطاقة</option>
              <option value="CHECK">صكّ</option>
              <option value="TRANSFER">تحويل</option>
              <option value="WALLET">محفظة</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>الاعتماد</Label>
            <select className={selectCls} value={approvalStatus} onChange={(e) => { setApprovalStatus(e.target.value as any); setPage(0); }}>
              <option value="">الكل</option>
              <option value="APPROVED">مُعتمَد</option>
              <option value="PENDING_APPROVAL">بانتظار الاعتماد</option>
              <option value="REJECTED">مَرفوض</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>الفئة</Label>
            <select className={selectCls} value={voucherCategoryId === "" ? "" : String(voucherCategoryId)} onChange={(e) => { setVoucherCategoryId(e.target.value === "" ? "" : Number(e.target.value)); setPage(0); }}>
              <option value="">الكل</option>
              {(categories.data ?? []).map((c) => (
                <option key={Number(c.id)} value={Number(c.id)}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
          </div>
          <div className="space-y-1">
            <Label>إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
          </div>
          <div className="space-y-1 md:col-span-4 lg:col-span-7">
            <Label>بحث (رقم/وصف/اسم مُستفيد)</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="مثال: راتب، RV-1-…، أحمد محمد" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي القبض (مُعتمَد)</div>
            <div className="text-xl font-bold text-money-positive tabular-nums" dir="ltr">{fmt(totals.inn)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي الصرف (مُعتمَد)</div>
            <div className="text-xl font-bold text-money-negative tabular-nums" dir="ltr">{fmt(totals.out)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">الصافي</div>
            <div className={`text-xl font-bold tabular-nums ${totals.net >= 0 ? "text-money-positive" : "text-money-negative"}`} dir="ltr">
              {fmt(totals.net)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <ShieldQuestion aria-hidden className="size-3.5" />
              بانتظار اعتماد (بلا أَثَر)
            </div>
            <div className="text-xl font-bold text-amber-700 tabular-nums" dir="ltr">{fmt(totals.pending)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">القائمة</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {list.isLoading ? "" : `${rows.length.toLocaleString("ar-IQ-u-nu-latn")} سند`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0 || exporting}
              onClick={() => void exportAll()}
            >
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">رقم السند</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2 text-center">النوع</th>
                  <th className="p-2">الطرف</th>
                  <th className="p-2">الفئة</th>
                  <th className="p-2">الوصف</th>
                  <th className="p-2 text-right">المبلغ</th>
                  <th className="p-2 text-center">الدفع</th>
                  <th className="p-2 text-center">الاعتماد</th>
                  <th className="p-2 text-center">المُرفَق</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading && (
                  <tr><td colSpan={11}><LoadingState /></td></tr>
                )}
                {list.isError && !list.isLoading && (
                  <tr>
                    <td colSpan={11}>
                      <ErrorState message={list.error?.message} onRetry={() => void list.refetch()} />
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const partyDisplay = r.partyType === "OTHER"
                    ? (r.counterpartyName ?? "—")
                    : (PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—");
                  const isPending = r.approvalStatus === "PENDING_APPROVAL";
                  const isRejected = r.approvalStatus === "REJECTED";
                  return (
                    <tr
                      key={Number(r.id)}
                      className={`border-t ${r.status === "REVERSED" ? "opacity-60" : ""} ${isPending ? "bg-amber-50/60 dark:bg-amber-950/20" : ""} ${isRejected ? "bg-rose-50/60 dark:bg-rose-950/20" : ""}`}
                    >
                      <td className="p-2 font-mono text-xs">
                        <CopyInline value={String(r.voucherNumber ?? "—")} />
                        {r.signatureHash && (
                          <div className="text-[10px] text-muted-foreground" title={`بَصمة كاملة: ${r.signatureHash}`}>
                            #{shortHash(r.signatureHash)}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-xs">
                        {fmtDate(r.voucherDate as any)}
                        {r.voucherDate && r.createdAt && (
                          <div className="text-[10px] text-muted-foreground">
                            أُدخل: {fmtDate(r.createdAt as any)}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-center">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.direction === "IN" ? "badge-status-active" : "badge-stock-out"}`}>
                          {TYPE_LABEL[r.direction]}
                        </span>
                      </td>
                      <td className="p-2 text-xs">
                        {partyDisplay}
                        {r.partyType !== "OTHER" && r.counterpartyName && (
                          <div className="text-[10px] text-muted-foreground">{r.counterpartyName}</div>
                        )}
                      </td>
                      <td className="p-2 text-xs">
                        {r.voucherCategoryId ? (categoryMap.get(Number(r.voucherCategoryId)) ?? "—") : "—"}
                      </td>
                      <td className="p-2">{r.description ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.amount)}</td>
                      <td className="p-2 text-center text-xs">{METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</td>
                      <td className="p-2 text-center">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                          isPending ? "bg-amber-100 text-amber-800"
                          : isRejected ? "bg-rose-100 text-rose-800"
                          : "bg-emerald-100 text-emerald-800"
                        }`}>
                          {isPending && <ShieldQuestion aria-hidden className="size-3" />}
                          {isRejected && <XCircle aria-hidden className="size-3" />}
                          {!isPending && !isRejected && <CheckCircle2 aria-hidden className="size-3" />}
                          {APPROVAL_LABEL[r.approvalStatus ?? "APPROVED"]}
                        </span>
                      </td>
                      <td className="p-2 text-center">
                        {r.attachmentUrl ? (
                          <a href={r.attachmentUrl} target="_blank" rel="noreferrer" title={r.attachmentUrl}>
                            <Paperclip aria-hidden className="size-4 text-emerald-700 inline" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="p-2 text-center">
                        <RowActions
                          mode="auto"
                          actions={[
                            { key: "print-thermal", label: "طباعة حرارية", onSelect: () => void printVoucher(r, "thermal") },
                            { key: "print-a4", label: "طباعة A4 (PDF)", onSelect: () => void printVoucher(r, "a4") },
                            {
                              key: "approve",
                              label: "اعتماد السند",
                              hidden: r.approvalStatus !== "PENDING_APPROVAL",
                              disabled: approveMut.isPending,
                              onSelect: () => void approveVoucher(r),
                            },
                            {
                              key: "reject",
                              label: "رفض السند",
                              variant: "destructive",
                              hidden: r.approvalStatus !== "PENDING_APPROVAL",
                              disabled: rejectMut.isPending,
                              onSelect: () => void rejectVoucher(r),
                            },
                            {
                              key: "stmt",
                              label: "كشف حساب الطرف",
                              href: statementHref(r),
                              hidden: r.partyType === "OTHER" || r.partyType == null || r.partyId == null,
                            },
                            {
                              key: "cancel",
                              label: "إلغاء السند",
                              variant: "destructive",
                              hidden: r.status === "REVERSED",
                              disabled: cancelMut.isPending,
                              onSelect: () => void cancelVoucher(r),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {!list.isLoading && !list.isError && rows.length === 0 && (
                  <TableEmptyRow colSpan={11} message="لا سندات مطابقة. أضِف سند قبض أو صرف جديداً." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {all.length >= limit && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← السابق</Button>
          <div className="text-muted-foreground">صفحة {page + 1}</div>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>التالي →</Button>
        </div>
      )}
    </div>
  );
}
