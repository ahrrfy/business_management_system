import { CopyButton, CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { exportRows } from "@/lib/export";
import { Label } from "@/components/ui/label";
import { printAPAging } from "@/lib/printing/printTemplates";
import { D, fmt as fmtMoney, fmtAr } from "@/lib/money";
import { sanitizeForWhatsApp } from "@/lib/whatsapp";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useRowSelection, SelectionBar } from "@/components/list/SelectionBar";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const fmt = (s: string | number) => fmtMoney(s);

export default function APAging() {
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const aging = trpc.reports.apAging.useQuery({ branchId: branchId ? Number(branchId) : undefined });
  const sel = useRowSelection<number>();

  // عقد import-integration §٦: «رصيد غير مفوتر/افتتاحي» = الرصيد الجاري − غير المدفوع،
  // يُحسب في العميل بـDecimal (لا parseFloat) — يفسّر فجوة المستورَد برصيد افتتاحي بلا أوامر شراء.
  const unbilledOf = (r: { currentBalance: string | null; unpaidTotal: string | null }) =>
    D(r.currentBalance || 0).minus(D(r.unpaidTotal || 0));

  // §٥: نجمع بدقّة Decimal، لا Number() (يتراكم انجراف على كثرة الصفوف). نُخرج نصوصاً 2dp.
  const totals = useMemo(() => {
    const rows = aging.data ?? [];
    const acc = rows.reduce(
      (a, r) => ({
        d0_30: a.d0_30.plus(D(r.d0_30 || 0)),
        d31_60: a.d31_60.plus(D(r.d31_60 || 0)),
        d61_90: a.d61_90.plus(D(r.d61_90 || 0)),
        d91p: a.d91p.plus(D(r.d91p || 0)),
        unpaidTotal: a.unpaidTotal.plus(D(r.unpaidTotal || 0)),
        currentBalance: a.currentBalance.plus(D(r.currentBalance || 0)),
      }),
      { d0_30: D(0), d31_60: D(0), d61_90: D(0), d91p: D(0), unpaidTotal: D(0), currentBalance: D(0) }
    );
    return {
      d0_30: acc.d0_30.toFixed(2),
      d31_60: acc.d31_60.toFixed(2),
      d61_90: acc.d61_90.toFixed(2),
      d91p: acc.d91p.toFixed(2),
      unpaidTotal: acc.unpaidTotal.toFixed(2),
      currentBalance: acc.currentBalance.toFixed(2),
      unbilled: acc.currentBalance.minus(acc.unpaidTotal).toFixed(2),
    };
  }, [aging.data]);

  // الصُفوف المُحدَّدة فَقَط — لِلتَصدير الجُزئي ولِنَسخ ملَخَّص واتساب.
  const selectedRows = useMemo(
    () => (aging.data ?? []).filter((r) => sel.isSelected(r.supplierId)),
    [aging.data, sel],
  );

  // ملَخَّص واتساب لِالذِمم المُحدَّدة (مَبلَغ غَير المَدفوع + أَقدَم أَمر شِراء + الهاتِف).
  // يَنبَني عَبر sanitizeForWhatsApp ⇒ بِلا إيموجي.
  const whatsappSummary = useMemo(() => {
    if (selectedRows.length === 0) return "";
    const L: string[] = [];
    L.push("*ذِمم مُستَحَقّة — لَكُم عَلَينا*");
    L.push(`التاريخ: ${new Date().toLocaleDateString("en-GB")}`);
    L.push("المَكتَبة العَرَبية لِلطِباعة والقِرطاسية");
    L.push("————————————————");
    let grand = D(0);
    for (const r of selectedRows) {
      const unpaid = D(r.unpaidTotal || 0);
      grand = grand.plus(unpaid);
      const phone = r.phone ? ` — ${r.phone}` : "";
      const oldest = r.oldestPoDate ? ` — أَقدَم أَمر ${r.oldestPoDate}` : "";
      L.push(`- ${r.supplierName}${phone}: ${fmtAr(unpaid.toFixed(2))} د.ع${oldest}`);
    }
    L.push("————————————————");
    L.push(`*الإجمالي المُستَحَقّ: ${fmtAr(grand.toFixed(2))} د.ع*`);
    L.push("");
    L.push("سَنُحاوِل تَرتيب السَداد في أَقرَب وَقت — لِأَي استِفسار تَواصَلوا مَعَنا.");
    return sanitizeForWhatsApp(L.join("\n"));
  }, [selectedRows]);

  const onExportSelected = () => {
    if (selectedRows.length === 0) return;
    exportRows(selectedRows, {
      filename: "ذمم-دائنة-محددة",
      columns: [
        { key: "supplierName", header: "المورد" },
        { key: "phone", header: "الهاتف" },
        { key: "d0_30", header: "0–30", map: (r) => Number(r.d0_30) },
        { key: "d31_60", header: "31–60", map: (r) => Number(r.d31_60) },
        { key: "d61_90", header: "61–90", map: (r) => Number(r.d61_90) },
        { key: "d91p", header: "+90", map: (r) => Number(r.d91p) },
        { key: "unpaidTotal", header: "إجمالي غير المدفوع", map: (r) => Number(r.unpaidTotal) },
        { key: "unbilled", header: "غير مفوتر/افتتاحي", map: (r) => unbilledOf(r).toNumber() },
        { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance) },
        { key: "oldestPoDate", header: "أقدم أمر شراء" },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="أعمار الذمم الدائنة — لهم علينا"
        description="المبالغ المستحقّة لهم علينا (للموردين)، مُجمَّعة في أربع شرائح عمرية. كلما طال العمر كلما استوجب الأولويّة. المسوّدات والملغاة مستثناة."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!aging.data?.length}
              onClick={() =>
                exportRows(aging.data ?? [], {
                  filename: "ذمم-دائنة",
                  columns: [
                    { key: "supplierName", header: "المورد" },
                    { key: "phone", header: "الهاتف" },
                    { key: "d0_30", header: "0–30", map: (r) => Number(r.d0_30) },
                    { key: "d31_60", header: "31–60", map: (r) => Number(r.d31_60) },
                    { key: "d61_90", header: "61–90", map: (r) => Number(r.d61_90) },
                    { key: "d91p", header: "+90", map: (r) => Number(r.d91p) },
                    { key: "unpaidTotal", header: "إجمالي غير المدفوع", map: (r) => Number(r.unpaidTotal) },
                    { key: "unbilled", header: "غير مفوتر/افتتاحي", map: (r) => unbilledOf(r).toNumber() },
                    { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance) },
                    { key: "oldestPoDate", header: "أقدم أمر شراء" },
                  ],
                })
              }
            >
              تصدير Excel
            </Button>
            <Button variant="outline" size="sm" disabled={!aging.data?.length} onClick={() => printAPAging({
              date: new Date().toLocaleDateString('en-GB'),
              rows: (aging.data ?? []).map(r => ({
                name: r.supplierName,
                d0_30: D(r.d0_30||0).toNumber(), d31_60: D(r.d31_60||0).toNumber(),
                d61_90: D(r.d61_90||0).toNumber(), d91p: D(r.d91p||0).toNumber(),
                unpaidTotal: D(r.unpaidTotal||0).toNumber(), currentBalance: D(r.currentBalance||0).toNumber(),
              })),
              totals: {
                d0_30: D(totals.d0_30).toNumber(), d31_60: D(totals.d31_60).toNumber(),
                d61_90: D(totals.d61_90).toNumber(), d91p: D(totals.d91p).toNumber(),
                unpaidTotal: D(totals.unpaidTotal).toNumber(), currentBalance: D(totals.currentBalance).toNumber(),
              },
            })}>طباعة PDF</Button>
            <Link href="/suppliers-statement"><Button variant="outline">كشف حساب مورد</Button></Link>
          </div>
        }
      />

      <Card>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-6">
          <div className="space-y-1">
            <Label className="text-xs">الفرع</Label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— كل الفروع —</option>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
          <Bucket label="0–30 يوم" value={totals.d0_30} color="bg-emerald-50 text-emerald-700" />
          <Bucket label="31–60 يوم" value={totals.d31_60} color="bg-amber-50 text-amber-700" />
          <Bucket label="61–90 يوم" value={totals.d61_90} color="bg-orange-50 text-orange-700" />
          <Bucket label="أكثر من 90" value={totals.d91p} color="bg-rose-50 text-rose-700" />
          <Bucket label="إجمالي غير المدفوع" value={totals.unpaidTotal} color="bg-muted" emphasis />
          <Bucket label="غير مفوتر/افتتاحي" value={totals.unbilled} color="bg-[var(--sem-info-bg)] text-[var(--sem-info)]" />
          <Bucket label="إجمالي ما لهم علينا" value={totals.currentBalance} color="bg-rose-50 text-rose-800" emphasis />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 w-8 text-center">
                  <input
                    type="checkbox"
                    aria-label="تحديد كل الذمم"
                    checked={(aging.data ?? []).length > 0 && (aging.data ?? []).every((r) => sel.isSelected(r.supplierId))}
                    onChange={(e) => sel.setMany((aging.data ?? []).map((r) => r.supplierId), e.target.checked)}
                  />
                </th>
                <th className="p-2">المورد</th>
                <th className="p-2">الهاتف</th>
                <th className="p-2 text-right">0–30</th>
                <th className="p-2 text-right">31–60</th>
                <th className="p-2 text-right">61–90</th>
                <th className="p-2 text-right">+90</th>
                <th className="p-2 text-right">إجمالي غير المدفوع</th>
                <th className="p-2 text-right" title="الرصيد الجاري ناقص غير المدفوع — يشمل الرصيد الافتتاحي المستورد من النظام القديم">غير مفوتر/افتتاحي</th>
                <th className="p-2 text-right">الرصيد (له علينا)</th>
                <th className="p-2">أقدم أمر شراء</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(aging.data ?? []).map((r) => (
                <tr key={r.supplierId} className="border-t">
                  <td className="p-2 text-center">
                    <input
                      type="checkbox"
                      aria-label={`تحديد ${r.supplierName}`}
                      checked={sel.isSelected(r.supplierId)}
                      onChange={() => sel.toggle(r.supplierId)}
                    />
                  </td>
                  <td className="p-2 font-medium">{r.supplierName}</td>
                  <td className="p-2"><CopyInline value={r.phone} /></td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d0_30)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d31_60)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d61_90)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d91p)}</td>
                  <td className="p-2 text-right tabular-nums font-semibold" dir="ltr">{fmt(r.unpaidTotal)}</td>
                  <td className="p-2 text-right tabular-nums text-[var(--sem-info)]" dir="ltr">{fmt(unbilledOf(r).toFixed(2))}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.currentBalance)}</td>
                  <td className="p-2 text-xs" dir="ltr">{r.oldestPoDate ?? "—"}</td>
                  <td className="p-2 text-center">
                    <Link href={`/suppliers-statement?id=${r.supplierId}`}>
                      <Button variant="outline" size="sm">كشف الحساب</Button>
                    </Link>
                  </td>
                </tr>
              ))}
              {aging.data && aging.data.length === 0 && (
                <TableEmptyRow colSpan={12} message="لا ذمم دائنة مستحقّة." />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {sel.count > 0 && (
        <div className="sticky bottom-3 z-20 mx-auto flex w-fit items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur">
          <CopyButton
            value={whatsappSummary}
            title="نَسخ المُحَدَّد كَـ WhatsApp summary"
            size="sm"
            variant="outline"
            successMessage="تَم نَسخ المُلَخَّص"
            className="gap-1"
          />
          <span className="text-xs text-muted-foreground">ملَخَّص واتساب</span>
        </div>
      )}

      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={onExportSelected}
        exportLabel="تصدير المحدَّد Excel"
      />
    </div>
  );
}

function Bucket({ label, value, color, emphasis }: { label: string; value: string; color: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-md p-3 ${color}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-xl font-bold" : "text-lg font-semibold"}`} dir="ltr">{fmt(value)}</div>
    </div>
  );
}
