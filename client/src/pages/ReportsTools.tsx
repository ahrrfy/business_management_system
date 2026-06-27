// أدوات المحاسب — حزمة شهرية بزرّ واحد (Excel متعدّد الأوراق) + فحص جودة البيانات (reconcile).
// تستدعي endpoints موجودة عبر utils.fetch ثم تبني مصنّفاً واحداً عبر exportSheets. يحفظ شهر/سنة/فرع (reportPrefs).
import { useMemo, useState } from "react";
import { FileSpreadsheet, ShieldCheck, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exportSheets, type SheetSpec } from "@/lib/export";
import { fmtAr } from "@/lib/money";
import { loadReportPrefs, saveReportPrefs } from "@/lib/reportPrefs";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

type SheetKey = "pl" | "position" | "cashflow" | "arAging" | "apAging" | "expenses" | "inventory" | "sales" | "purchases";
const SHEET_LABEL: Record<SheetKey, string> = {
  pl: "الأرباح والخسائر",
  position: "المركز المالي",
  cashflow: "التدفّقات النقدية",
  arAging: "أعمار الذمم المدينة",
  apAging: "أعمار الذمم الدائنة",
  expenses: "المصروفات",
  inventory: "تقييم المخزون",
  sales: "ملخّص المبيعات",
  purchases: "ملخّص المشتريات",
};
const ALL_KEYS = Object.keys(SHEET_LABEL) as SheetKey[];

const PREFS_KEY = "accountant-bundle";

export default function ReportsTools() {
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery();
  const utils = trpc.useUtils();

  const saved = useMemo(() => loadReportPrefs(PREFS_KEY), []);
  const now = new Date();
  const [year, setYear] = useState<number>(saved.year ?? now.getFullYear());
  const [month, setMonth] = useState<number>(saved.month ?? now.getMonth() + 1);
  const [branchId, setBranchId] = useState<number | "">(saved.branchId ?? "");
  const [selected, setSelected] = useState<Set<SheetKey>>(new Set(ALL_KEYS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branchArg = branchId ? Number(branchId) : undefined;
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "كل الفروع";
  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  function toggle(k: SheetKey) {
    setSelected((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  function persist() { saveReportPrefs(PREFS_KEY, { branchId, month, year }); }

  async function buildSheet(k: SheetKey): Promise<SheetSpec | null> {
    const meta = [{ label: "الفترة", value: `${from} — ${to}` }, { label: "الفرع", value: branchLabel }];
    const moneyCol = (key: string, header: string) => ({ key, header, money: true, map: (r: any) => Number(r[key] ?? 0) });
    switch (k) {
      case "pl": {
        const pl = await utils.reports.profitAndLoss.fetch({ from, to, branchId: branchArg });
        const c = pl.current;
        const rows: any[] = [
          { label: "الإيراد", amount: Number(c.revenue) },
          { label: "تكلفة المبيعات", amount: Number(c.cogs) },
          { label: "مجمل الربح", amount: Number(c.grossProfit) },
          ...c.expenseLines.map((l) => ({ label: l.label, amount: Number(l.amount) })),
          { label: "إجمالي المصروفات", amount: Number(c.totalExpenses) },
          { label: "صافي الربح", amount: Number(c.netProfit) },
        ];
        return { sheetName: SHEET_LABEL.pl, title: SHEET_LABEL.pl, meta, rows, columns: [{ key: "label", header: "البند" }, moneyCol("amount", "المبلغ")] };
      }
      case "position": {
        const fp = await utils.reports.financialPosition.fetch(branchArg ? { branchId: branchArg } : undefined);
        const rows = [
          { label: "النقد", amount: Number(fp.cash) },
          { label: "ذمم مدينة (عملاء)", amount: Number(fp.arDebit) },
          { label: "المخزون", amount: Number(fp.inventory) },
          { label: "أصول ثابتة", amount: Number(fp.fixedAssets) },
          { label: "ذمم دائنة (موردون)", amount: Number(fp.apCredit) },
          { label: "حقوق الملكية", amount: Number(fp.equity) },
        ];
        return { sheetName: SHEET_LABEL.position, title: SHEET_LABEL.position, meta, rows, columns: [{ key: "label", header: "البند" }, moneyCol("amount", "المبلغ")] };
      }
      case "cashflow": {
        const cf = await utils.reports.cashFlow.fetch({ from, to, branchId: branchArg });
        const rows = [
          ...cf.inflows.map((l) => ({ label: `وارد: ${l.label}`, amount: Number(l.amount) })),
          ...cf.outflows.map((l) => ({ label: `صادر: ${l.label}`, amount: Number(l.amount) })),
          { label: "صافي التدفّق", amount: Number(cf.net) },
        ];
        return { sheetName: SHEET_LABEL.cashflow, title: SHEET_LABEL.cashflow, meta, rows, columns: [{ key: "label", header: "البند" }, moneyCol("amount", "المبلغ")] };
      }
      case "arAging": {
        const ar = await utils.reports.arAging.fetch(branchArg ? { branchId: branchArg } : undefined);
        return {
          sheetName: SHEET_LABEL.arAging, title: SHEET_LABEL.arAging, meta, rows: ar as any[],
          columns: [
            { key: "customerName", header: "العميل" },
            moneyCol("d0_30", "0-30"), moneyCol("d31_60", "31-60"), moneyCol("d61_90", "61-90"), moneyCol("d91p", "+90"),
            moneyCol("unpaidTotal", "المتبقّي"),
          ],
        };
      }
      case "apAging": {
        const ap = await utils.reports.apAging.fetch(branchArg ? { branchId: branchArg } : undefined);
        return {
          sheetName: SHEET_LABEL.apAging, title: SHEET_LABEL.apAging, meta, rows: ap as any[],
          columns: [
            { key: "supplierName", header: "المورّد" },
            moneyCol("d0_30", "0-30"), moneyCol("d31_60", "31-60"), moneyCol("d61_90", "61-90"), moneyCol("d91p", "+90"),
            moneyCol("unpaidTotal", "المتبقّي"),
          ],
        };
      }
      case "expenses": {
        const ex = await utils.reports.expensesReport.fetch({ from, to, branchId: branchArg });
        return {
          sheetName: SHEET_LABEL.expenses, title: SHEET_LABEL.expenses, meta, rows: ex.byCategory as any[],
          columns: [{ key: "label", header: "الفئة" }, moneyCol("amount", "المبلغ"), { key: "count", header: "العدد", map: (r: any) => Number(r.count) }],
        };
      }
      case "inventory": {
        const iv = await utils.reports.inventoryValuation.fetch(branchArg ? { branchId: branchArg } : undefined);
        return {
          sheetName: SHEET_LABEL.inventory, title: SHEET_LABEL.inventory, meta, rows: iv.rows as any[],
          columns: [
            { key: "categoryName", header: "الفئة" },
            { key: "items", header: "الأصناف", map: (r: any) => Number(r.items) },
            { key: "totalQty", header: "الكمية", map: (r: any) => Number(r.totalQty) },
            moneyCol("totalValue", "القيمة"),
          ],
        };
      }
      case "sales": {
        const sd = await utils.reports.salesByDimension.fetch({ from, to, branchId: branchArg, dimension: "customer" });
        return {
          sheetName: SHEET_LABEL.sales, title: "المبيعات حسب العميل", meta, rows: sd.rows as any[],
          columns: [
            { key: "label", header: "العميل" },
            { key: "invoices", header: "الفواتير", map: (r: any) => Number(r.invoices) },
            moneyCol("revenue", "الإيراد"), moneyCol("profit", "الربح"),
            { key: "marginPct", header: "الهامش %", map: (r: any) => Number(r.marginPct) },
          ],
        };
      }
      case "purchases": {
        const pr = await utils.reports.purchasesReport.fetch({ from, to, branchId: branchArg });
        return {
          sheetName: SHEET_LABEL.purchases, title: SHEET_LABEL.purchases, meta, rows: pr.rows as any[],
          columns: [
            { key: "supplierName", header: "المورّد" },
            { key: "orders", header: "الأوامر", map: (r: any) => Number(r.orders) },
            moneyCol("total", "الإجمالي"), moneyCol("paid", "المدفوع"), moneyCol("unpaid", "المتبقّي"),
          ],
        };
      }
    }
  }

  async function onExportBundle() {
    setBusy(true);
    setError(null);
    persist();
    try {
      const keys = ALL_KEYS.filter((k) => selected.has(k));
      const built: SheetSpec[] = [];
      for (const k of keys) {
        const s = await buildSheet(k);
        if (s) built.push(s);
      }
      if (!built.length) { setError("اختر ورقة واحدة على الأقل."); return; }
      exportSheets(`الحزمة-الشهرية-${year}-${pad(month)}${branchId ? `-${branchLabel}` : ""}`, built);
    } catch (e) {
      setError("تعذّر بناء الحزمة. حاول مجدّداً.");
      console.error("[bundle] failed:", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="أدوات المحاسب" description="حزمة القوائم الشهرية بزرّ واحد + فحص جودة البيانات." />

      {/* حزمة المحاسب الشهرية */}
      <Card>
        <CardContent className="space-y-4 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileSpreadsheet className="size-4 text-primary" aria-hidden /> الحزمة الشهرية (Excel متعدّد الأوراق)
          </h2>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">الشهر</label>
              <select className={selectCls} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {MONTHS_AR.map((m, i) => (<option key={i} value={i + 1}>{m}</option>))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">السنة</label>
              <select className={selectCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => (<option key={y} value={y}>{y}</option>))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">الفرع</label>
              <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">كل الفروع</option>
                {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ALL_KEYS.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm hover:bg-accent/40">
                <input type="checkbox" className="size-4 rounded border-input" checked={selected.has(k)} onChange={() => toggle(k)} />
                <span>{SHEET_LABEL[k]}</span>
              </label>
            ))}
          </div>

          {error && <p className="text-sm text-money-negative">{error}</p>}

          <div className="flex items-center gap-3">
            <Button onClick={onExportBundle} disabled={busy || !selected.size}>
              {busy ? <><Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ البناء…</> : <><FileSpreadsheet className="size-4" aria-hidden /> تصدير الحزمة ({fmtAr(selected.size)} ورقة)</>}
            </Button>
            <span className="text-xs text-muted-foreground">سيُنزَّل ملف Excel واحد بكل القوائم المحدّدة.</span>
          </div>
        </CardContent>
      </Card>

      {/* فحص جودة البيانات */}
      <QualityCheck enabled={isAdmin} />
    </div>
  );
}

function QualityCheck({ enabled }: { enabled: boolean }) {
  const q = trpc.reports.reconcile.useQuery(undefined, { enabled, staleTime: 30_000 });
  if (!enabled) return null;

  const checks = q.data
    ? [
        { label: "أرصدة العملاء", count: q.data.customers.length },
        { label: "أرصدة الموردين", count: q.data.suppliers.length },
        { label: "المخزون", count: q.data.inventory.length },
        { label: "الدفتر والربح", count: q.data.ledger.length },
      ]
    : [];

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4 text-primary" aria-hidden /> فحص جودة البيانات (تدقيق التوافق)
        </h2>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">جارٍ الفحص…</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {checks.map((c) => (
              <div key={c.label} className={`flex items-center gap-2 rounded-md border p-3 text-sm ${c.count > 0 ? "border-stock-low/40" : ""}`}>
                {c.count > 0 ? <AlertTriangle className="size-4 text-stock-low" aria-hidden /> : <CheckCircle2 className="size-4 text-money-positive" aria-hidden />}
                <div>
                  <p className="font-medium">{c.label}</p>
                  <p className="text-xs text-muted-foreground">{c.count > 0 ? `${fmtAr(c.count)} انحراف` : "متطابق"}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {q.data && <p className="text-[11px] text-muted-foreground">آخر فحص: {new Date(q.data.runAt).toLocaleString("ar-IQ-u-nu-latn")}</p>}
      </CardContent>
    </Card>
  );
}
