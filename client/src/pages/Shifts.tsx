import { ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useClipboard } from "@/hooks/useClipboard";
import { formatZReportAsText } from "@/lib/copy/formatters";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printShiftClose } from "@/lib/printing/print";
import { trpc } from "@/lib/trpc";
import { Copy, Printer } from "lucide-react";
import { useMemo, useState } from "react";

/* ═══════════ سجلّ الورديات + إعادة طباعة Z-report ═══════════
   يستهلك shifts.list (branch-scoped): ورديات الكاشير مع فُتحت/أُغلقت/المتوقع/المعدود/الفرق.
   فلاتر فرع/حالة + ترقيم خادمي + تصدير Excel + زر إعادة طباعة تقرير الوردية (Z) عبر printShiftClose.
═══════════════════════════════════════════════════════════ */

const PAGE = 50;
const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_LABEL: Record<string, string> = { OPEN: "مفتوحة", CLOSED: "مغلقة" };
const STATUS_CLS: Record<string, string> = {
  OPEN: "badge-status-pending",
  CLOSED: "badge-status-active",
};

const fmtDT = (d: string | number | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" }) : "—";

export default function Shifts() {
  const [branchId, setBranchId] = useState<number | "">("");
  const [status, setStatus] = useState<"" | "OPEN" | "CLOSED">("");
  // فلتر الفترة خادمي (openedAt) — أسماء dateFrom/dateTo لتفادي تصادم from/to الترقيم أدناه.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [printing, setPrinting] = useState<number | null>(null);
  const [copying, setCopying] = useState<number | null>(null);
  const { copy } = useClipboard({ successMessage: "نُسِخ تقرير Z" });

  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const list = trpc.shifts.list.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    status: status || undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
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
    if (d.gt(0)) return "text-money-positive";
    if (d.lt(0)) return "text-money-negative";
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
      // اسم الكاشير واسم الفرع من صف الوردية المعروض
      const row = rows.find((r) => r.id === shiftId);
      const cashierName = row?.userName ?? `#${shiftId}`;
      const bName = branchName(row?.branchId);

      const payments = (rep.payments ?? []).map((p) => ({
        method:    p.method,
        direction: p.direction as "IN" | "OUT",
        count:     Number(p.count),
        total:     p.total,
      }));

      if (open) {
        // وردية مفتوحة: تقرير مبدئي بالتصميم الجديد (النقد المتوقع = الرصيد الافتتاحي مبدئياً)
        await printShiftClose({
          shiftId,
          openedAt:       sh.openedAt,
          closedAt:       new Date(),
          cashierName,
          branchName:     bName,
          openingBalance: sh.openingBalance,
          invoiceCount:   rep.invoiceCount,
          salesTotal:     rep.salesTotal,
          payments,
          expectedCash:   sh.expectedCash ?? sh.openingBalance,
          countedCash:    sh.countedCash  ?? "0",
          variance:       sh.variance     ?? "0",
        });
      } else {
        // وردية مغلقة: Z-Report نهائي
        await printShiftClose({
          shiftId,
          openedAt:       sh.openedAt,
          closedAt:       sh.closedAt ? new Date(sh.closedAt) : new Date(),
          cashierName,
          branchName:     bName,
          openingBalance: sh.openingBalance,
          invoiceCount:   rep.invoiceCount,
          salesTotal:     rep.salesTotal,
          payments,
          expectedCash:   sh.expectedCash ?? "0",
          countedCash:    sh.countedCash  ?? "0",
          variance:       sh.variance     ?? "0",
        });
      }
    } catch (e) {
      notify.err(e);
    } finally {
      setPrinting(null);
    }
  }

  // نَسخ مُلَخَّص Z نَصّياً (للَصق في واتساب/مُلاحَظة الإدارة) — يَجلب نَفس تَقرير الطباعة ويُمَرِّرُه إلى formatZReportAsText.
  async function copyZ(shiftId: number) {
    setCopying(shiftId);
    try {
      const rep = await utils.shifts.report.fetch({ shiftId });
      if (!rep) { notify.err("تعذّر جلب تقرير الوردية"); return; }
      const sh = rep.shift as {
        openingBalance: string; expectedCash: string | null; countedCash: string | null; variance: string | null;
        openedAt: string | Date; closedAt: string | Date | null;
      };
      // النَقد الداخل/الخارج = مَجموع الحَركات النَقدِية (CASH) حَسَب الاتجاه.
      let cashIn = D(0);
      let cashOut = D(0);
      for (const p of rep.payments ?? []) {
        if (p.method !== "CASH") continue;
        if (p.direction === "IN") cashIn = cashIn.plus(D(p.total));
        else if (p.direction === "OUT") cashOut = cashOut.plus(D(p.total));
      }
      const text = formatZReportAsText({
        shiftId,
        opened: sh.openedAt,
        closed: sh.closedAt ?? undefined,
        openingFloat: sh.openingBalance,
        cashIn: cashIn.toFixed(2),
        cashOut: cashOut.toFixed(2),
        expectedCash: sh.expectedCash ?? sh.openingBalance,
        countedCash: sh.countedCash,
        variance: sh.variance,
      });
      await copy(text);
    } catch (e) {
      notify.err(e);
    } finally {
      setCopying(null);
    }
  }

  const anyFilter = branchId !== "" || status !== "" || dateFrom !== "" || dateTo !== "";
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ الورديات"
        description="ورديات الكاشير (فتح/إغلاق الصندوق) مع النقد المتوقّع والمعدود والفرق. أعد طباعة تقرير نهاية الوردية (Z) لأي وردية مغلقة."
      />

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
                <Input type="date" dir="ltr" className="h-8 w-36" value={dateFrom} onChange={(e) => setFilter(setDateFrom, e.target.value)} title="من تاريخ" />
                <Input type="date" dir="ltr" className="h-8 w-36" value={dateTo} onChange={(e) => setFilter(setDateTo, e.target.value)} title="إلى تاريخ" />
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
              <tr>
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
                    {/* زر Z-report + نَسخ مُلَخَّص نَصّي (RowActions inline). */}
                    <RowActions
                      mode="inline"
                      actions={[
                        {
                          key: "zreport",
                          label: printing === r.id ? "جارٍ…" : "Z-report",
                          icon: Printer,
                          disabled: printing === r.id,
                          onSelect: () => void reprintZ(r.id),
                        },
                        {
                          key: "copy",
                          label: copying === r.id ? "جارٍ…" : "نسخ",
                          icon: Copy,
                          disabled: copying === r.id,
                          onSelect: () => void copyZ(r.id),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <TableEmptyRow
                  colSpan={11}
                  message={total === 0 && !anyFilter ? "لا ورديات بعد. تُفتح الورديات من نقطة البيع." : "لا ورديات مطابقة. غيّر الفلتر."}
                />
              )}
              {list.isLoading && (
                <tr><td colSpan={11}><LoadingState /></td></tr>
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
