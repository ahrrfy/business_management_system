/**
 * معاينة «محضر جرد وتسوية» على الشاشة (/stocktakes/:id/report) — مرجع التصميم jrd-report.jsx.
 * يعتمد على trpc.stocktakes.report (managerProcedure — العقد §٣) ويعيد احتساب المجاميع محلياً
 * بـ decimal.js من صفوف المحضر (نفس معادلات العقد §٢) ثم يطبع عبر printStocktakeReport.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { exportRows } from "@/lib/export";
import { D, round2, fmt, fmtInt } from "@/lib/money";
import {
  printStocktakeReport,
  STOCKTAKE_REASON_LABEL,
  STOCKTAKE_SCOPE_LABEL,
  STOCKTAKE_STATUS_LABEL,
} from "@/lib/printing/stocktakeTemplates";
import { trpc } from "@/lib/trpc";
import { useMemo } from "react";
import { Link, useParams } from "wouter";

// ─── شكل مخرج stocktakes.report المُستهلَك (العقد §٣ report + بنية §٤ review) ───

type ReportDecision = {
  action: "ADJUST" | "KEEP";
  reason: string;
  note?: string | null;
  decidedByName?: string | null;
  autoApplied?: boolean | null;
  finalQty?: number | null;
  diffQty?: number | null;
  value?: string | null;
} | null;

type ReportRow = {
  variantId: number;
  productName: string;
  variantName?: string | null;
  sku?: string | null;
  baseUnit?: string | null;
  expectedQty?: number;
  rawCount?: number | null;
  netAfter?: number;
  adjustedCount?: number | null;
  bookNow?: number;
  diff?: number | null;
  value?: string | null;
  decision: ReportDecision;
};

type ReportData = {
  session: {
    id: number;
    code: string;
    name: string;
    branchName?: string | null;
    scopeType?: string | null;
    scopeLabel?: string | null;
    status: string;
    blind?: boolean;
    thresholdPct?: string | number | null;
    thresholdValue?: string | number | null;
    dualThreshold?: string | number | null;
    createdAt?: string | null;
    createdByName?: string | null;
    submittedAt?: string | null;
    firstSign?: { byName: string; at?: string | null } | null;
    approved?: { byName: string; at?: string | null } | null;
  };
  assignments?: { name: string; zone?: string | null }[];
  rows: ReportRow[];
};

// ─── أدوات عرض ───

const dOnly = (v?: string | Date | null): string =>
  v ? new Date(v).toLocaleDateString("ar-IQ-u-nu-latn", { dateStyle: "medium" }) : "—";
const dts = (v?: string | Date | null): string =>
  v ? new Date(v).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "medium", timeStyle: "short" }) : "—";

const signedInt = (n: number): string =>
  n > 0 ? `+${fmtInt(n)}` : n < 0 ? `−${fmtInt(Math.abs(n))}` : "0";

/** مبلغ مُشار بدقّة decimal (عرض فقط). */
const signedMoney = (v: string | number | null | undefined): string => {
  const dv = D(v ?? 0);
  const s = `${fmt(dv.abs().toFixed(2))} د.ع`;
  return dv.isNegative() ? `−${s}` : dv.gt(0) ? `+${s}` : s;
};

const decisionLabelOf = (r: ReportRow): string => {
  const dn = r.decision;
  if (!dn) return "—";
  const base = dn.autoApplied || !dn.decidedByName ? "تسوية تلقائية ضمن الحدّ" : `تسوية بقرار: ${dn.decidedByName}`;
  return dn.note ? `${base} — ${dn.note}` : base;
};

export default function StocktakeReport() {
  const params = useParams();
  const sessionId = Number(params.id);
  const q = trpc.stocktakes.report.useQuery({ sessionId }, { enabled: Number.isFinite(sessionId) });
  const data = q.data as unknown as ReportData | undefined;

  // إعادة احتساب أقسام المحضر من الصفوف (decimal.js للمجاميع المالية — العقد §٢ و§٦ خطوة القيد)
  const calc = useMemo(() => {
    if (!data) return null;
    const diffOf = (r: ReportRow): number => r.decision?.diffQty ?? r.diff ?? 0;
    const finalOf = (r: ReportRow): number => r.decision?.finalQty ?? r.adjustedCount ?? r.rawCount ?? 0;
    const valueOf = (r: ReportRow): string | number => r.decision?.value ?? r.value ?? 0;
    const bookOf = (r: ReportRow): number =>
      r.decision?.finalQty != null && r.decision?.diffQty != null
        ? r.decision.finalQty - r.decision.diffQty
        : r.bookNow ?? 0;

    const counted = data.rows.filter((r) => r.rawCount != null || r.decision != null);
    const adjusted = counted.filter((r) => r.decision?.action === "ADJUST" && diffOf(r) !== 0);
    const kept = counted.filter((r) => r.decision?.action === "KEEP" && diffOf(r) !== 0);
    const matched = counted.filter((r) => diffOf(r) === 0);
    const over = counted.filter((r) => diffOf(r) > 0).length;
    const short = counted.filter((r) => diffOf(r) < 0).length;

    const netValue = round2(counted.reduce((a, r) => a.plus(D(valueOf(r))), D(0))).toFixed(2);
    const adjNetQty = adjusted.reduce((a, r) => a + diffOf(r), 0);
    const adjNetValue = round2(adjusted.reduce((a, r) => a.plus(D(valueOf(r))), D(0))).toFixed(2);
    const shortExpense = round2(
      adjusted.filter((r) => diffOf(r) < 0).reduce((a, r) => a.plus(D(valueOf(r)).abs()), D(0)),
    ).toFixed(2);
    const overGain = round2(
      adjusted.filter((r) => diffOf(r) > 0).reduce((a, r) => a.plus(D(valueOf(r))), D(0)),
    ).toFixed(2);

    const reasonMap = new Map<string, { n: number; qty: number; value: ReturnType<typeof D> }>();
    for (const r of adjusted) {
      const key = r.decision?.reason ?? "UNSPECIFIED";
      const cur = reasonMap.get(key) ?? { n: 0, qty: 0, value: D(0) };
      cur.n += 1;
      cur.qty += diffOf(r);
      cur.value = cur.value.plus(D(valueOf(r)));
      reasonMap.set(key, cur);
    }
    const byReason = Array.from(reasonMap.entries()).map(([k, v]) => ({
      reason: k,
      label: STOCKTAKE_REASON_LABEL[k] ?? k,
      n: v.n,
      qty: v.qty,
      value: round2(v.value).toFixed(2),
    }));

    const iraPct = counted.length ? ((matched.length / counted.length) * 100).toFixed(1) : null;

    return {
      diffOf, finalOf, valueOf, bookOf,
      counted, adjusted, kept, matched, over, short,
      netValue, adjNetQty, adjNetValue, shortExpense, overGain, byReason, iraPct,
    };
  }, [data]);

  if (!Number.isFinite(sessionId)) return <div className="p-10 text-center text-muted-foreground">جلسة غير صالحة.</div>;
  if (q.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (q.error) return <div className="p-10 text-center text-destructive">تعذّر تحميل المحضر: {q.error.message}</div>;
  if (!data || !calc) return <div className="p-10 text-center text-muted-foreground">الجلسة غير موجودة.</div>;

  const s = data.session;
  const scopeLabel = s.scopeLabel ?? STOCKTAKE_SCOPE_LABEL[s.scopeType ?? ""] ?? s.scopeType ?? "—";
  const statusLabel = STOCKTAKE_STATUS_LABEL[s.status] ?? s.status;
  const workerNames = (data.assignments ?? []).map((a) => a.name);

  function doPrint() {
    if (!data || !calc) return;
    printStocktakeReport({
      code: s.code,
      name: s.name,
      branchName: s.branchName ?? "—",
      scopeLabel,
      blind: s.blind ?? true,
      thresholdPct: s.thresholdPct ?? 0,
      thresholdValue: s.thresholdValue ?? 0,
      dualThreshold: s.dualThreshold,
      createdByName: s.createdByName,
      createdAt: s.createdAt,
      submittedAt: s.submittedAt,
      firstSignByName: s.firstSign?.byName ?? null,
      firstSignAt: s.firstSign?.at ?? null,
      approvedByName: s.approved?.byName ?? null,
      approvedAt: s.approved?.at ?? null,
      workerNames,
      stats: {
        counted: calc.counted.length,
        matched: calc.matched.length,
        over: calc.over,
        short: calc.short,
        netValue: calc.netValue,
      },
      adjusted: calc.adjusted.map((r) => ({
        productName: r.productName,
        variantName: r.variantName,
        sku: r.sku,
        baseUnit: r.baseUnit,
        bookQty: calc.bookOf(r),
        adjustedQty: calc.finalOf(r),
        diff: calc.diffOf(r),
        value: calc.valueOf(r),
        reasonLabel: STOCKTAKE_REASON_LABEL[r.decision?.reason ?? "UNSPECIFIED"] ?? "غير محدد",
        decisionLabel: decisionLabelOf(r),
      })),
      adjustedNetQty: calc.adjNetQty,
      adjustedNetValue: calc.adjNetValue,
      kept: calc.kept.map((r) => ({
        productName: r.productName,
        variantName: r.variantName,
        diff: calc.diffOf(r),
        decisionLabel: `قرار: ${r.decision?.decidedByName ?? "—"}${r.decision?.note ? ` — ${r.decision.note}` : ""}`,
      })),
      matchedNames: calc.matched.map((r) => `${r.productName}${r.variantName ? ` ${r.variantName}` : ""}`),
      byReason: calc.byReason.map((r) => ({ reasonLabel: r.label, itemCount: r.n, netQty: r.qty, netValue: r.value })),
      ledger: { shortExpense: calc.shortExpense, overGain: calc.overGain },
      ira: { pct: calc.iraPct, matched: calc.matched.length, counted: calc.counted.length },
    });
  }

  const waMessage = [
    `📋 *محضر جرد وتسوية — ${s.code}*`,
    `🏪 المكتبة العربية — ${s.branchName ?? "—"}`,
    `🗂 ${s.name} (${scopeLabel})`,
    s.approved ? `📅 اعتُمد: ${dts(s.approved.at)} (${s.approved.byName})` : `⏳ الحالة: ${statusLabel}`,
    "",
    `✅ معدودة: ${fmtInt(calc.counted.length)} · مطابقة: ${fmtInt(calc.matched.length)}`,
    `🔺 زيادة: ${fmtInt(calc.over)} · 🔻 نقص: ${fmtInt(calc.short)}`,
    `💰 صافي قيمة التسوية: ${signedMoney(calc.netValue)}`,
    calc.iraPct != null ? `🎯 دقة المخزون (IRA): ${calc.iraPct}٪` : "",
  ].filter(Boolean).join("\n");

  return (
    <div className="space-y-4 max-w-5xl">
      {/* شريط الإجراءات */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">محضر جرد وتسوية</h1>
          <Badge variant={s.status === "APPROVED" ? "default" : "secondary"}>{statusLabel}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/stocktakes/${sessionId}/review`}>
            <Button variant="outline">← رجوع للمراجعة</Button>
          </Link>
          <Link href="/stocktakes">
            <Button variant="outline">قائمة الجلسات</Button>
          </Link>
          <WhatsAppShare message={waMessage} label="مشاركة الملخص" size="default" />
          <Button
            variant="outline"
            size="sm"
            disabled={!calc.adjusted.length}
            onClick={() =>
              exportRows(calc.adjusted, {
                filename: `محضر-جرد-${s.code || ""}`,
                columns: [
                  {
                    key: "name",
                    header: "الصنف",
                    map: (r) => `${r.productName}${r.variantName ? ` — ${r.variantName}` : ""}`,
                  },
                  { key: "sku", header: "SKU", map: (r) => r.sku ?? "" },
                  { key: "book", header: "الرصيد الدفتري", map: (r) => calc.bookOf(r) },
                  { key: "actual", header: "المعدود المصحَّح", map: (r) => calc.finalOf(r) },
                  { key: "diff", header: "الفرق", map: (r) => calc.diffOf(r) },
                  {
                    key: "reason",
                    header: "السبب",
                    map: (r) => STOCKTAKE_REASON_LABEL[r.decision?.reason ?? "UNSPECIFIED"] ?? "غير محدد",
                  },
                  { key: "value", header: "قيمة الفرق", map: (r) => Number(calc.valueOf(r)) },
                ],
              })
            }
          >
            تصدير Excel
          </Button>
          <Button onClick={doPrint}>🖨 طباعة المحضر</Button>
        </div>
      </div>

      {s.status !== "APPROVED" && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          الجلسة {statusLabel} — هذا المحضر مسودّة معاينة قبل الاعتماد النهائي.
        </p>
      )}

      {/* الوثيقة */}
      <div className="mx-auto rounded-xl border bg-card p-8 shadow-sm">
        {/* ترويسة */}
        <div className="flex items-start justify-between border-b-2 border-foreground pb-4">
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-lg bg-primary text-xl font-bold text-primary-foreground">ر</div>
            <div>
              <p className="text-lg font-bold">الرؤية العربية للتجارة العامة</p>
              <p className="text-xs text-muted-foreground">المكتبة العربية للطباعة والقرطاسية — {s.branchName ?? "—"}</p>
            </div>
          </div>
          <div className="text-left">
            <p className="text-xl font-bold">محضر جرد وتسوية</p>
            <p className="font-mono text-sm text-muted-foreground" dir="ltr">{s.code}</p>
          </div>
        </div>

        {/* بيانات الجلسة */}
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-3">
          {[
            ["الجلسة", s.name],
            ["النطاق", scopeLabel],
            ["طريقة العدّ", (s.blind ?? true) ? "جرد أعمى" : "عدّ مكشوف"],
            ["أنشأها", `${s.createdByName ?? "—"} · ${dOnly(s.createdAt)}`],
            ["عمّال الجرد", workerNames.length ? workerNames.join("، ") : "—"],
            ["تسليم العدّ", dts(s.submittedAt)],
            ["التوقيع الأول", s.firstSign ? `${s.firstSign.byName} · ${dts(s.firstSign.at)}` : "—"],
            ["اعتمدها", s.approved ? `${s.approved.byName} · ${dts(s.approved.at)}` : "—"],
            ["الحدود", `${fmtInt(Number(s.thresholdPct ?? 0))}٪ أو ${fmt(s.thresholdValue ?? 0)} د.ع · توقيعان فوق ${fmt(s.dualThreshold ?? 0)} د.ع`],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-dashed py-1">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-semibold text-left">{v}</dd>
            </div>
          ))}
        </dl>

        {/* ملخص */}
        <div className="mt-5 grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
          {[
            ["أصناف معدودة", fmtInt(calc.counted.length)],
            ["مطابقة", fmtInt(calc.matched.length)],
            ["زيادة", fmtInt(calc.over)],
            ["نقص", fmtInt(calc.short)],
            ["صافي قيمة التسوية", signedMoney(calc.netValue)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border bg-muted/40 px-2 py-2.5">
              <p className="text-[11px] text-muted-foreground">{k}</p>
              <p className="mt-0.5 text-base font-bold tabular-nums" dir="ltr">{v}</p>
            </div>
          ))}
        </div>

        {/* أولاً — الفروقات المُسوّاة */}
        <h3 className="mb-2 mt-6 text-sm font-bold">أولاً — الفروقات المُسوّاة ({fmtInt(calc.adjusted.length)})</h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y-2 border-foreground text-right text-xs">
              <th className="py-1.5 pl-2 font-bold">الصنف</th>
              <th className="px-2 py-1.5 text-center font-bold">الدفتري</th>
              <th className="px-2 py-1.5 text-center font-bold">المعدود المصحَّح</th>
              <th className="px-2 py-1.5 text-center font-bold">الفرق</th>
              <th className="px-2 py-1.5 text-center font-bold">قيمة الفرق</th>
              <th className="px-2 py-1.5 font-bold">السبب</th>
              <th className="py-1.5 pr-2 font-bold">القرار</th>
            </tr>
          </thead>
          <tbody>
            {calc.adjusted.map((r) => {
              const diff = calc.diffOf(r);
              return (
                <tr key={r.variantId} className="border-b">
                  <td className="py-1.5 pl-2">
                    {r.productName}{r.variantName ? ` — ${r.variantName}` : ""}{r.baseUnit ? <span className="text-xs text-muted-foreground"> ({r.baseUnit})</span> : null}{" "}
                    <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">{r.sku ?? ""}</span>
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono tabular-nums" dir="ltr">{fmtInt(calc.bookOf(r))}</td>
                  <td className="px-2 py-1.5 text-center font-mono tabular-nums" dir="ltr">{fmtInt(calc.finalOf(r))}</td>
                  <td className={`px-2 py-1.5 text-center font-mono font-bold tabular-nums ${diff < 0 ? "text-rose-700" : "text-blue-700"}`} dir="ltr">
                    {signedInt(diff)}
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono tabular-nums" dir="ltr">{signedMoney(calc.valueOf(r))}</td>
                  <td className="px-2 py-1.5 text-xs">{STOCKTAKE_REASON_LABEL[r.decision?.reason ?? "UNSPECIFIED"] ?? "غير محدد"}</td>
                  <td className="py-1.5 pr-2 text-xs">{decisionLabelOf(r)}</td>
                </tr>
              );
            })}
            {calc.adjusted.length === 0 && (
              <tr><td colSpan={7} className="py-3 text-center text-muted-foreground">لا تسويات — الجرد مطابق.</td></tr>
            )}
          </tbody>
          {calc.adjusted.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-foreground font-bold">
                <td className="py-2 pl-2" colSpan={3}>صافي قيمة التسوية (بالتكلفة)</td>
                <td className="px-2 py-2 text-center font-mono tabular-nums" dir="ltr">{signedInt(calc.adjNetQty)}</td>
                <td className="px-2 py-2 text-center font-mono tabular-nums" dir="ltr">{signedMoney(calc.adjNetValue)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          )}
        </table>

        {/* ثانياً — فروقات أُبقي رصيدها */}
        {calc.kept.length > 0 && (
          <>
            <h3 className="mb-2 mt-5 text-sm font-bold">ثانياً — فروقات أُبقي رصيدها الدفتري ({fmtInt(calc.kept.length)})</h3>
            <table className="w-full border-collapse text-sm">
              <tbody>
                {calc.kept.map((r) => (
                  <tr key={r.variantId} className="border-b">
                    <td className="py-1.5 pl-2">{r.productName}{r.variantName ? ` — ${r.variantName}` : ""}</td>
                    <td className="px-2 py-1.5 text-center font-mono tabular-nums" dir="ltr">{signedInt(calc.diffOf(r))}</td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">
                      قرار: {r.decision?.decidedByName ?? "—"}{r.decision?.note ? ` — ${r.decision.note}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {/* الأصناف المطابقة */}
        <h3 className="mb-2 mt-5 text-sm font-bold">
          {calc.kept.length > 0 ? "ثالثاً" : "ثانياً"} — الأصناف المطابقة ({fmtInt(calc.matched.length)})
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {calc.matched.map((r) => `${r.productName}${r.variantName ? ` ${r.variantName}` : ""}`).join(" · ") || "—"}
        </p>

        {/* تحليل الانكماش حسب السبب */}
        {calc.byReason.length > 0 && (
          <>
            <h3 className="mb-2 mt-6 text-sm font-bold">تحليل الفروقات حسب السبب (الانكماش)</h3>
            <table className="w-full max-w-lg border-collapse text-sm">
              <thead>
                <tr className="border-y-2 border-foreground text-right text-xs">
                  <th className="py-1.5 pl-2 font-bold">السبب</th>
                  <th className="px-2 py-1.5 text-center font-bold">أصناف</th>
                  <th className="px-2 py-1.5 text-center font-bold">صافي الكمية</th>
                  <th className="px-2 py-1.5 text-center font-bold">صافي القيمة</th>
                </tr>
              </thead>
              <tbody>
                {calc.byReason.map((r) => (
                  <tr key={r.reason} className="border-b">
                    <td className="py-1.5 pl-2">{r.label}</td>
                    <td className="px-2 py-1.5 text-center tabular-nums">{fmtInt(r.n)}</td>
                    <td className="px-2 py-1.5 text-center font-mono tabular-nums" dir="ltr">{signedInt(r.qty)}</td>
                    <td className="px-2 py-1.5 text-center font-mono tabular-nums" dir="ltr">{signedMoney(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {/* القيد المحاسبي + IRA */}
        <div className="mt-5 grid gap-3 sm:grid-cols-[1.5fr_1fr]">
          <div className="rounded-lg border bg-muted/40 p-3.5">
            <p className="mb-1.5 text-sm font-bold">
              القيد المحاسبي الآلي (مرجع <span className="font-mono" dir="ltr">{s.code}</span>)
            </p>
            {D(calc.shortExpense).gt(0) || D(calc.overGain).gt(0) ? (
              <div className="max-w-md space-y-1 text-sm">
                {D(calc.shortExpense).gt(0) && (
                  <p className="flex justify-between">
                    <span>مصروف عجز مخزون (مدين)</span>
                    <span className="font-mono font-bold text-rose-700" dir="ltr">{fmt(calc.shortExpense)} د.ع</span>
                  </p>
                )}
                {D(calc.overGain).gt(0) && (
                  <p className="flex justify-between">
                    <span>تسوية زيادة مخزون (دائن)</span>
                    <span className="font-mono font-bold text-emerald-700" dir="ltr">{fmt(calc.overGain)} د.ع</span>
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">لا قيد محاسبياً — لا فروقات مُسوّاة بقيمة.</p>
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              العجز يظهر مصروفاً صريحاً في الدفتر — لا يُدفن في التسوية، فتبقى الأرباح صادقة.
            </p>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3.5 text-center dark:border-emerald-800 dark:bg-emerald-950">
            <p className="text-xs text-muted-foreground">مؤشر دقة المخزون (IRA) لهذه الجلسة</p>
            <p className="mt-1 text-2xl font-black text-emerald-700 dark:text-emerald-400" dir="ltr">
              {calc.iraPct != null ? `${calc.iraPct}٪` : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              مطابقة {fmtInt(calc.matched.length)} من {fmtInt(calc.counted.length)} معدودة
            </p>
          </div>
        </div>

        <p className="mt-5 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
          نُفّذت التسوية بحركات ADJUST ذرّية بمرجع <span className="font-mono" dir="ltr">{s.code}</span> في سجلّ
          حركات المخزون، وحُدِّثت الأرصدة لحظة الاعتماد. الحدّ المعتمد للتسوية المباشرة:{" "}
          {fmtInt(Number(s.thresholdPct ?? 0))}٪ أو {fmt(s.thresholdValue ?? 0)} د.ع. الحركات الواقعة بعد عدّ أي صنف
          صُحِّحت آلياً قبل احتساب الفرق.
        </p>

        {/* تواقيع */}
        <div className="mt-10 grid grid-cols-3 gap-8 text-center text-sm">
          {[
            ["عدّ وأعدّ", workerNames.length ? workerNames.join("، ") : "—", dts(s.submittedAt)],
            [
              "توقيع أول (راجع ودقّق)",
              s.firstSign?.byName ?? s.approved?.byName ?? "—",
              s.firstSign ? dts(s.firstSign.at) : s.approved ? dts(s.approved.at) : "",
            ],
            ["توقيع نهائي (اعتمد)", s.approved?.byName ?? "—", s.approved ? dts(s.approved.at) : ""],
          ].map(([k, who, when]) => (
            <div key={k}>
              <p className="font-bold">{k}</p>
              <p className="mt-1 text-xs text-muted-foreground">{who}</p>
              {when ? <p className="text-[10px] text-muted-foreground">{when}</p> : null}
              <div className="mt-10 border-t border-foreground pt-1 text-xs text-muted-foreground">التوقيع</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
