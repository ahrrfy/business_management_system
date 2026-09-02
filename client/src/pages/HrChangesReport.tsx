// تقرير التغييرات الوظيفية — قائمتا الترقيات وإنهاء الخدمات في قسمين.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). يكشف رواتب/تسويات ⇒ صلاحية hr/READ خادمياً.
import { useMemo, useState } from "react";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell } from "@/components/reports/ReportShell";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { FilterField } from "@/components/list";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Data = RouterOutputs["promotions"]["report"];
type Promo = Data["promotions"][number];
type Term = Data["terminations"][number];

const PROMO_STATUS_LABEL: Record<string, string> = { pending: "معلّق", approved: "معتمد" };
const TERM_STATUS_LABEL: Record<string, string> = { pending: "معلّق", completed: "مكتمل" };
const STATUS_CLS: Record<string, string> = {
  pending: "badge-stock-low",
  approved: "badge-status-active",
  completed: "badge-status-active",
};

export default function HrChangesReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const q = trpc.promotions.report.useQuery({ from: from || undefined, to: to || undefined });

  const allPromotions = q.data?.promotions ?? [];
  const allTerminations = q.data?.terminations ?? [];

  const matches = (v: string) => v.toLocaleLowerCase("ar").includes(query.trim().toLocaleLowerCase("ar"));
  const promotions = useMemo(
    () => (query.trim() ? allPromotions.filter((p) => [p.employeeName, p.fromTitle, p.toTitle].some((v) => matches(v ?? ""))) : allPromotions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allPromotions, query],
  );
  const terminations = useMemo(
    () => (query.trim() ? allTerminations.filter((t) => [t.employeeName, t.type].some((v) => matches(v ?? ""))) : allTerminations),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTerminations, query],
  );
  const hasAny = promotions.length > 0 || terminations.length > 0;

  function onExport() {
    // ورقة واحدة موحَّدة: عمود «النوع» يميّز الترقية عن إنهاء الخدمة.
    type ExportRow = {
      kind: string;
      employeeName: string;
      detail: string;
      date: string;
      amount: string;
      status: string;
    };
    const merged: ExportRow[] = [
      ...promotions.map((p) => ({
        kind: "ترقية",
        employeeName: p.employeeName,
        detail: `${p.fromTitle ?? "—"} ← ${p.toTitle}`,
        date: p.effectiveDate,
        amount: "",
        status: PROMO_STATUS_LABEL[p.status] ?? p.status,
      })),
      ...terminations.map((t) => ({
        kind: "إنهاء خدمة",
        employeeName: t.employeeName,
        detail: t.type,
        date: t.lastDay,
        amount: String(Number(t.settlement)),
        status: TERM_STATUS_LABEL[t.status] ?? t.status,
      })),
    ];
    exportRows(merged, {
      filename: "التغييرات-الوظيفية",
      columns: [
        { key: "kind", header: "النوع" },
        { key: "employeeName", header: "الموظف" },
        { key: "detail", header: "التفاصيل" },
        { key: "date", header: "التاريخ" },
        { key: "amount", header: "التسوية", map: (r) => (r.amount === "" ? "" : Number(r.amount)) },
        { key: "status", header: "الحالة" },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير التغييرات الوظيفية",
      columns: [
        { key: "kind", label: "النوع" },
        { key: "employeeName", label: "الموظف" },
        { key: "detail", label: "التفاصيل" },
        { key: "date", label: "التاريخ" },
        { key: "amount", label: "التسوية", align: "left" },
        { key: "status", label: "الحالة" },
      ],
      rows: [
        ...promotions.map((p) => ({
          kind: "ترقية",
          employeeName: p.employeeName,
          detail: `${p.fromTitle ?? "—"} ← ${p.toTitle}`,
          date: p.effectiveDate,
          amount: "—",
          status: PROMO_STATUS_LABEL[p.status] ?? p.status,
        })),
        ...terminations.map((t) => ({
          kind: "إنهاء خدمة",
          employeeName: t.employeeName,
          detail: t.type,
          date: t.lastDay,
          amount: fmtAr(t.settlement),
          status: TERM_STATUS_LABEL[t.status] ?? t.status,
        })),
      ],
    });
  }

  return (
    <ReportShell
      title="تقرير التغييرات الوظيفية"
      description="الترقيات وإنهاء الخدمات للموظفين."
      backHref="/reports"
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!hasAny}
      printDisabled={!hasAny}
    >
      {/* الفلاتر */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-2">
          <FilterField label="بحث" className="min-w-48">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="اسم الموظف أو المسمّى/النوع…" className="h-8" aria-label="بحث" />
          </FilterField>
          <FilterField label="من تاريخ">
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" aria-label="من تاريخ" />
          </FilterField>
          <FilterField label="إلى تاريخ">
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" aria-label="إلى تاريخ" />
          </FilterField>
          {(query || from || to) && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline"
              onClick={() => { setQuery(""); setFrom(""); setTo(""); }}
            >
              {FILTER_LABELS.reset}
            </button>
          )}
        </CardContent>
      </Card>

      {/* الترقيات */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2.5 text-sm font-semibold">الترقيات</div>
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
          ) : !promotions.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">لا ترقيات مسجّلة.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الموظف</th>
                    <th className="p-2.5 text-right font-medium">المسمّى السابق</th>
                    <th className="p-2.5 text-right font-medium">المسمّى الجديد</th>
                    <th className="p-2.5 text-right font-medium">تاريخ النفاذ</th>
                    <th className="p-2.5 text-right font-medium">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {promotions.map((p, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">
                        <Link href={`/hr/employees/${p.employeeId}`} className="font-medium hover:underline">{p.employeeName}</Link>
                      </td>
                      <td className="p-2.5 text-right text-muted-foreground">{p.fromTitle ?? "—"}</td>
                      <td className="p-2.5 text-right font-medium">{p.toTitle}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{p.effectiveDate}</td>
                      <td className="p-2.5 text-right">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[p.status] ?? "bg-muted text-muted-foreground"}`}>
                          {PROMO_STATUS_LABEL[p.status] ?? p.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>

      {/* إنهاء الخدمات */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2.5 text-sm font-semibold">إنهاء الخدمات</div>
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
          ) : !terminations.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">لا حالات إنهاء خدمة مسجّلة.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الموظف</th>
                    <th className="p-2.5 text-right font-medium">النوع</th>
                    <th className="p-2.5 text-right font-medium">آخر يوم عمل</th>
                    <th className="p-2.5 text-right font-medium">التسوية</th>
                    <th className="p-2.5 text-right font-medium">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {terminations.map((t, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">
                        <Link href={`/hr/employees/${t.employeeId}`} className="font-medium hover:underline">{t.employeeName}</Link>
                      </td>
                      <td className="p-2.5 text-right">{t.type}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{t.lastDay}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(t.settlement)}</td>
                      <td className="p-2.5 text-right">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[t.status] ?? "bg-muted text-muted-foreground"}`}>
                          {TERM_STATUS_LABEL[t.status] ?? t.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
