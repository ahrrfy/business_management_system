import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ListToolbar } from "@/components/list";
import { fmtDate } from "@/lib/date";
import { CategoryIcon, StatCard, iqd } from "@/lib/assets/ui";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc } from "@/lib/trpc";
import { assetCategoryLabel } from "@shared/assets";
import { Archive, CircleSlash, TrendingDown, Wallet } from "lucide-react";
import { Link } from "wouter";

export default function AssetDisposalLog() {
  const q = trpc.assets.disposalLog.useQuery();

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const rows = q.data ?? [];

  const disposed = rows.filter((r) => r.status === "disposed");
  const retired = rows.filter((r) => r.status === "retired");
  const totalProceeds = disposed.reduce((s, r) => s + Number(r.proceeds ?? 0), 0);
  const netGain = disposed.reduce((s, r) => s + Number(r.gain ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ الاستبعاد والإخراج"
        actions={<Link href="/assets/register"><Button variant="outline" size="sm">سجلّ الأصول</Button></Link>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="مُستبعَد (بيع/خردة)" value={iqd(disposed.length)} icon={Archive} />
        <StatCard label="خارج الخدمة" value={iqd(retired.length)} icon={CircleSlash} />
        <StatCard label="إجمالي العائد" value={iqd(totalProceeds)} icon={Wallet} sub="د.ع" />
        <StatCard label="صافي الربح/الخسارة" value={iqd(netGain)} icon={TrendingDown} sub="للمُستبعَد (بيع/خردة) مقابل الدفترية" tone={netGain >= 0 ? "positive" : "negative"} />
      </div>

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={rows.length}
            onPrint={
              rows.length
                ? () =>
                    printReportDoc({
                      title: "سجلّ الاستبعاد والإخراج",
                      headerExtra: [
                        { label: "تاريخ التقرير", value: new Date().toLocaleDateString("ar-IQ-u-nu-latn") },
                      ],
                      columns: [
                        { key: "asset", label: "الأصل" },
                        { key: "type", label: "النوع" },
                        { key: "date", label: "التاريخ" },
                        { key: "purchase", label: "قيمة الشراء", align: "left" },
                        { key: "book", label: "القيمة الدفترية", align: "left" },
                        { key: "proceeds", label: "العوائد", align: "left" },
                        { key: "gain", label: "ربح/خسارة", align: "left" },
                      ],
                      rows: rows.map((r) => ({
                        asset: r.name,
                        type: r.status === "disposed" ? "مُستبعَد" : "خارج الخدمة",
                        date: r.disposalDate ? new Date(r.disposalDate).toLocaleDateString("ar-IQ-u-nu-latn") : "—",
                        purchase: iqd(r.purchaseValue),
                        book: iqd(r.bookValue),
                        proceeds: r.proceeds != null ? iqd(r.proceeds) : "—",
                        gain: r.gain != null ? `${Number(r.gain) >= 0 ? "+" : ""}${iqd(r.gain)}` : "—",
                      })),
                      summary: [
                        { label: "مُستبعَد (بيع/خردة)", value: iqd(disposed.length) },
                        { label: "خارج الخدمة", value: iqd(retired.length) },
                        { label: "إجمالي العوائد", value: `${iqd(totalProceeds)} د.ع` },
                        {
                          label: "صافي الربح/الخسارة",
                          value: `${netGain >= 0 ? "+" : ""}${iqd(netGain)} د.ع`,
                          large: true,
                          bold: true,
                        },
                      ],
                    })
                : undefined
            }
            printLabel="طباعة / PDF"
            exportSpec={{
              filename: "سجل_الاستبعاد",
              rows,
              columns: [
                { key: "code", header: "الرمز" },
                { key: "name", header: "الأصل" },
                { key: "status", header: "النوع", map: (r) => (r.status === "disposed" ? "مُستبعَد" : "خارج الخدمة") },
                { key: "disposalDate", header: "التاريخ", map: (r) => String(r.disposalDate ?? "") },
                { key: "purchaseValue", header: "قيمة الشراء", map: (r) => Number(r.purchaseValue) },
                { key: "bookValue", header: "الدفترية عند الإخراج", map: (r) => r.bookValue },
                { key: "proceeds", header: "العائد", map: (r) => (r.proceeds ?? "") },
                { key: "gain", header: "النتيجة", map: (r) => (r.gain ?? "") },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>
                <th className="p-2">الأصل</th>
                <th className="p-2 text-center">النوع</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2 text-left">قيمة الشراء</th>
                <th className="p-2 text-left">الدفترية عند الإخراج</th>
                <th className="p-2 text-left">العائد</th>
                <th className="p-2 text-left">النتيجة</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t hover:bg-accent/50">
                    <td className="p-2"><Link href={`/assets/${r.id}`} className="flex items-center gap-1.5 hover:text-primary"><CategoryIcon category={r.category} /><span><span className="font-medium">{r.name}</span> <span className="text-xs text-muted-foreground" dir="ltr">{r.code}</span><div className="text-xs text-muted-foreground">{assetCategoryLabel(r.category)}</div></span></Link></td>
                    <td className="p-2 text-center">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${r.status === "disposed" ? "badge-stock-out" : "badge-status-cancelled"}`}>{r.status === "disposed" ? "مُستبعَد" : "خارج الخدمة"}</span>
                    </td>
                    <td className="p-2 text-xs" dir="ltr">{fmtDate(r.disposalDate)}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(r.purchaseValue)}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(r.bookValue)}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{r.proceeds != null ? iqd(r.proceeds) : "—"}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">
                      {r.gain != null ? (
                        <span className={Number(r.gain) >= 0 ? "text-money-positive" : "text-money-negative"}>{Number(r.gain) >= 0 ? "+" : ""}{iqd(r.gain)}</span>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <TableEmptyRow colSpan={7} message="لا أصول مُستبعَدة أو خارج الخدمة." />}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
