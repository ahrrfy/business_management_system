import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyInline } from "@/components/CopyButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { exportRows } from "@/lib/export";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

/** سجلّ السندات المستقلّة (قبض + صرف) مع فلاتر وتصدير. */
const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const TYPE_LABEL: Record<string, string> = { IN: "قبض", OUT: "صرف" };
const PARTY_LABEL: Record<string, string> = { CUSTOMER: "عميل", SUPPLIER: "مورّد", OTHER: "أخرى" };
const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "شيك", TRANSFER: "تحويل", WALLET: "محفظة",
};

function fmt(s: string | number | null | undefined): string {
  if (s == null || s === "") return "—";
  return Number(s).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("ar-IQ-u-nu-latn");
}

export default function Vouchers() {
  const [voucherType, setVoucherType] = useState<"" | "RECEIPT" | "PAYMENT">("");
  const [partyType, setPartyType] = useState<"" | "CUSTOMER" | "SUPPLIER" | "OTHER">("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const limit = 100;

  const input = useMemo(
    () => ({
      voucherType: voucherType || undefined,
      partyType: partyType || undefined,
      limit,
      offset: page * limit,
    }),
    [voucherType, partyType, page],
  );
  const list = trpc.vouchers.list.useQuery(input);
  const all = list.data ?? [];

  // فلتر بحث محلّي (وصف/رقم السند).
  const rows = useMemo(() => {
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all.filter((r) =>
      String(r.voucherNumber ?? "").toLowerCase().includes(needle) ||
      String(r.description ?? "").toLowerCase().includes(needle),
    );
  }, [all, q]);

  const totals = useMemo(() => {
    let inn = 0;
    let out = 0;
    for (const r of rows) {
      const amt = Number(r.amount ?? 0);
      if (r.direction === "IN") inn += amt;
      else out += amt;
    }
    return { inn, out, net: inn - out };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">سندات القبض والصرف</h1>
          <p className="text-sm text-muted-foreground">
            سندات مستقلّة بلا فاتورة — رواتب، إيجارات، إيرادات متفرّقة، دفعات لعميل/مورّد بلا ربط بفاتورة محدّدة.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/vouchers/receipt/new">
            <Button className="bg-emerald-600 hover:bg-emerald-700">+ سند قبض</Button>
          </Link>
          <Link href="/vouchers/payment/new">
            <Button className="bg-rose-600 hover:bg-rose-700">+ سند صرف</Button>
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">فلاتر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
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
            <Label>بحث (رقم/وصف)</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="مثال: راتب، RV-1-…" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي القبض</div>
            <div className="text-xl font-bold text-emerald-700 tabular-nums" dir="ltr">{fmt(totals.inn)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">إجمالي الصرف</div>
            <div className="text-xl font-bold text-rose-700 tabular-nums" dir="ltr">{fmt(totals.out)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">الصافي</div>
            <div className={`text-xl font-bold tabular-nums ${totals.net >= 0 ? "text-emerald-700" : "text-rose-700"}`} dir="ltr">
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
              {list.isLoading ? "جارٍ التحميل…" : `${rows.length.toLocaleString("ar-IQ-u-nu-latn")} سند`}
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
                  ],
                })
              }
            >
              تصدير Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">رقم السند</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2 text-center">النوع</th>
                <th className="p-2">الطرف</th>
                <th className="p-2">الوصف</th>
                <th className="p-2 text-left">المبلغ</th>
                <th className="p-2 text-center">الدفع</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={Number(r.id)} className="border-t">
                  <td className="p-2 font-mono text-xs"><CopyInline value={String(r.voucherNumber ?? "—")} /></td>
                  <td className="p-2 text-xs">{fmtDate(r.createdAt as any)}</td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.direction === "IN" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {TYPE_LABEL[r.direction]}
                    </span>
                  </td>
                  <td className="p-2 text-xs">{PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—"}</td>
                  <td className="p-2">{r.description ?? "—"}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.amount)}</td>
                  <td className="p-2 text-center text-xs">{METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا سندات مطابقة. أضِف سند قبض أو صرف جديداً.</td></tr>
              )}
            </tbody>
          </table>
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
