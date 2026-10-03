// تبويب «مطابقة الأرصدة» — مقارنة رصيدنا الدفتري (حتى تاريخ قطع) برصيد كشف الصيرفة + البنود المعلّقة.
// قراءة فقط: أي فرق حقيقي يُسوّى لاحقاً بقيد تصحيح يدوي صريح (لا تسوية صامتة).
import { useCallback, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Scale as ScaleIcon, CheckCircle2, AlertTriangle, FileSpreadsheet, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmtAr } from "@/lib/money";
import { isSignedMoneyStr, selectCls, type ExchangeRow } from "@/components/exchange/shared";
import { exportSheets, type SheetSpec } from "@/lib/export";
import { printExchangeReconcileDoc } from "@/lib/printing/printExchangeStatement";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";

const TYPE_AR: Record<string, string> = {
  DEPOSIT: "إيداع", WITHDRAW: "سحب", FX_BUY: "شراء دولار", SETTLE: "تسديد مورد", OPENING: "رصيد افتتاحي",
};

type Params = { exchangeHouseId: number; statedBalanceIqd: string; statedBalanceUsd: string; asOfDate?: string };

/** صفُّ بندٍ معلّق كما يصله من العقد (قيمٌ نصّية) — نفس الشكل الذي كان يُصيَّر خامّاً. */
type PendingRow = Record<string, string>;

/** الصفر يُعرض شرطةً لا «0»: البند إمّا بالدينار أو بالدولار، وصفرُ العملة الأخرى ليس مبلغاً. */
const dash = (v: string) => (D(v).isZero() ? "—" : fmtAr(v));

const pendingColumns: ColumnDef<PendingRow, unknown>[] = [
  { id: "txnNumber", header: "الرقم", accessorFn: (p) => p.txnNumber, meta: { kind: "code" }, cell: ({ row }) => row.original.txnNumber },
  // التسمية العربية لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
  { id: "type", header: "النوع", accessorFn: (p) => TYPE_AR[p.type] ?? p.type, cell: ({ row }) => TYPE_AR[row.original.type] ?? row.original.type },
  { id: "iqdAmount", header: "دينار", accessorFn: (p) => dash(p.iqdAmount), meta: { kind: "money" }, cell: ({ row }) => dash(row.original.iqdAmount) },
  { id: "usdAmount", header: "دولار", accessorFn: (p) => dash(p.usdAmount), meta: { kind: "money" }, cell: ({ row }) => dash(row.original.usdAmount) },
  {
    id: "createdAt",
    header: "التاريخ",
    accessorFn: (p) => fmtDateTime(p.createdAt),
    meta: { kind: "datetime" },
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span>,
  },
];

export default function ExchangeReconcile() {
  const me = trpc.auth.me.useQuery();
  const houses = trpc.exchange.list.useQuery({ limit: 200, offset: 0 });
  const [houseId, setHouseId] = useState(0);
  const [statedIqd, setStatedIqd] = useState("");
  const [statedUsd, setStatedUsd] = useState("");
  const [asOf, setAsOf] = useState("");
  const [params, setParams] = useState<Params | null>(null);

  const houseRows = (houses.data ?? []) as ExchangeRow[];
  const rec = trpc.exchange.reconcile.useQuery(params!, { enabled: !!params });

  const run = () => {
    if (!houseId) { notify.err("اختر صيرفة"); return; }
    if (!isSignedMoneyStr(statedIqd || "0") || !isSignedMoneyStr(statedUsd || "0")) { notify.err("أدخل أرصدة صحيحة (يُقبل السالب حين نَدين للصيرفة)"); return; }
    setParams({
      exchangeHouseId: houseId,
      statedBalanceIqd: statedIqd || "0",
      statedBalanceUsd: statedUsd || "0",
      asOfDate: asOf || undefined,
    });
  };

  const r = rec.data;
  const house = houseRows.find((h) => h.id === houseId);

  const printReconcileDoc = useCallback(() => {
    if (!r || !house) return;
    if (!reservePrintWindow()) {
      notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
      return;
    }
    const ok = printExchangeReconcileDoc({
      houseName: house.name,
      asOfDate: asOf || undefined,
      ourBalanceIqd: r.ourBalanceIqd,
      statedBalanceIqd: r.statedBalanceIqd,
      diffIqd: r.diffIqd,
      ourBalanceUsd: r.ourBalanceUsd,
      statedBalanceUsd: r.statedBalanceUsd,
      diffUsd: r.diffUsd,
      matched: r.matched,
      pending: (r.pending as PendingRow[]).map((p) => ({
        txnNumber: p.txnNumber,
        typeLabel: TYPE_AR[p.type] ?? p.type,
        iqdAmount: p.iqdAmount,
        usdAmount: p.usdAmount,
        createdAt: fmtDateTime(p.createdAt),
      })),
      printedByName: me.data?.name || "المحاسب",
      printRequestedAt: fmtDateTime(new Date()),
    });
    if (!ok) {
      releaseReservedPrintWindow();
      notify.err("تعذّر فتح نافذة الطباعة — تأكّد من السماح بالنوافذ المنبثقة.");
    }
  }, [r, house, asOf, me.data?.name]);

  const exportReconcileExcel = useCallback(() => {
    if (!r || !house) return;
    const sheets: SheetSpec[] = [];

    const summaryRows = [
      {
        item: "حساب الدينار العراقي (IQD)",
        our: Number(r.ourBalanceIqd),
        stated: Number(r.statedBalanceIqd),
        diff: Number(r.diffIqd),
        status: D(r.diffIqd).isZero() ? "مطابق" : "غير مطابق",
      },
      {
        item: "حساب الدولار الأمريكي (USD)",
        our: Number(r.ourBalanceUsd),
        stated: Number(r.statedBalanceUsd),
        diff: Number(r.diffUsd),
        status: D(r.diffUsd).isZero() ? "مطابق" : "غير مطابق",
      },
    ];
    sheets.push({
      sheetName: "مقارنة الأرصدة",
      title: `محضر مطابقة رصيد صيرفة — ${house.name}`,
      columns: [
        { key: "item", header: "البيان والعملة" },
        { key: "our", header: "رصيدنا الدفتري", money: true },
        { key: "stated", header: "رصيد كشف الصيرفة", money: true },
        { key: "diff", header: "فارق المطابقة", money: true },
        { key: "status", header: "الحالة" },
      ],
      rows: summaryRows,
    });

    const pendingList = (r.pending as PendingRow[]).map((p) => ({
      txnNumber: p.txnNumber,
      type: TYPE_AR[p.type] ?? p.type,
      iqdAmount: Number(p.iqdAmount || 0),
      usdAmount: Number(p.usdAmount || 0),
      createdAt: fmtDateTime(p.createdAt),
    }));
    sheets.push({
      sheetName: "البنود المعلقة",
      title: `البنود المعلقة بعد تاريخ القطع — ${house.name}`,
      columns: [
        { key: "txnNumber", header: "رقم الحركة" },
        { key: "type", header: "نوع العملية" },
        { key: "iqdAmount", header: "دينار (د.ع)", money: true },
        { key: "usdAmount", header: "دولار ($)", money: true },
        { key: "createdAt", header: "تاريخ العملية" },
      ],
      rows: pendingList,
      totalsRow: {
        txnNumber: "الإجمالي",
        iqdAmount: pendingList.reduce((acc, p) => acc + p.iqdAmount, 0),
        usdAmount: pendingList.reduce((acc, p) => acc + p.usdAmount, 0),
      },
    });

    exportSheets(`محضر-مطابقة-صيرفة-${house.name}`, sheets);
  }, [r, house]);

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<ScaleIcon className="h-5 w-5 text-primary" />}
        title="مطابقة أرصدة الصيرفة"
        description="قارن رصيدك الدفتري برصيد كشف الصيرفة لديهم، واكشف البنود المعلّقة (فروق التوقيت)."
        actions={
          r ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={printReconcileDoc}
              >
                <Printer className="size-4" aria-hidden />
                طباعة / PDF المحضر
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={exportReconcileExcel}
              >
                <FileSpreadsheet className="size-4" aria-hidden />
                تصدير Excel
              </Button>
            </div>
          ) : null
        }
      />

      <Card className="p-4 space-y-3">
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الصيرفة</label>
            <AppSelect className={`${selectCls} w-full`} value={String(houseId)} onValueChange={(value) => setHouseId(Number(value))}>
              <option value={0}>— اختر —</option>
              {houseRows.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </AppSelect>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">رصيد كشفهم (دينار)</label>
            <MoneyInput value={statedIqd} onChange={setStatedIqd} allowNegative placeholder="0.00" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">رصيد كشفهم (دولار)</label>
            <MoneyInput value={statedUsd} onChange={setStatedUsd} allowNegative placeholder="0.00" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">حتى تاريخ (اختياري)</label>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-9" dir="ltr" />
          </div>
        </div>
        <Button onClick={run} disabled={rec.isFetching} className="gap-1.5">
          <ScaleIcon className="h-4 w-4" />{rec.isFetching ? "جارٍ…" : "تحقّق من المطابقة"}
        </Button>
      </Card>

      {r && (
        <>
          <Card className={`p-4 ${r.matched ? "border-money-positive/40" : "border-money-negative/40"}`}>
            <div className="text-sm font-semibold mb-3 flex items-center gap-1.5">
              {r.matched ? (
                <><CheckCircle2 className="h-4 w-4 text-money-positive" /> الأرصدة مطابقة</>
              ) : (
                <><AlertTriangle className="h-4 w-4 text-money-negative" /> يوجد فرق — راجِع البنود المعلّقة أدناه قبل أي تسوية</>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard label="رصيدنا (دينار)" value={fmtAr(r.ourBalanceIqd)} />
              <StatCard label="رصيدهم (دينار)" value={fmtAr(r.statedBalanceIqd)} />
              <StatCard label="الفرق (دينار)" value={fmtAr(r.diffIqd)} tone={D(r.diffIqd).isZero() ? "default" : "negative"} />
              <StatCard label="رصيدنا (دولار)" value={fmtAr(r.ourBalanceUsd)} />
              <StatCard label="رصيدهم (دولار)" value={fmtAr(r.statedBalanceUsd)} />
              <StatCard label="الفرق (دولار)" value={fmtAr(r.diffUsd)} tone={D(r.diffUsd).isZero() ? "default" : "negative"} />
            </div>
          </Card>

          {r.pending.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-semibold mb-2">بنود معلّقة بعد تاريخ القطع ({r.pending.length}) — تفسّر فروق التوقيت</div>
              {/* مُضمَّن: البطاقة تحمل العنوان والعدّ أصلاً، فشريطُ الحالة ومنتقي الأعمدة ضجيجٌ هنا. */}
              <DataTable<PendingRow>
                embedded
                searchable={false}
                bounded={false}
                pageSize={Infinity}
                data={r.pending as PendingRow[]}
                columns={pendingColumns}
                emptyText="لا بنود معلّقة."
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
