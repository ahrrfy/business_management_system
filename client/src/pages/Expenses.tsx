import { RowActions } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { fmt } from "@/lib/money";
import { printDoc } from "@/lib/printing/print";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const CATEGORY_LABEL: Record<string, string> = {
  RENT: "إيجار",
  UTILITIES: "خدمات/فواتير",
  SUPPLIES: "لوازم",
  SALARY: "مرتبات",
  TRANSPORT: "مواصلات/شحن",
  MAINTENANCE: "صيانة",
  MARKETING: "تسويق",
  OTHER: "أخرى",
};

const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
};

// production-slice: مصدر الصرف من المخزون (نثرية/تلف) بدل طريقة الدفع.
const STOCK_REASON_LABEL: Record<string, string> = {
  INTERNAL_USE: "نثرية (مخزون)",
  WASTAGE: "تلف (مخزون)",
};
function sourceLabel(r: { source?: string | null; stockReason?: string | null; paymentMethod: string }) {
  if (r.source === "STOCK") return STOCK_REASON_LABEL[r.stockReason ?? ""] ?? "مخزون";
  return METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod;
}

const STATUS_CLS: Record<string, string> = {
  ACTIVE: "badge-status-active",
  CANCELLED: "badge-status-cancelled",
};
const STATUS_LABEL: Record<string, string> = { ACTIVE: "نافذ", CANCELLED: "مُلغى" };

type ExpenseRow = RouterOutputs["expenses"]["list"]["rows"][number];

/** إيصال صرف عبر printDoc العام — نفس نواقل الطباعة الثلاثة (جسر الخادم/WebUSB/متصفح). */
async function printExpenseReceipt(r: ExpenseRow) {
  await printDoc({
    kind: "receipt",
    title: "الرؤية العربية",
    subtitle: "إيصال صرف — مصروف",
    meta: [
      `مصروف #${Number(r.id)}`,
      `التاريخ: ${r.expenseDate ? new Date(r.expenseDate as unknown as string).toISOString().slice(0, 10) : "—"}`,
      `الفرع: ${r.branchName ?? "—"}`,
      `الفئة: ${CATEGORY_LABEL[r.category] ?? r.category}`,
      `طريقة الدفع: ${METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}`,
      ...(r.description ? [`البيان: ${r.description}`] : []),
      // إيصال مصروف مُلغى يحمل حالته صراحةً — لا يُقرأ كصرف نافذ بالخطأ.
      ...(r.status !== "ACTIVE" ? [`الحالة: ${STATUS_LABEL[r.status] ?? r.status}`] : []),
    ],
    totals: [{ label: "المبلغ", value: fmt(r.amount) }],
    footer: "إيصال صرف داخلي",
  });
}

export default function Expenses() {
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const [category, setCategory] = useState<string>("");
  const [status, setStatus] = useState<string>("ACTIVE");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const list = trpc.expenses.list.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    category: (category || undefined) as any,
    status: (status || undefined) as any,
    from: from || undefined,
    to: to || undefined,
    limit: 300,
  });

  const cancel = trpc.expenses.cancel.useMutation({
    onSuccess: async () => {
      await utils.expenses.list.invalidate();
    },
  });

  // أموال العرض عبر fmt من @/lib/money (فواصل آلاف + منزلتان) — بديل الدالة المحلية السابقة.
  return (
    <div className="space-y-4">
      <PageHeader
        title="المصروفات اليومية"
        description="كل مصروف يولّد قبضاً صادراً (يُخصم من صندوق الوردية إن كانت مفتوحة) وقيداً في الدفتر."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!list.data?.rows?.length}
              onClick={() => exportRows(list.data?.rows ?? [], {
                filename: "المصروفات",
                columns: [
                  { key: "expenseDate", header: "التاريخ", map: (r) => r.expenseDate ? new Date(r.expenseDate as unknown as string).toLocaleDateString("ar-IQ-u-nu-latn") : "" },
                  { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
                  { key: "category", header: "الفئة", map: (r) => CATEGORY_LABEL[r.category] ?? r.category },
                  { key: "description", header: "الوصف", map: (r) => r.description ?? "" },
                  { key: "paymentMethod", header: "طريقة الدفع", map: (r) => METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod },
                  { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
                  { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
                ],
              })}
            >تصدير Excel</Button>
            <Link href="/expenses/new"><Button>+ مصروف جديد</Button></Link>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3 items-start">
        <Card className="lg:col-span-2">
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 pt-6">
            <div className="space-y-1">
              <Label className="text-xs">الفرع</Label>
              <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— كل الفروع —</option>
                {(branches.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">الفئة</Label>
              <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">— كل الفئات —</option>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">الحالة</Label>
              <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">— الكل —</option>
                <option value="ACTIVE">نافذ</option>
                <option value="CANCELLED">مُلغى</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">من تاريخ</Label>
              <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">إلى تاريخ</Label>
              <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground">عدد السطور</div>
              <div className="text-lg font-semibold">{list.data?.totals.count ?? 0}</div>
            </div>
            <div>
              <div className="text-muted-foreground">إجمالي النافذ</div>
              <div className="text-lg font-semibold tabular-nums" dir="ltr">{fmt(list.data?.totals.active ?? "0")}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">التاريخ</th>
                <th className="p-2">الفرع</th>
                <th className="p-2">الفئة</th>
                <th className="p-2">الوصف</th>
                <th className="p-2">الدفع / المصدر</th>
                <th className="p-2 text-right">المبلغ</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.rows ?? []).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 text-xs" dir="ltr">{r.expenseDate ? new Date(r.expenseDate as any).toISOString().slice(0, 10) : "—"}</td>
                  <td className="p-2">{r.branchName ?? "—"}</td>
                  <td className="p-2">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="p-2 max-w-xs truncate" title={r.description ?? ""}>{r.description ?? "—"}</td>
                  <td className="p-2">{sourceLabel(r)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.amount)}</td>
                  <td className="p-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <RowActions
                      actions={[
                        {
                          key: "print",
                          label: "طباعة إيصال صرف",
                          onSelect: () => void printExpenseReceipt(r),
                        },
                        {
                          key: "cancel",
                          label: "إلغاء",
                          variant: "destructive",
                          hidden: r.status !== "ACTIVE", // لا حذف صلب — الإلغاء يعكس الصندوق
                          disabled: cancel.isPending,
                          onSelect: () => void (async () => {
                            if (!(await confirm({
                              variant: "warning",
                              title: "إلغاء المصروف",
                              description: r.source === "STOCK"
                                ? `ستُعاد المنتجات (${fmt(r.amount)} د.ع كلفةً) إلى المخزون ويُعكس القيد. هل تتابع؟`
                                : `سيُعكس مبلغ ${fmt(r.amount)} د.ع إلى الصندوق ويُسجَّل قيد ADJUST سالب. هل تتابع؟`,
                              confirmText: "إلغاء المصروف",
                              cancelText: "تراجع",
                            }))) return;
                            cancel.mutate({ expenseId: Number(r.id) });
                          })(),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {list.data && list.data.rows.length === 0 && (
                <TableEmptyRow colSpan={8} message="لا مصروفات لهذا الفلتر." />
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {cancel.error && <p className="text-sm text-destructive">{cancel.error.message}</p>}
    </div>
  );
}
