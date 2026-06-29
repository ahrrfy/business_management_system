// بطاقة المنتج (Kardex) — حركات متغيّر واحد زمنياً مع رصيد متحرّك.
// منتقي المتغيّر يعيد استعمال trpc.catalog.posList (نفس بحث الكاشير/حركات المخزون) + فلتر فرع + فترة اختيارية.
// عرض: ترويسة المتغيّر + مؤشّرات (رصيد افتتاحي/ختامي) + جدول (تاريخ/نوع/كمية بإشارة/رصيد/مرجع) + تصدير/طباعة.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { exportRows } from "@/lib/export";
import { fmtInt } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";

type PosRow = RouterOutputs["catalog"]["posList"][number];
type LedgerRow = RouterOutputs["reports"]["itemLedger"]["rows"][number];

const MTYPE_LABEL: Record<string, string> = {
  IN: "وارد",
  OUT: "صادر",
  ADJUST: "تسوية",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};
const POSITIVE = new Set(["IN", "RETURN", "TRANSFER_IN"]);
const NEGATIVE = new Set(["OUT", "TRANSFER_OUT"]);

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** كمية بإشارة للعرض (+/−). الصفر بلا إشارة. */
function signedDisplay(n: number): string {
  if (n > 0) return `+${fmtInt(n)}`;
  if (n < 0) return `−${fmtInt(Math.abs(n))}`;
  return fmtInt(0);
}

function variantLabel(r: {
  productName: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
}): string {
  const detail = [r.variantName, r.color, r.size].filter(Boolean).join(" / ");
  return detail ? `${r.productName} — ${detail}` : r.productName;
}

function TypeBadge({ type }: { type: string }) {
  const label = MTYPE_LABEL[type] ?? type;
  const cls = POSITIVE.has(type)
    ? "badge-status-active"
    : NEGATIVE.has(type)
    ? "badge-stock-out"
    : "badge-stock-low";
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>;
}

export default function ItemLedger() {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin" || role === "manager";
  const myBranch = me.data?.branchId ?? 1;

  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [usePeriod, setUsePeriod] = useState(false);
  const [pickedBranch, setPickedBranch] = useState<number | "">("");
  const branchId = canPickBranch ? (pickedBranch === "" ? undefined : Number(pickedBranch)) : myBranch;

  // المتغيّر المختار + بحث المنتقي.
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<PosRow | null>(null);

  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });

  // منتقي المتغيّر: نفس endpoint بحث الكاشير/حركات المخزون. فرع البحث = المختار أو فرع المستخدم.
  const searchBranchId = Number(branchId ?? myBranch);
  const searchResults = trpc.catalog.posList.useQuery(
    { branchId: searchBranchId, tier: "RETAIL", query: search, limit: 200 },
    { enabled: search.trim().length > 0 },
  );

  // صفّ واحد لكل متغيّر (تفضيل وحدة الأساس).
  const searchVariants = useMemo(() => {
    const byVariant = new Map<number, PosRow>();
    for (const r of searchResults.data ?? []) {
      const cur = byVariant.get(r.variantId);
      if (!cur || (r.isBaseUnit && !cur.isBaseUnit)) byVariant.set(r.variantId, r);
    }
    return Array.from(byVariant.values());
  }, [searchResults.data]);

  const ledger = trpc.reports.itemLedger.useQuery(
    {
      variantId: picked?.variantId ?? 0,
      branchId: branchId ?? undefined,
      from: usePeriod ? period.from : undefined,
      to: usePeriod ? period.to : undefined,
    },
    { enabled: picked != null && picked.variantId > 0 },
  );

  const rows: LedgerRow[] = ledger.data?.rows ?? [];
  const variant = ledger.data?.variant ?? null;
  const opening = ledger.data?.openingBalance ?? 0;
  const closing = ledger.data?.closingBalance ?? 0;

  const kpis: KpiItem[] = picked
    ? [
        { label: "رصيد افتتاحي", value: fmtInt(opening), tone: "info" },
        { label: "رصيد ختامي", value: fmtInt(closing), tone: "positive" },
        { label: "عدد الحركات", value: rows.length },
      ]
    : [];

  const periodLabel = usePeriod ? `${period.from} — ${period.to}` : "كل الفترات";
  const branchLabel = branchId
    ? (branches.data?.find((b) => Number(b.id) === Number(branchId))?.name ?? String(branchId))
    : "كل الفروع";

  function changePeriod(p: PeriodValue) {
    setPeriod(p);
    setUsePeriod(true);
  }

  function onExport() {
    if (!rows.length) return;
    exportRows(rows, {
      filename: `بطاقة-المنتج-${variant?.sku ?? picked?.variantId ?? ""}`,
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "type", header: "النوع", map: (r) => MTYPE_LABEL[r.type] ?? r.type },
        { key: "signedQty", header: "الكمية", map: (r) => r.signedQty },
        { key: "balance", header: "الرصيد", map: (r) => r.balance },
        { key: "reference", header: "المرجع", map: (r) => r.reference ?? "" },
      ],
    });
  }

  function onPrint() {
    if (!rows.length) return;
    printReportDoc({
      title: "بطاقة المنتج (Kardex)",
      headerExtra: [
        { label: "المنتج", value: variant?.label ?? "—" },
        { label: "SKU", value: variant?.sku ?? "—" },
        { label: "الفرع", value: branchLabel },
        { label: "الفترة", value: periodLabel },
        { label: "رصيد افتتاحي", value: fmtInt(opening) },
        { label: "رصيد ختامي", value: fmtInt(closing) },
      ],
      columns: [
        { key: "date", label: "التاريخ" },
        { key: "type", label: "النوع" },
        { key: "qty", label: "الكمية", align: "left" },
        { key: "balance", label: "الرصيد", align: "left" },
        { key: "ref", label: "المرجع" },
      ],
      rows: rows.map((r) => ({
        date: r.date,
        type: MTYPE_LABEL[r.type] ?? r.type,
        qty: signedDisplay(r.signedQty),
        balance: fmtInt(r.balance),
        ref: r.reference ?? "—",
      })),
      summary: [
        { label: "رصيد افتتاحي", value: fmtInt(opening) },
        { label: "رصيد ختامي", value: fmtInt(closing), large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="بطاقة المنتج (Kardex)"
      description="حركات منتج واحد زمنياً (وارد/صادر/تحويل/تسوية/مرتجع) مع رصيد متحرّك."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          {/* منتقي المتغيّر */}
          <div className="flex flex-col gap-1 min-w-[260px]">
            <label className="text-[11px] text-muted-foreground">المنتج (اسم/SKU/باركود)</label>
            <div className="relative">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="اكتب للبحث…"
              />
              {search.trim() && (searchVariants.length > 0 || searchResults.isFetching) && (
                <div className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow max-h-60 overflow-auto">
                  {searchResults.isFetching && (
                    <div className="p-2 text-xs text-muted-foreground text-center">جارٍ البحث…</div>
                  )}
                  {searchVariants.map((v) => (
                    <button
                      key={v.variantId}
                      type="button"
                      className="block w-full text-end px-3 py-2 text-sm hover:bg-accent"
                      onClick={() => {
                        setPicked(v);
                        setSearch("");
                      }}
                    >
                      <div className="font-medium">{variantLabel(v)}</div>
                      <div className="text-xs text-muted-foreground font-mono flex justify-between" dir="ltr">
                        <span>{v.sku}</span>
                        <span>متاح {fmtInt(v.stockBase)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {canPickBranch && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">الفرع</label>
              <select
                className={selectCls}
                value={pickedBranch === "" ? "" : String(pickedBranch)}
                onChange={(e) => setPickedBranch(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">كل الفروع</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <PeriodFilter value={period} onChange={changePeriod} />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground pb-2">
            <input
              type="checkbox"
              checked={usePeriod}
              onChange={(e) => setUsePeriod(e.target.checked)}
            />
            تقييد بالفترة
          </label>
        </div>
      }
    >
      {/* ترويسة المتغيّر المختار */}
      {picked && variant && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <div className="font-semibold">{variant.label}</div>
              <div className="text-xs text-muted-foreground font-mono" dir="ltr">{variant.sku}</div>
            </div>
            <div className="text-xs text-muted-foreground">{branchLabel} · {periodLabel}</div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {!picked ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              ابحث عن منتج واخترْه لعرض بطاقته.
            </p>
          ) : ledger.isLoading ? (
            <LoadingState />
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">التاريخ</th>
                    <th className="p-2.5 text-end font-medium">النوع</th>
                    <th className="p-2.5 text-start font-medium">الكمية</th>
                    <th className="p-2.5 text-start font-medium">الرصيد</th>
                    <th className="p-2.5 text-end font-medium">المرجع</th>
                  </tr>
                </thead>
                <tbody>
                  {!rows.length && (
                    <TableEmptyRow colSpan={5} message="لا حركات لهذا المنتج في هذا النطاق." />
                  )}
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.date}</td>
                      <td className="p-2.5 text-end"><TypeBadge type={r.type} /></td>
                      <td
                        className={`p-2.5 text-start tabular-nums font-semibold ${
                          r.signedQty > 0 ? "text-money-positive" : r.signedQty < 0 ? "text-money-negative" : "text-muted-foreground"
                        }`}
                        dir="ltr"
                      >
                        {signedDisplay(r.signedQty)}
                      </td>
                      <td className="p-2.5 text-right tabular-nums font-medium" dir="ltr">{fmtInt(r.balance)}</td>
                      <td className="p-2.5 text-end text-muted-foreground text-xs">{r.reference ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
                {rows.length > 0 && (
                  <tfoot>
                    <tr className="border-t bg-muted/40 text-sm font-semibold">
                      <td className="p-2.5 text-end" colSpan={3}>الرصيد الختامي</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtInt(closing)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
