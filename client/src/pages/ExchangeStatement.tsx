// تبويب «كشف الحساب» — حركات الصيرفة بعملتيها + رصيد جارٍ (لقطة بعد كل عملية) + ملخّص.
import { useCallback, useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { type ColumnDef } from "@tanstack/react-table";
import { FileText, Printer, Undo2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { fmtDateTime } from "@/lib/date";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { D, fmtAr } from "@/lib/money";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { selectCls, type ExchangeRow } from "@/components/exchange/shared";
import { RowActions, type RowAction } from "@/components/list";
import { printExchangeSlipSmart, type ExchangeSlipData } from "@/lib/printing/printExchangeSlip";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { usePrintAudit } from "@/hooks/usePrintAudit";

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
  exchangeRate: string;
  commission: string;
  fxDiff: string;
  commissionIqd: string;
  supplierName: string | null;
  voucherNumber: string | null;
  balanceIqdAfter: string;
  balanceUsdAfter: string;
  status: string;
  notes: string | null;
  createdAt: string;
  createdByName: string | null;
  branchName: string | null;
};

const fmtDT = (d: string) => fmtDateTime(d);

/**
 * صفُّ الحيازة الدولارية الفعلية لكل فرع — مُعلَنٌ صراحةً لا مُشتقّاً بالفهرسة.
 *
 * ⚠️ `RouterOutputs["exchange"]["statement"]["…"]` **لا يعمل**: مخرَجُ هذا الإجراء عميقٌ
 * بما يكفي لتتحلّل عندَه استنتاجاتُ tsc، فتفشل الفهرسةُ على **كلّ** مفتاح (`transactions`
 * و`summary` كذلك) بينما الطباعةُ في رسالة الخطأ تُظهر المفاتيح موجودة. حالةٌ قائمة في
 * المستودع لا تخصّ هذا التحويل — والوصولُ بالنقطة (`st.data.physicalUsdByBranch`) يعمل.
 * المصدر: `physicalUsdByBranch` في [statement.ts](server/services/exchange/statement.ts).
 */
type PhysicalUsdRow = {
  branchId: number;
  branchName: string;
  quantityUsd: string;
  carryingIqd: string;
  wavgRate: string;
};

const physicalUsdColumns: ColumnDef<PhysicalUsdRow, unknown>[] = [
  { id: "branch", header: "الفرع", accessorFn: (r) => r.branchName, meta: { width: "wide" }, cell: ({ row }) => row.original.branchName },
  { id: "quantityUsd", header: "الكمية الفعلية ($)", accessorFn: (r) => fmtAr(r.quantityUsd), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.quantityUsd) },
  { id: "carryingIqd", header: "القيمة الدفترية (د.ع)", accessorFn: (r) => fmtAr(r.carryingIqd), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.carryingIqd) },
  { id: "wavgRate", header: "متوسط الكلفة للعرض", accessorFn: (r) => fmtAr(r.wavgRate), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.wavgRate) },
];

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
  const printAudit = usePrintAudit();

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

  // طباعة سند العملية (حراري ٨٠مم أو A4) — متاحة لكل الأصناف بما فيها المعكوسة/الافتتاحية (توثيق).
  const doPrint = useCallback(
    async (t: TxnRow, mode: "thermal" | "a4") => {
      const house = houseRows.find((h) => h.id === houseId);
      if (!house) return;
      if (mode === "a4" && !reservePrintWindow()) return notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
      const baseData: ExchangeSlipData = {
        txnNumber: t.txnNumber,
        type: t.type as ExchangeSlipData["type"],
        currency: t.currency as ExchangeSlipData["currency"],
        status: t.status as ExchangeSlipData["status"],
        createdAt: fmtDT(t.createdAt),
        houseName: house.name,
        housePhone: house.phone,
        branchName: t.branchName,
        createdByName: t.createdByName,
        iqdAmount: t.iqdAmount,
        usdAmount: t.usdAmount,
        exchangeRate: t.exchangeRate,
        commission: t.commission,
        fxDiff: t.fxDiff,
        supplierName: t.supplierName,
        voucherNumber: t.voucherNumber,
        balanceIqdAfter: t.balanceIqdAfter,
        balanceUsdAfter: t.balanceUsdAfter,
        notes: t.notes,
      };
      try {
        const result = await printAudit.run({
          documentType: "EXCHANGE_TRANSACTION",
          documentId: t.id,
          channel: mode === "a4" ? "PDF" : "THERMAL",
          open: async (audit) => {
            const data = { ...baseData, printedByName: audit.actorName, printRequestedAt: fmtDateTime(audit.requestedAt) };
            const res = await printExchangeSlipSmart(data, mode);
            return "ok" in res ? res.ok : res;
          },
        });
        if (typeof result === "boolean" && !result) notify.err("تعذّر فتح نافذة الطباعة — تأكّد من السماح بالنوافذ المنبثقة.");
      } catch (error) {
        releaseReservedPrintWindow();
        notify.err(error instanceof Error ? error.message : "تعذّر تسجيل طلب الطباعة");
      }
    },
    [houseRows, houseId, printAudit],
  );

  const cols: ColumnDef<TxnRow>[] = useMemo(
    () => [
      { header: "التاريخ", accessorKey: "createdAt", cell: ({ row }) => <span dir="ltr" className="text-xs text-muted-foreground">{fmtDT(row.original.createdAt)}</span> },
      { header: "الرقم", accessorKey: "txnNumber", cell: ({ row }) => <span dir="ltr" className="text-xs">{row.original.txnNumber}</span> },
      { header: "النوع", accessorKey: "type", cell: ({ row }) => TYPE_AR[row.original.type] ?? row.original.type },
      { header: "المورد / الطرف", accessorKey: "supplierName", cell: ({ row }) => <span className="text-xs font-medium">{row.original.supplierName ?? "—"}</span> },
      { header: "مبلغ ديناري / قيمة دفترية (د.ع)", accessorKey: "iqdAmount", cell: ({ row }) => <span dir="ltr" className="tabular-nums">{D(row.original.iqdAmount).isZero() ? "—" : fmtAr(row.original.iqdAmount)}</span> },
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
          const canReverse = t.status === "ACTIVE" && t.type !== "OPENING";
          const actions: RowAction[] = [];
          if (canReverse) {
            actions.push({
              key: "reverse",
              kind: "reverse",
              label: "عكس",
              icon: Undo2,
              variant: "destructive",
              disabled: reverseMut.isPending,
              disabledReason: "توجد عملية عكس قيد التنفيذ",
              onSelect: () => void doReverse(t.id, t.txnNumber),
              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
            });
          }
          actions.push({
            key: "print-thermal", kind: "print", label: "طباعة حرارية", icon: Printer,
            onSelect: () => void doPrint(t, "thermal"),
          });
          actions.push({
            key: "print-a4", kind: "print", label: "طباعة A4", icon: FileText,
            onSelect: () => void doPrint(t, "a4"),
          });
          return (
            <div className="flex items-center justify-center gap-2">
              {t.status === "REVERSED" && <span className="text-xs text-money-negative shrink-0">معكوسة</span>}
              <RowActions actions={actions} />
            </div>
          );
        },
      },
    ],
    [doReverse, doPrint, reverseMut.isPending],
  );

  const operation = useMemo(
    () => ({
      getOperation: (transaction: TxnRow) => ({
        actor: {
          name: transaction.createdByName,
          source: transaction.createdByName ? ("user" as const) : ("legacy" as const),
        },
        action: {
          code: `exchange.${transaction.type.toLowerCase()}`,
          label: TYPE_AR[transaction.type] ?? transaction.type,
        },
        subject: { type: "exchangeTransaction", label: "عملية صيرفة", id: transaction.txnNumber },
        at: transaction.createdAt,
      }),
      label: "تتبّع العملية",
    }),
    [],
  );

  const sum = st.data?.summary;

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<FileText className="h-5 w-5 text-primary" />}
        title="كشف حساب الصيرفة"
        description="رصيد التعامل مع الصيرفة على مستوى الشركة، وحيازة الدولار الفعلية مفصّلة حسب الفرع."
      />

      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الصيرفة</label>
            <AppSelect className="h-9" value={String(houseId)} onValueChange={(value) => setHouseId(Number(value))}>
              <option value={0}>— اختر —</option>
              {houseRows.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </AppSelect>
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
          <StatCard label="حساب الصيرفة — دينار" value={fmtAr(sum.currentBalanceIqd)} sub="شركة ككل" tone={D(sum.currentBalanceIqd).isNegative() ? "negative" : "positive"} />
          <StatCard label="حساب الصيرفة — دولار" value={fmtAr(sum.currentBalanceUsd)} sub="كمية control، شركة ككل" tone={D(sum.currentBalanceUsd).isNegative() ? "negative" : "positive"} />
          <StatCard label="قيمة control الدفترية" value={fmtAr(sum.currentControlCarryingIqd)} sub="د.ع — ليست نقداً فعلياً" tone={D(sum.currentControlCarryingIqd).isNegative() ? "negative" : "positive"} />
          <StatCard label="ذمة الصيرفة المدينة — دينار" value={fmtAr(sum.iqdControlReceivableIqd)} sub="د.ع" tone="positive" />
          <StatCard label="ذمة الصيرفة الدائنة — دينار" value={fmtAr(sum.iqdControlPayableIqd)} sub="د.ع" tone={D(sum.iqdControlPayableIqd).isZero() ? "default" : "negative"} />
          <StatCard label="ذمة الصيرفة المدينة — دولار" value={fmtAr(sum.usdControlReceivableIqd)} sub="قيمة دفترية د.ع" tone="positive" />
          <StatCard label="ذمة الصيرفة الدائنة — دولار" value={fmtAr(sum.usdControlPayableIqd)} sub="قيمة دفترية د.ع" tone={D(sum.usdControlPayableIqd).isZero() ? "default" : "negative"} />
          <StatCard label="إجمالي الإيداعات (دينار)" value={fmtAr(sum.totalDepositIqd)} sub="د.ع" />
          <StatCard label="إجمالي الإيداعات (دولار)" value={fmtAr(sum.totalDepositUsd)} sub="$" />
          <StatCard label="إجمالي السحب (دينار)" value={fmtAr(sum.totalWithdrawIqd)} sub="د.ع" />
          <StatCard label="إجمالي السحب (دولار)" value={fmtAr(sum.totalWithdrawUsd)} sub="$" />
          <StatCard label="إجمالي الدولار المشترى" value={fmtAr(sum.totalUsdBought)} sub="$" />
          <StatCard label="إجمالي التسديدات" value={fmtAr(sum.totalSettledIqd)} sub="د.ع" />
          <StatCard label="إجمالي العمولات" value={fmtAr(sum.totalFeesIqd)} sub="د.ع" tone="warning" />
          <StatCard label="صافي فروق الصرف" value={fmtAr(sum.totalFxDiff)} sub="د.ع" tone={D(sum.totalFxDiff).isNegative() ? "negative" : "positive"} />
        </div>
      )}

      {houseId > 0 && st.data && (
        <Card className="p-4">
          <div className="mb-3">
            <h3 className="text-sm font-semibold">النقد الدولاري الفعلي حسب الفرع</h3>
            <p className="text-xs text-muted-foreground">
              الكمية والقيمة الدفترية أدناه أصل نقدي فعلي في الفرع؛ وهي منفصلة عن رصيد التعامل مع الصيرفة أعلاه.
            </p>
          </div>
          {/* مُضمَّن: عنوان القسم وشرحه أعلاه، فلا شريطَ حالةٍ ولا منتقيَ أعمدة. */}
          <DataTable<PhysicalUsdRow>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            columns={physicalUsdColumns}
            data={st.data.physicalUsdByBranch}
            emptyText="لا توجد حيازة دولار فعلية."
          />
        </Card>
      )}

      <Card className="p-4">
        <div className="overflow-x-auto">
          <DataTable
            data={(st.data?.transactions ?? []) as TxnRow[]}
            columns={cols}
            operation={operation}
            loading={st.isLoading && houseId > 0}
            emptyText={houseId === 0 ? "اختر صيرفة لعرض كشفها." : "لا حركات في النطاق المحدّد."}
            searchable={false}
            pageSize={25}
          />
        </div>
      </Card>
    </div>
  );
}
