// تقرير التغييرات الوظيفية — قائمتا الترقيات وإنهاء الخدمات في قسمين.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). يكشف رواتب/تسويات ⇒ صلاحية hr/READ خادمياً.
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Data = RouterOutputs["promotions"]["report"];
type Promo = Data["promotions"][number];
type Term = Data["terminations"][number];

const PROMO_STATUS_LABEL: Record<string, string> = { pending: "معلّق", approved: "معتمد" };
const TERM_STATUS_LABEL: Record<string, string> = { pending: "معلّق", completed: "مكتمل" };
const STATUS_CLS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  completed: "bg-emerald-100 text-emerald-700",
};

export default function HrChangesReport() {
  const q = trpc.promotions.report.useQuery();

  const promotions = q.data?.promotions ?? [];
  const terminations = q.data?.terminations ?? [];
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
      {/* الترقيات */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2.5 text-sm font-semibold">الترقيات</div>
          {q.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !promotions.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">لا ترقيات مسجّلة.</p>
          ) : (
            <div className="overflow-x-auto">
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
                      <td className="p-2.5 text-right">{p.employeeName}</td>
                      <td className="p-2.5 text-right text-muted-foreground">{p.fromTitle ?? "—"}</td>
                      <td className="p-2.5 text-right font-medium">{p.toTitle}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{p.effectiveDate}</td>
                      <td className="p-2.5 text-right">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[p.status] ?? "bg-muted"}`}>
                          {PROMO_STATUS_LABEL[p.status] ?? p.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* إنهاء الخدمات */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2.5 text-sm font-semibold">إنهاء الخدمات</div>
          {q.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !terminations.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">لا حالات إنهاء خدمة مسجّلة.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الموظف</th>
                    <th className="p-2.5 text-right font-medium">النوع</th>
                    <th className="p-2.5 text-right font-medium">آخر يوم عمل</th>
                    <th className="p-2.5 text-left font-medium">التسوية</th>
                    <th className="p-2.5 text-right font-medium">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {terminations.map((t, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">{t.employeeName}</td>
                      <td className="p-2.5 text-right">{t.type}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{t.lastDay}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(t.settlement)}</td>
                      <td className="p-2.5 text-right">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[t.status] ?? "bg-muted"}`}>
                          {TERM_STATUS_LABEL[t.status] ?? t.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
