import { ListToolbar } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printDoc } from "@/lib/printing/print";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

/* ═══════════ سجلّ الورديات + إعادة طباعة Z-report ═══════════
   يستهلك shifts.list (branch-scoped): ورديات الكاشير مع فُتحت/أُغلقت/المتوقع/المعدود/الفرق.
   فلاتر فرع/حالة + ترقيم خادمي + تصدير Excel + زر إعادة طباعة تقرير الوردية (Z) عبر printDoc.
═══════════════════════════════════════════════════════════ */

const PAGE = 50;
const SHOP = "الرؤية العربية";
const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_LABEL: Record<string, string> = { OPEN: "مفتوحة", CLOSED: "مغلقة" };
const STATUS_CLS: Record<string, string> = {
  OPEN: "bg-blue-100 text-blue-700",
  CLOSED: "bg-emerald-100 text-emerald-700",
};
const METHOD_AR: Record<string, string> = { CASH: "نقد", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة" };

const fmtDT = (d: string | number | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" }) : "—";

export default function Shifts() {
  const [branchId, setBranchId] = useState<number | "">("");
  const [status, setStatus] = useState<"" | "OPEN" | "CLOSED">("");
  const [page, setPage] = useState(0);
  const [printing, setPrinting] = useState<number | null>(null);

  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const list = trpc.shifts.list.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    status: status || undefined,
    limit: PAGE,
    offset: page * PAGE,
  });

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  const branchName = useMemo(() => {
    const m = new Map((branches.data ?? []).map((b) => [Number(b.id), b.name]));
    return (id: number | null | undefined) => (id != null ? m.get(Number(id)) ?? `#${id}` : "—");
  }, [branches.data]);

  const setFilter = <T,>(fn: (v: T) => void, v: T) => { fn(v); setPage(0); };

  // الفرق: موجب = فائض (أخضر)، سالب = عجز (أحمر)، صفر/غير محسوب = محايد.
  const varianceCls = (v: string | null) => {
    if (v == null) return "text-muted-foreground";
    const d = D(v);
    if (d.gt(0)) return "text-emerald-600";
    if (d.lt(0)) return "text-destructive";
    return "text-foreground";
  };

  async function reprintZ(shiftId: number) {
    setPrinting(shiftId);
    try {
      const rep = await utils.shifts.report.fetch({ shiftId });
      if (!rep) { notify.err("تعذّر جلب تقرير الوردية"); return; }
      const sh = rep.shift as {
        openingBalance: string; expectedCash: string | null; countedCash: string | null; variance: string | null;
        status: string; openedAt: string | Date; closedAt: string | Date | null;
      };
      const open = sh.status === "OPEN";
      const payRows: string[][] = (rep.payments ?? []).map((p) => [
        `${METHOD_AR[p.method] ?? p.method} ${p.direction === "IN" ? "وارد" : "صادر"}`,
        String(p.count),
        fmt(p.total),
      ]);
      await printDoc({
        kind: "zreport",
        title: SHOP,
        subtitle: open ? "تقرير وردية مفتوحة (X) — مبدئي" : "تقرير نهاية الوردية (Z) — نسخة",
        meta: [
          `وردية #${shiftId}`,
          open ? `فُتحت: ${fmtDT(sh.openedAt)}` : `أُغلقت: ${fmtDT(sh.closedAt)}`,
          `طُبعت: ${new Date().toLocaleString("ar-IQ-u-nu-latn")}`,
        ],
        columns: ["الحركة", "عدد", "مبلغ"],
        rows: payRows.length ? payRows : [["لا حركات", "0", "0.00"]],
        totals: [
          { label: "عدد الفواتير", value: String(rep.invoiceCount) },
          { label: "إجمالي المبيعات", value: fmt(rep.salesTotal) },
          { label: "الرصيد الافتتاحي", value: fmt(sh.openingBalance) },
          ...(sh.expectedCash != null ? [{ label: "النقد المتوقع", value: fmt(sh.expectedCash) }] : []),
          ...(sh.countedCash != null ? [{ label: "النقد المعدود", value: fmt(sh.countedCash) }] : []),
          ...(sh.variance != null ? [{ label: "الفرق", value: fmt(sh.variance) }] : []),
        ],
        footer: open ? "تقرير مبدئي — الوردية لم تُغلق بعد" : "نهاية الوردية — شكراً",
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setPrinting(null);
    }
  }

  const anyFilter = branchId !== "" || status !== "";
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">سجلّ الورديات</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        ورديات الكاشير (فتح/إغلاق الصندوق) مع النقد المتوقّع والمعدود والفرق. أعد طباعة تقرير نهاية الوردية (Z) لأي وردية مغلقة.
      </p>

      <Card>
        <CardHeader>
          <ListToolbar
            title="الورديات"
            count={total}
            loading={list.isLoading}
            filters={
              <>
                <select className={selectCls} value={status} onChange={(e) => setFilter(setStatus, e.target.value as "" | "OPEN" | "CLOSED")}>
                  <option value="">— كل الحالات —</option>
                  <option value="OPEN">مفتوحة</option>
                  <option value="CLOSED">مغلقة</option>
                </select>
                <select className={selectCls} value={branchId} onChange={(e) => setFilter(setBranchId, e.target.value ? Number(e.target.value) : "")}>
                  <option value="">— كل الفروع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </>
            }
            exportSpec={{
              filename: "سجلّ-الورديات",
              rows,
              columns: [
                { key: "id", header: "رقم الوردية" },
                { key: "userName", header: "الموظف", map: (r) => r.userName ?? `#${r.userId}` },
                { key: "branch", header: "الفرع", map: (r) => branchName(r.branchId) },
                { key: "openedAt", header: "فُتحت", map: (r) => fmtDT(r.openedAt) },
                { key: "closedAt", header: "أُغلقت", map: (r) => fmtDT(r.closedAt) },
                { key: "openingBalance", header: "الافتتاحي", map: (r) => Number(r.openingBalance ?? 0) },
                { key: "expectedCash", header: "المتوقع", map: (r) => (r.expectedCash != null ? Number(r.expectedCash) : "") },
                { key: "countedCash", header: "المعدود", map: (r) => (r.countedCash != null ? Number(r.countedCash) : "") },
                { key: "variance", header: "الفرق", map: (r) => (r.variance != null ? Number(r.variance) : "") },
                { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">#</th>
                <th className="p-2">الموظف</th>
                <th className="p-2">الفرع</th>
                <th className="p-2">فُتحت</th>
                <th className="p-2">أُغلقت</th>
                <th className="p-2 text-left">الافتتاحي</th>
                <th className="p-2 text-left">المتوقع</th>
                <th className="p-2 text-left">المعدود</th>
                <th className="p-2 text-left">الفرق</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 tabular-nums" dir="ltr">{r.id}</td>
                  <td className="p-2 font-medium">{r.userName ?? `#${r.userId}`}</td>
                  <td className="p-2">{branchName(r.branchId)}</td>
                  <td className="p-2 text-xs" dir="ltr">{fmtDT(r.openedAt)}</td>
                  <td className="p-2 text-xs" dir="ltr">{fmtDT(r.closedAt)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.openingBalance)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{r.expectedCash != null ? fmt(r.expectedCash) : "—"}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{r.countedCash != null ? fmt(r.countedCash) : "—"}</td>
                  <td className={`p-2 text-left font-semibold tabular-nums ${varianceCls(r.variance)}`} dir="ltr">
                    {r.variance != null ? fmt(r.variance) : "—"}
                  </td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <Button variant="outline" size="sm" disabled={printing === r.id} onClick={() => reprintZ(r.id)}>
                      {printing === r.id ? "جارٍ…" : "🖨️ Z-report"}
                    </Button>
                  </td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="p-6 text-center text-muted-foreground">
                    {total === 0 && !anyFilter ? "لا ورديات بعد. تُفتح الورديات من نقطة البيع." : "لا ورديات مطابقة. غيّر الفلتر."}
                  </td>
                </tr>
              )}
              {list.isLoading && (
                <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">جارٍ التحميل…</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground" dir="ltr">
          {total === 0 ? "لا صفوف" : `${from}–${to} / ${total.toLocaleString("ar-IQ-u-nu-latn")}`}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>السابق</Button>
          <Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>التالي</Button>
        </div>
      </div>
    </div>
  );
}
