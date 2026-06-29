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
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printDoc } from "@/lib/printing/print";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

type VoucherRow = RouterOutputs["vouchers"]["list"][number];

/** سجلّ السندات المستقلّة (قبض + صرف) مع فلاتر وتصدير. */
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const TYPE_LABEL: Record<string, string> = { IN: "قبض", OUT: "صرف" };
const PARTY_LABEL: Record<string, string> = { CUSTOMER: "عميل", SUPPLIER: "مورّد", OTHER: "أخرى" };
const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة",
};

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("ar-IQ-u-nu-latn");
}

export default function Vouchers() {
  const utils = trpc.useUtils();
  const [voucherType, setVoucherType] = useState<"" | "RECEIPT" | "PAYMENT">("");
  const [partyType, setPartyType] = useState<"" | "CUSTOMER" | "SUPPLIER" | "OTHER">("");
  // فلتر الفترة خادمي (createdAt) — لا فلترة محلية تُخفي صفحات الخادم.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const limit = 100;

  const input = useMemo(
    () => ({
      voucherType: voucherType || undefined,
      partyType: partyType || undefined,
      from: from || undefined,
      to: to || undefined,
      limit,
      offset: page * limit,
    }),
    [voucherType, partyType, from, to, page],
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

  // إلغاء سند بعد تأكيد خطِر — يَعكس المبلغ والقيد ورصيد الطرف.
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

  // فلتر بحث محلّي (وصف/رقم السند).
  const rows = useMemo(() => {
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all.filter((r) =>
      String(r.voucherNumber ?? "").toLowerCase().includes(needle) ||
      String(r.description ?? "").toLowerCase().includes(needle),
    );
  }, [all, q]);

  // المجاميع تستثني الملغاة (REVERSED) — أثرها المالي معكوس فلا تُحسب.
  const totals = useMemo(() => {
    let inn = 0;
    let out = 0;
    for (const r of rows) {
      if (r.status === "REVERSED") continue;
      const amt = Number(r.amount ?? 0);
      if (r.direction === "IN") inn += amt;
      else out += amt;
    }
    return { inn, out, net: inn - out };
  }, [rows]);

  // طباعة السند عبر printDoc العام (جسر الخادم ← WebUSB ← المتصفح) — عنوان حسب النوع.
  async function printVoucher(r: VoucherRow) {
    try {
      await printDoc({
        kind: "receipt",
        title: r.direction === "IN" ? "سند قبض" : "سند صرف",
        subtitle: "الرؤية العربية — المكتبة العربية",
        meta: [
          `رقم السند: ${r.voucherNumber ?? "—"}`,
          `التاريخ: ${fmtDate(r.createdAt)}`,
          `الوصف: ${r.description ?? "—"}`,
        ],
        totals: [
          { label: "المبلغ", value: fmt(r.amount) },
          { label: "طريقة الدفع", value: METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod },
        ],
      });
    } catch (e) {
      notify.err(e);
    }
  }

  // كشف حساب الطرف: عميل ⇒ كشف العملاء، مورّد ⇒ كشف الموردين (مخفي لـOTHER/بلا طرف).
  const statementHref = (r: VoucherRow) =>
    r.partyType === "CUSTOMER" ? `/customers-statement?id=${r.partyId}` : `/suppliers-statement?id=${r.partyId}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="سندات القبض والصرف"
        description="سندات مستقلّة بلا فاتورة — رواتب، إيجارات، إيرادات متفرّقة، دفعات لعميل/مورّد بلا ربط بفاتورة محدّدة."
        actions={
          <div className="flex flex-wrap gap-2">
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
        <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <div className="space-y-1">
            <Label>النوع</Label>
            <select className={selectCls} value={voucherType} onChange={(e) => { setVoucherType(e.target.value as any); setPage(0); }}>
              <option value="">الكل</option>
              <option value="RECEIPT">قبض (IN)</option>
              <option value="PAYMENT">صرف (OUT)</option>
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
            <Label>من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
          </div>
          <div className="space-y-1">
            <Label>إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
          </div>
          <div className="space-y-1">
            <Label>بحث (رقم/وصف)</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="مثال: راتب، RV-1-…" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي القبض</div>
            <div className="text-xl font-bold text-money-positive tabular-nums" dir="ltr">{fmt(totals.inn)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي الصرف</div>
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
              disabled={rows.length === 0}
              onClick={() =>
                exportRows(rows, {
                  filename: "السندات",
                  columns: [
                    { key: "voucherNumber", header: "رقم السند" },
                    { key: "createdAt", header: "التاريخ", map: (r) => fmtDate(r.createdAt as any) },
                    { key: "direction", header: "النوع", map: (r) => TYPE_LABEL[r.direction] ?? r.direction },
                    { key: "partyType", header: "الطرف", map: (r) => PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—" },
                    { key: "description", header: "الوصف" },
                    { key: "amount", header: "المبلغ", map: (r) => Number(r.amount ?? 0) },
                    { key: "paymentMethod", header: "الدفع", map: (r) => METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod },
                    { key: "status", header: "الحالة", map: (r) => (r.status === "REVERSED" ? "مُلغى" : "مكتمل") },
                  ],
                })
              }
            >
              تصدير Excel
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
                <th className="p-2">الوصف</th>
                <th className="p-2 text-right">المبلغ</th>
                <th className="p-2 text-center">الدفع</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr><td colSpan={9}><LoadingState /></td></tr>
              )}
              {list.isError && !list.isLoading && (
                <tr>
                  <td colSpan={9}>
                    <ErrorState message={list.error?.message} onRetry={() => void list.refetch()} />
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={Number(r.id)} className={`border-t ${r.status === "REVERSED" ? "opacity-60" : ""}`}>
                  <td className="p-2 font-mono text-xs"><CopyInline value={String(r.voucherNumber ?? "—")} /></td>
                  <td className="p-2 text-xs">{fmtDate(r.createdAt as any)}</td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.direction === "IN" ? "badge-status-active" : "badge-stock-out"}`}>
                      {TYPE_LABEL[r.direction]}
                    </span>
                  </td>
                  <td className="p-2 text-xs">{PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—"}</td>
                  <td className="p-2">{r.description ?? "—"}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.amount)}</td>
                  <td className="p-2 text-center text-xs">{METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.status === "REVERSED" ? "badge-status-cancelled" : "badge-status-active"}`}>
                      {r.status === "REVERSED" ? "مُلغى" : "مكتمل"}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <RowActions
                      mode="auto"
                      actions={[
                        { key: "print", label: "طباعة السند", onSelect: () => void printVoucher(r) },
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
              ))}
              {!list.isLoading && !list.isError && rows.length === 0 && (
                <TableEmptyRow colSpan={9} message="لا سندات مطابقة. أضِف سند قبض أو صرف جديداً." />
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
