import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { esc } from "@/lib/printing/brand";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { trpc } from "@/lib/trpc";
import { Printer } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { RowActions } from "@/components/list";

/** طرق الدفع المتاحة لتسوية الأمانة — الخادم يقبل CARD/TRANSFER أيضاً (لا نقتصر على نقدي فقط
 *  كما كانت الشاشة مبرمَجة بصمت). بلا صكوك (قرار مالك: لا تعامل بالصكوك) رغم أن الخادم يقبلها. */
const SETTLEMENT_METHODS: Array<"CASH" | "CARD" | "TRANSFER"> = ["CASH", "CARD", "TRANSFER"];

/** التاريخ المحلّيّ اليوم/أوّل الشهر بصيغة YYYY-MM-DD (افتراضات منتقي الفترة — يغيّرها المستخدم). */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * تسويات الأمانة (ش٥) — لكل مودِع: المستحق + بضاعته المتبقية، وزرّ «تسوية» يُنشئ سند صرف **معلَّقاً**
 * (اعتماد ثنائيّ عبر طابور السندات القائم). راجع design §٩.
 */
export default function ConsignmentSettlements() {
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  // منتقي فرع صريح إلزامي (عملية مالية — سند صرف حقيقي): فرع المستخدم المُسنَد يُستعمَل صامتاً؛
  // الأدمن/المدير بلا فرع مُسنَد يلزمه اختيارٌ صريح قبل تفعيل زرّ التسوية (نمط PR #288 في
  // Reception.tsx) بدل فرعٍ ١ صامت يُنسَب إليه صرفٌ فعليّ من صندوقه.
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";
  const noAssignedBranch = me.data != null && me.data.branchId == null;
  const needsBranchChoice = noAssignedBranch && isElevatedRole && pickedBranch == null;
  const branchId = Number(me.data?.branchId ?? pickedBranch ?? 1);
  const branchName = (branches.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`;

  // طريقة دفع التسوية — الخادم يقبل بطاقة/تحويل أيضاً وكانت الشاشة تُرسل نقدياً دائماً بصمت.
  const [settlementMethod, setSettlementMethod] = useState<"CASH" | "CARD" | "TRANSFER">("CASH");

  const balances = trpc.consignments.balancesReport.useQuery(undefined);
  const utils = trpc.useUtils();

  const now = new Date();
  const [startDate, setStartDate] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [endDate, setEndDate] = useState(ymd(now));
  const margins = trpc.consignments.marginsReport.useQuery({ startDate, endDate });
  const marginRows = margins.data?.rows ?? [];
  const marginTotals = margins.data?.totals;

  // كشف تسوية مودِع (معاينة، نفس فترة تقرير الهوامش) — يُفتح بحوار عند اختيار مودِع.
  const [stmtConsignor, setStmtConsignor] = useState<number | null>(null);
  const statement = trpc.consignments.settlementStatement.useQuery(
    { consignorId: stmtConsignor ?? 0, startDate, endDate },
    { enabled: stmtConsignor != null },
  );

  const settle = trpc.consignments.createSettlement.useMutation({
    onSuccess: () => {
      notify.ok("أُنشئت التسوية", "بانتظار اعتماد سند الصرف من مدير آخر (طابور السندات).");
      utils.consignments.balancesReport.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function doSettle(consignorId: number, name: string, owed: string) {
    if (Number(owed) <= 0 || needsBranchChoice) return;
    const ok = await confirm({
      title: "تسوية مودِع",
      description: `إنشاء سند صرف ${paymentMethodLabel(settlementMethod)} بمبلغ ${fmt(owed)} د.ع للمودِع «${name}» من فرع «${branchName}». يُنشأ معلَّقاً ويعتمده مدير آخر. متابعة؟`,
      confirmText: "إنشاء التسوية",
    });
    if (!ok) return;
    settle.mutate({
      consignorId,
      amount: String(owed),
      paymentMethod: settlementMethod,
      branchId,
      clientRequestId: crypto.randomUUID(),
    });
  }

  /** طباعة/تصدير كشف تسوية المودِع — مستند مرافق لسند الصرف (لا مخرج له حتى الآن، المعاينة
   * تظهر بالحوار فقط بلا وسيلة طباعة/حفظ). يفتح نافذة طباعة A4 بسيطة. */
  function printStatement() {
    const s = statement.data;
    if (!s) return;
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) return;
    const lineRows = s.lines
      .map(
        (l) => `<tr><td>${esc(l.productName)} <span class="muted">${esc(l.sku)}</span></td><td class="num">${esc(String(l.soldQty))}</td><td class="num">${esc(fmt(l.soldValue))}</td><td class="num">${esc(fmt(l.share))}</td><td class="num">${esc(fmt(l.margin))}</td></tr>`,
      )
      .join("");
    w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كشف تسوية مودِع</title>
      <style>
        body{font-family:Cairo,sans-serif;padding:28px;color:#222}
        h1{margin:0 0 4px;font-size:20px}
        .muted{color:#666;font-size:12px}
        .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}
        .kpi{border:1px solid #ddd;border-radius:8px;padding:8px}
        .kpi .l{font-size:11px;color:#666}
        .kpi .v{font-weight:700;font-size:15px}
        table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12.5px}
        th,td{border:1px solid #ccc;padding:6px 8px;text-align:right}
        thead{background:#f4f4f5}
        td.num{text-align:left;direction:ltr;font-weight:600}
      </style>
      </head><body>
      <h1>كشف تسوية مودِع — ${esc(s.consignorName)}</h1>
      <p class="muted">الفترة من ${esc(s.period.startDate)} إلى ${esc(s.period.endDate)} · طُبع بتاريخ ${esc(new Date().toLocaleDateString("ar-IQ"))}</p>
      <div class="kpis">
        <div class="kpi"><div class="l">المستحقّ الحاليّ</div><div class="v">${esc(fmt(s.currentOwed))}</div></div>
        <div class="kpi"><div class="l">مبيعات الفترة</div><div class="v">${esc(fmt(s.period.soldValue))}</div></div>
        <div class="kpi"><div class="l">حصّة المودِع</div><div class="v">${esc(fmt(s.period.share))}</div></div>
        <div class="kpi"><div class="l">هامش المكتبة (${esc(String(s.period.marginPct))}٪)</div><div class="v">${esc(fmt(s.period.margin))}</div></div>
      </div>
      <table><thead><tr><th>المنتج</th><th>كمية</th><th>مُباع</th><th>حصّة</th><th>هامش</th></tr></thead>
      <tbody>${lineRows || `<tr><td colspan="5" class="muted">لا مبيعات في هذه الفترة.</td></tr>`}</tbody></table>
      <p class="muted">البضاعة المتبقية لدى المكتبة: ${esc(String(s.remaining.qty))} قطعة — قيمتها بالحصّة ${esc(fmt(s.remaining.valueByShare))} د.ع.</p>
      <script>setTimeout(()=>window.print(),300)</script>
      </body></html>`);
    w.document.close();
  }

  const rows = balances.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="تسويات الأمانة"
        description="المستحقّ لكل مودِع عن مبيعات بضاعته — تُسوّى بسند صرف يعتمده مدير آخر (فصل المهام)."
      />

      <Card>
        <CardContent className="pt-4 flex flex-wrap items-end gap-4">
          {needsBranchChoice ? (
            <div className="space-y-1">
              <Label htmlFor="cs-branch">الفرع <span className="text-destructive">*</span></Label>
              <select
                id="cs-branch"
                className="h-9 w-56 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={pickedBranch ?? ""}
                onChange={(e) => setPickedBranch(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— اختر الفرع —</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <p className="text-[11px] text-destructive">يلزم اختيار الفرع قبل تفعيل التسوية — سند الصرف يُنسَب لصندوقه.</p>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">فرع سند الصرف: <span className="font-semibold text-foreground">{branchName}</span></div>
          )}
          <div className="space-y-1">
            <Label htmlFor="cs-method">طريقة دفع التسوية</Label>
            <select
              id="cs-method"
              className="h-9 w-40 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={settlementMethod}
              onChange={(e) => setSettlementMethod(e.target.value as typeof settlementMethod)}
            >
              {SETTLEMENT_METHODS.map((m) => <option key={m} value={m}>{paymentMethodLabel(m)}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">أرصدة المودِعين</CardTitle></CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">المودِع</th><th className="p-2 text-start">المستحق له</th>
                  <th className="p-2 text-center">بضاعة متبقية</th><th className="p-2 text-start">قيمتها (بالحصة)</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const owed = Number(r.owed);
                  return (
                    <tr key={r.consignorId} className="border-t">
                      <td className="p-2 font-medium">
                        <Link href={`/suppliers/${r.consignorId}/edit`} className="hover:underline">{r.consignorName}</Link>
                      </td>
                      <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(r.owed)}</td>
                      <td className="p-2 text-center">{r.remainingQty} <span className="text-xs text-muted-foreground">({r.variantCount} منتج)</span></td>
                      <td className="p-2 text-start tabular-nums text-muted-foreground" dir="ltr">{fmt(r.remainingValueByShare)}</td>
                      <td className="p-2 text-center">
                        <RowActions
                          mode="menu"
                          actions={[
                            {
                              key: "settle",
                              kind: "pay",
                              label: owed > 0 ? "تسوية" : "لا مستحق",
                              disabled: owed <= 0 || settle.isPending || needsBranchChoice,
                              disabledReason: needsBranchChoice
                                ? "اختر الفرع أولاً من أعلى الصفحة"
                                : owed <= 0 ? "لا يوجد مبلغ مستحق للتسوية" : "توجد عملية تسوية قيد التنفيذ",
                              onSelect: () => void doSettle(r.consignorId, r.consignorName, r.owed),
                              gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                            },
                            {
                              key: "settlement-statement",
                              kind: "view",
                              label: "كشف تسوية",
                              onSelect: () => setStmtConsignor(r.consignorId),
                              gate: { roles: ["manager", "accountant", "auditor"], module: "reports", level: "READ" },
                            },
                            {
                              key: "supplier-statement",
                              kind: "view",
                              label: "كشف حساب",
                              href: `/suppliers-statement?id=${r.consignorId}`,
                              gate: { module: "suppliers", level: "READ" },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {!balances.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={5} message="لا مودِعين بعد." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">هوامش الأمانة</CardTitle>
          <p className="text-xs text-muted-foreground">ربح المكتبة المُحقَّق من بيع بضاعة كل مودِع خلال الفترة (صافي المرتجعات) = المُباع − حصّة المودِع.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground mb-1">من</span>
              <Input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground mb-1">إلى</span>
              <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            </label>
          </div>
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">المودِع</th>
                  <th className="p-2 text-center">كمية مباعة</th>
                  <th className="p-2 text-start">المُباع (صافي)</th>
                  <th className="p-2 text-start">حصّة المودِع</th>
                  <th className="p-2 text-start">هامش المكتبة</th>
                  <th className="p-2 text-center">النسبة</th>
                </tr>
              </thead>
              <tbody>
                {marginRows.map((r) => (
                  <tr key={r.consignorId} className="border-t">
                    <td className="p-2 font-medium">
                      <Link href={`/suppliers/${r.consignorId}/edit`} className="hover:underline">{r.consignorName}</Link>
                    </td>
                    <td className="p-2 text-center tabular-nums">{r.soldQty}</td>
                    <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(r.soldValue)}</td>
                    <td className="p-2 text-start tabular-nums text-muted-foreground" dir="ltr">{fmt(r.consignorShare)}</td>
                    <td className="p-2 text-start tabular-nums font-semibold text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(r.libraryMargin)}</td>
                    <td className="p-2 text-center tabular-nums text-muted-foreground" dir="ltr">{r.marginPct}٪</td>
                  </tr>
                ))}
                {!margins.isLoading && marginRows.length === 0 && (
                  <TableEmptyRow colSpan={6} message="لا مبيعات أمانة في هذه الفترة." />
                )}
                {marginTotals && marginRows.length > 0 && (
                  <tr className="border-t-2 bg-muted/30 font-semibold">
                    <td className="p-2">الإجمالي</td>
                    <td className="p-2"></td>
                    <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(marginTotals.soldValue)}</td>
                    <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(marginTotals.consignorShare)}</td>
                    <td className="p-2 text-start tabular-nums text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(marginTotals.libraryMargin)}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{marginTotals.marginPct}٪</td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Dialog open={stmtConsignor != null} onOpenChange={(o) => !o && setStmtConsignor(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>كشف تسوية مودِع{statement.data ? ` — ${statement.data.consignorName}` : ""}</DialogTitle>
          </DialogHeader>
          {statement.isLoading && <p className="text-sm text-muted-foreground py-6 text-center">جارٍ التحميل…</p>}
          {statement.data && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">الفترة من {statement.data.period.startDate} إلى {statement.data.period.endDate}. مستندٌ استرشاديٌّ للمعاينة يرافق سند التسوية.</p>
                <Button variant="outline" size="sm" onClick={printStatement} className="shrink-0 gap-1">
                  <Printer aria-hidden className="size-3.5" /> طباعة الكشف
                </Button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Kpi label="المستحقّ الحاليّ" value={fmt(statement.data.currentOwed)} strong />
                <Kpi label="مبيعات الفترة" value={fmt(statement.data.period.soldValue)} />
                <Kpi label="حصّة المودِع" value={fmt(statement.data.period.share)} />
                <Kpi label={`هامش المكتبة (${statement.data.period.marginPct}٪)`} value={fmt(statement.data.period.margin)} />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">تفصيل المبيعات (صافي المرتجعات)</div>
                <ScrollTableShell bordered>
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2">المنتج</th><th className="p-2 text-center">كمية</th>
                        <th className="p-2 text-start">مُباع</th><th className="p-2 text-start">حصّة</th><th className="p-2 text-start">هامش</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.data.lines.map((l) => (
                        <tr key={l.variantId} className="border-t">
                          <td className="p-2">{l.productName} <span className="text-xs text-muted-foreground">{l.sku}</span></td>
                          <td className="p-2 text-center tabular-nums">{l.soldQty}</td>
                          <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(l.soldValue)}</td>
                          <td className="p-2 text-start tabular-nums text-muted-foreground" dir="ltr">{fmt(l.share)}</td>
                          <td className="p-2 text-start tabular-nums text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(l.margin)}</td>
                        </tr>
                      ))}
                      {statement.data.lines.length === 0 && <TableEmptyRow colSpan={5} message="لا مبيعات في هذه الفترة." />}
                    </tbody>
                  </table>
                </ScrollTableShell>
              </div>
              <div className="flex items-center gap-6 text-sm border-t pt-3">
                <span>البضاعة المتبقية لدى المكتبة: <b className="tabular-nums">{statement.data.remaining.qty}</b> قطعة</span>
                <span className="text-muted-foreground">قيمتها بالحصّة: <span className="tabular-nums" dir="ltr">{fmt(statement.data.remaining.valueByShare)}</span></span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kpi({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${strong ? "text-base font-semibold" : "text-sm"}`} dir="ltr">{value}</div>
    </div>
  );
}
