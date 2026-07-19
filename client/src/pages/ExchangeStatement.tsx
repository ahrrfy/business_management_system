// تبويب «كشف الحساب» — حركات الصيرفة بعملتيها + رصيد جارٍ (لقطة بعد كل عملية) + ملخّص.
import { useCallback, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { FileText, Undo2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { trpc } from "@/lib/trpc";
import { D, fmtAr } from "@/lib/money";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { selectCls, type ExchangeRow } from "@/components/exchange/shared";

const TYPE_AR: Record<string, string> = {
  DEPOSIT: "إيداع",
  WITHDRAW: "سحب",
  FX_BUY: "شراء دولار",
  SETTLE: "تسديد مورد",
  OPENING: "رصيد افتتاحي",
};

type TxnRow = {
  id: number;
  txnNumber: string;
  type: string;
  currency: string;
  iqdAmount: string;
  usdAmount: string;
  fxDiff: string;
  commissionIqd: string;
  balanceIqdAfter: string;
  balanceUsdAfter: string;
  status: string;
  createdAt: string;
};

const fmtDT = (d: string) => new Date(d).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" });

export default function ExchangeStatement() {
  const houses = trpc.exchange.list.useQuery({ limit: 200, offset: 0 });
  const [houseId, setHouseId] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const houseRows = (houses.data ?? []) as ExchangeRow[];
  const st = trpc.exchange.statement.useQuery(
    { exchangeHouseId: houseId, from: from || undefined, to: to || undefined },
    { enabled: houseId > 0 },
  );

  // عكس عملية صيرفة خاطئة (فصل مهام خادميّ: مُنشئ ≠ مُنفِّذ). يُعيد الأرصدة وWAVG وذمّة المورد،
  // ويستثني العملية من إجماليات الكشف. تأكيدٌ صريح لأنه إجراءٌ ماليّ لا يُتراجَع عنه.
  const utils = trpc.useUtils();
  const reverseMut = trpc.exchange.reverse.useMutation({
    onSuccess: (r) => {
      void utils.exchange.statement.invalidate();
      void utils.exchange.list.invalidate();
      notify.ok(`عُكِست العملية ${r.txnNumber}`);
    },
    onError: (e) => notify.err(e.message),
  });
  const doReverse = useCallback(
    async (txnId: number, txnNumber: string) => {
      const ok = await confirm({
        variant: "danger",
        title: "عكس عملية صيرفة",
        description: `ستُعكَس العملية ${txnNumber}: تُعاد أرصدة المحفظة وذمّة المورد (إن وُجدت) والنقد، وتُستثنى من إجماليات الكشف. لا يمكن التراجع، ويلزم منفِّذٌ غير مُنشئ العملية (فصل المهام).`,
        confirmText: "عكس العملية",
      });
      if (ok) reverseMut.mutate({ txnId });
    },
    [reverseMut],
  );

  const cols: ColumnDef<TxnRow>[] = useMemo(
    () => [
      { header: "التاريخ", accessorKey: "createdAt", cell: ({ row }) => <span dir="ltr" className="text-xs text-muted-foreground">{fmtDT(row.original.createdAt)}</span> },
      { header: "الرقم", accessorKey: "txnNumber", cell: ({ row }) => <span dir="ltr" className="text-xs">{row.original.txnNumber}</span> },
      { header: "النوع", accessorKey: "type", cell: ({ row }) => TYPE_AR[row.original.type] ?? row.original.type },
      { header: "دينار", accessorKey: "iqdAmount", cell: ({ row }) => <span dir="ltr" className="tabular-nums">{D(row.original.iqdAmount).isZero() ? "—" : fmtAr(row.original.iqdAmount)}</span> },
      { header: "دولار", accessorKey: "usdAmount", cell: ({ row }) => <span dir="ltr" className="tabular-nums">{D(row.original.usdAmount).isZero() ? "—" : fmtAr(row.original.usdAmount)}</span> },
      {
        header: "فرق الصرف", accessorKey: "fxDiff",
        cell: ({ row }) => {
          const v = D(row.original.fxDiff);
          if (v.isZero()) return <span className="text-muted-foreground">—</span>;
          return <span dir="ltr" className={v.isNegative() ? "text-money-negative tabular-nums" : "text-money-positive tabular-nums"}>{fmtAr(v.toFixed(2))}</span>;
        },
      },
      { header: "عمولة", accessorKey: "commissionIqd", cell: ({ row }) => <span dir="ltr" className="tabular-nums text-xs">{D(row.original.commissionIqd).isZero() ? "—" : fmtAr(row.original.commissionIqd)}</span> },
      { header: "رصيد دينار", accessorKey: "balanceIqdAfter", cell: ({ row }) => <span dir="ltr" className="tabular-nums text-xs font-medium">{fmtAr(row.original.balanceIqdAfter)}</span> },
      { header: "رصيد دولار", accessorKey: "balanceUsdAfter", cell: ({ row }) => <span dir="ltr" className="tabular-nums text-xs font-medium">{fmtAr(row.original.balanceUsdAfter)}</span> },
      {
        header: "إجراء", id: "action",
        cell: ({ row }) => {
          const t = row.original;
          if (t.status === "REVERSED") return <span className="text-xs text-money-negative">معكوسة</span>;
          if (t.type === "OPENING") return <span className="text-muted-foreground">—</span>;
          return (
            <button
              type="button"
              onClick={() => doReverse(t.id, t.txnNumber)}
              disabled={reverseMut.isPending}
              className="inline-flex items-center gap-1 text-xs text-money-negative hover:underline disabled:opacity-50"
            >
              <Undo2 aria-hidden className="size-3" /> عكس
            </button>
          );
        },
      },
    ],
    [doReverse, reverseMut.isPending],
  );

  const sum = st.data?.summary;

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<FileText className="h-5 w-5 text-primary" />}
        title="كشف حساب الصيرفة"
        description="كل حركات الصيرفة (إيداع/سحب/شراء/تسديد) مع رصيد جارٍ بعملتيه."
      />

      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الصيرفة</label>
            <select className={selectCls} value={houseId} onChange={(e) => setHouseId(Number(e.target.value))}>
              <option value={0}>— اختر —</option>
              {houseRows.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">من تاريخ</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" dir="ltr" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" dir="ltr" />
          </div>
        </div>
      </Card>

      {houseId > 0 && sum && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="الرصيد الحالي (دينار)" value={fmtAr(sum.currentBalanceIqd)} tone={D(sum.currentBalanceIqd).isNegative() ? "negative" : "positive"} />
          <StatCard label="الرصيد الحالي (دولار)" value={fmtAr(sum.currentBalanceUsd)} sub="$" tone={D(sum.currentBalanceUsd).isNegative() ? "negative" : "positive"} />
          <StatCard label="إجمالي الإيداعات (دينار)" value={fmtAr(sum.totalDepositIqd)} sub="د.ع" />
          <StatCard label="إجمالي الإيداعات (دولار)" value={fmtAr(sum.totalDepositUsd)} sub="$" />
          <StatCard label="إجمالي التسديدات" value={fmtAr(sum.totalSettledIqd)} sub="د.ع" />
          <StatCard label="إجمالي العمولات" value={fmtAr(sum.totalFeesIqd)} sub="د.ع" tone="warning" />
          <StatCard label="صافي فروق الصرف" value={fmtAr(sum.totalFxDiff)} sub="د.ع" tone={D(sum.totalFxDiff).isNegative() ? "negative" : "positive"} />
        </div>
      )}

      <Card className="p-4">
        <div className="overflow-x-auto">
          <DataTable
            data={(st.data?.transactions ?? []) as TxnRow[]}
            columns={cols}
            loading={st.isLoading && houseId > 0}
            emptyText={houseId === 0 ? "اختر صيرفة لعرض كشفها." : "لا حركات في النطاق المحدّد."}
            showFilter={false}
            pageSize={25}
          />
        </div>
      </Card>
    </div>
  );
}
