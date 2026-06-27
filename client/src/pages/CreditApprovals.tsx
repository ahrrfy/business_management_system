/**
 * موافقات الائتمان المُسبَقة — managerProcedure.
 * إنشاء موافقة (customer + maxAmount + ttl) ⇒ approvalId يستعمله الكاشير.
 */
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Check } from "lucide-react";
import { useState } from "react";

export default function CreditApprovalsPage() {
  const utils = trpc.useUtils();
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [maxAmount, setMaxAmount] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [notes, setNotes] = useState("");
  const [createdId, setCreatedId] = useState<number | null>(null);

  // قائمة عملاء سريعة للاختيار (search مع filter اسم)
  const customers = trpc.customers.search.useQuery({ q: customerSearch || undefined, limit: 20 });
  const active = trpc.creditApproval.listForCustomer.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: !!customerId },
  );

  const createMut = trpc.creditApproval.create.useMutation({
    onSuccess: (r) => {
      notify.ok(`أُنشئت الموافقة #${r.id} — تنتهي ${fmtDateTime(r.expiresAt)}`);
      setCreatedId(r.id);
      utils.creditApproval.listForCustomer.invalidate();
      setMaxAmount("");
      setNotes("");
    },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="container mx-auto p-4 space-y-4">
      <PageHeader
        title="موافقات الائتمان المُسبَقة"
        description="B5: لا تُقبل موافقة blanket في البيع. أنشئ صفّاً هنا ⇒ يحصل الكاشير على approvalId مرتبط بـ(عميل، مبلغ، انتهاء، single-use)."
      />

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <Card>
          <CardHeader className="font-semibold">إنشاء موافقة جديدة</CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2 items-start">
              <div className="grid gap-2 md:col-span-2">
                <label className="text-sm font-medium">العميل</label>
                <input
                  type="text"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="ابحث بالاسم أو الهاتف…"
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
                <div className="border rounded max-h-48 overflow-auto">
                  {customers.data?.rows?.length ? customers.data.rows.map((c: any) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCustomerId(Number(c.id))}
                      className={`w-full text-end p-2 hover:bg-accent border-b text-sm ${customerId === Number(c.id) ? "bg-accent" : ""}`}
                    >
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">رصيد: {fmtAr(c.currentBalance)} د.ع</div>
                    </button>
                  )) : (
                    <p className="p-2 text-sm text-muted-foreground">لا نتائج</p>
                  )}
                </div>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium">السقف (د.ع)</label>
                <input
                  type="text"
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(e.target.value)}
                  placeholder="مثل: 500000"
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">مدّة الصلاحية (دقيقة)</label>
                <input
                  type="number"
                  value={ttlMinutes}
                  min={1}
                  max={1440}
                  onChange={(e) => setTtlMinutes(Number(e.target.value) || 60)}
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
              </div>

              <div className="grid gap-2 md:col-span-2">
                <label className="text-sm font-medium">ملاحظات (اختياري)</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={255}
                  placeholder="سبب الموافقة…"
                  className="h-9 px-3 rounded-md border bg-transparent text-sm"
                />
              </div>
            </div>

            <Button
              onClick={async () => {
                if (!customerId) return notify.err("اختر عميلاً");
                if (!/^\d+(\.\d{1,2})?$/.test(maxAmount)) return notify.err("سقف غير صالح");
                const customerName =
                  customers.data?.rows?.find((c: any) => Number(c.id) === customerId)?.name ?? `#${customerId}`;
                if (
                  !(await confirm({
                    variant: "warning",
                    title: "إنشاء موافقة ائتمان",
                    description: `إنشاء موافقة ائتمان محدّدة المدّة للعميل «${customerName}» بسقف ${maxAmount} د.ع لمدّة ${ttlMinutes} دقيقة؟`,
                    confirmText: "إنشاء الموافقة",
                  }))
                )
                  return;
                createMut.mutate({ customerId, maxAmount, ttlMinutes, notes: notes.trim() || undefined });
              }}
              disabled={createMut.isPending}
            >
              إنشاء الموافقة
            </Button>

            {createdId && (
              <div className="badge-status-active p-3 rounded text-sm flex items-center gap-2">
                <Check aria-hidden className="size-4" />
                <span>approvalId = <span className="font-mono font-bold">{createdId}</span> — سلّم هذا الرقم للكاشير.</span>
              </div>
            )}
          </CardContent>
        </Card>

        {customerId && (
          <Card>
            <CardHeader className="font-semibold">الموافقات النشِطة لهذا العميل</CardHeader>
            <CardContent>
              {active.isLoading ? (
                <LoadingState />
              ) : (active.data?.rows.length ?? 0) === 0 ? (
                <p className="text-muted-foreground text-sm">لا موافقات نشِطة</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b text-muted-foreground text-end">
                        <th className="p-2 font-medium text-end">#</th>
                        <th className="p-2 font-medium text-end">السقف</th>
                        <th className="p-2 font-medium text-end">ينتهي</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.data!.rows.map((r: any) => (
                        <tr key={r.id} className="border-b last:border-0">
                          <td className="p-2 text-end">{r.id}</td>
                          <td className="p-2 text-end" dir="ltr">{r.maxAmount}</td>
                          <td className="p-2 text-end">{fmtDateTime(r.expiresAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
