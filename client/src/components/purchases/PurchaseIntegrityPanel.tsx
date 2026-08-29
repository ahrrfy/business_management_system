import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { WorkspaceBar } from "@/components/workspace/OperationalWorkspace";

type IntegrityReport = RouterOutputs["purchases"]["integrityReport"];
type Finding = IntegrityReport["findings"][number];

const PAGE_SIZE = 100;

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  CRITICAL: "حرج",
  HIGH: "عالٍ",
  MEDIUM: "متوسط",
  INFO: "معلومة",
};

const SEVERITY_CLASS: Record<Finding["severity"], string> = {
  CRITICAL: "border-[var(--sem-neg)] bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
  HIGH: "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  MEDIUM: "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  INFO: "border-slate-400 bg-slate-50 text-slate-800",
};

const CODE_LABEL: Record<Finding["code"], string> = {
  CASH_RECEIVED_PAYMENT_COVERAGE_GAP: "شراء نقدي مستلم بلا تغطية دفع",
  PAID_AMOUNT_GL_DRIFT: "اختلاف المدفوع المخزن عن القيود",
  NEGATIVE_PO_LEDGER_BALANCE: "رصيد دفتري سالب للأمر",
  PO_PAYMENT_OVER_ALLOCATION: "تخصيص دفع زائد للأمر",
  HISTORICAL_CREDIT_REVIEW_CANDIDATE: "شراء آجل تاريخي يحتاج مراجعة",
  STALE_PENDING_PO_PAYMENT: "طلب دفع معلق قديم",
  STALE_REJECTED_PO_PAYMENT: "طلب دفع مرفوض قديم",
  INVALID_PENDING_PO_PAYMENT: "طلب دفع معلق غير صالح",
  UNAPPROVED_PAYMENT_OUT_LEDGER_ENTRY: "قيد صرف غير معتمد",
  LEDGER_BRANCH_OR_SUPPLIER_MISMATCH: "عدم تطابق فرع أو مورد القيد",
  IDEMPOTENCY_CONFLICTING_PO_PAY_REFERENCE: "تعارض مرجع منع التكرار",
  DUPLICATE_PAYMENT_LEDGER_MATERIALIZATION: "تكرار ترحيل قيد الدفع",
  IDEMPOTENCY_RECEIPT_REF_REUSED: "إعادة استعمال مرجع إيصال",
};

function downloadReport(report: IntegrityReport) {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `purchase-integrity-branch-${report.branchId}-${report.generatedAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PurchaseIntegrityPanel({ branchId, requiresBranchSelection }: { branchId?: number; requiresBranchSelection: boolean }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);

  useEffect(() => setOffset(0), [branchId]);

  const report = trpc.purchases.integrityReport.useQuery(
    { branchId, limit: PAGE_SIZE, offset },
    {
      enabled: open && !requiresBranchSelection,
      refetchOnWindowFocus: false,
    },
  );

  const data = report.data;

  return (
    <Card className="gap-0 overflow-hidden border-slate-300 py-0">
      <WorkspaceBar variant="filters" label="سلامة المشتريات" className="rounded-none border-0">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-semibold">سلامة المشتريات</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">تدقيق قرائي للقيود المحاسبية من دون تغيير البيانات</span>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen((v) => !v)} className="h-8 shrink-0">
          {open ? "إغلاق" : "فتح التدقيق"}
        </Button>
      </WorkspaceBar>

      {open && (
        <CardContent className="space-y-4 border-t pt-4">
          {requiresBranchSelection ? (
            <p className="rounded border border-[var(--sem-warn)]/60 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
              اختر فرعاً محدداً من فلتر القائمة لتشغيل التقرير. القراءة المجمعة لكل الفروع ممنوعة.
            </p>
          ) : report.isLoading ? (
            <p className="text-sm text-muted-foreground">جارٍ فحص أوامر الشراء في الفرع…</p>
          ) : report.error ? (
            <p className="rounded border border-[var(--sem-neg)] bg-[var(--sem-neg-bg)] p-3 text-sm text-[var(--sem-neg)]">تعذّر تشغيل التقرير: {report.error.message}</p>
          ) : data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {(["CRITICAL", "HIGH", "MEDIUM", "INFO"] as const).map((severity) => (
                  <span key={severity} className={`rounded border px-3 py-1 text-xs font-semibold ${SEVERITY_CLASS[severity]}`}>
                    {SEVERITY_LABEL[severity]}: {data.summary.severityCounts[severity]}
                  </span>
                ))}
                <span className="text-xs text-muted-foreground">
                  الأوامر المتأثرة: {data.summary.affectedOrderCount} · النتائج: {data.summary.findingCount}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => void report.refetch()}>
                  تحديث
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => downloadReport(data)}>
                  تنزيل JSON
                </Button>
              </div>

              <div className="overflow-x-auto rounded border">
                <table className="w-full min-w-[850px] text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2 text-right">الخطورة</th>
                      <th className="p-2 text-right">أمر الشراء</th>
                      <th className="p-2 text-right">المورد</th>
                      <th className="p-2 text-right">المشكلة</th>
                      <th className="p-2 text-right">الدليل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.findings.map((finding) => (
                      <tr key={finding.id} className="border-t align-top">
                        <td className="p-2">
                          <span className={`inline-block rounded border px-2 py-0.5 text-xs ${SEVERITY_CLASS[finding.severity]}`}>{SEVERITY_LABEL[finding.severity]}</span>
                        </td>
                        <td className="p-2 font-medium" dir="ltr">
                          {finding.poNumber}
                        </td>
                        <td className="p-2">{finding.supplierName ?? `#${finding.supplierId}`}</td>
                        <td className="p-2">
                          <div className="font-medium">{CODE_LABEL[finding.code]}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{finding.summaryAr}</div>
                        </td>
                        <td className="p-2">
                          <details>
                            <summary className="cursor-pointer text-xs font-medium">عرض الدليل الخام</summary>
                            <pre className="mt-2 max-w-[34rem] overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[11px] text-slate-100" dir="ltr">
                              {JSON.stringify(finding.evidence, null, 2)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                    {data.findings.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-6 text-center text-muted-foreground">
                          لا توجد نتائج في هذه الصفحة.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  فُحص {data.page.scannedOrderCount} أمر · المصدر: القيود المحاسبية · الصفحة تبدأ من {data.page.offset + 1}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>
                    السابق
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={!data.page.hasMore} onClick={() => setOffset(data.page.nextOffset ?? offset)}>
                    التالي
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}
