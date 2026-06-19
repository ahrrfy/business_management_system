/**
 * موافقات الائتمان المُسبَقة — managerProcedure.
 * إنشاء موافقة (customer + maxAmount + ttl) ⇒ approvalId يستعمله الكاشير.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" });
}

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
      toast.success(`أُنشئت الموافقة #${r.id} — تنتهي ${fmtDateTime(r.expiresAt)}`);
      setCreatedId(r.id);
      utils.creditApproval.listForCustomer.invalidate();
      setMaxAmount("");
      setNotes("");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-4xl">
      <h1 className="text-2xl font-bold">موافقات الائتمان المُسبَقة</h1>
      <p className="text-sm text-muted-foreground">
        B5: لا تُقبل موافقة blanket في البيع. أنشئ صفّاً هنا ⇒ يحصل الكاشير على approvalId مرتبط بـ(عميل، مبلغ، انتهاء، single-use).
      </p>

      <Card>
        <CardHeader className="font-semibold">إنشاء موافقة جديدة</CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2">
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
                  className={`w-full text-right p-2 hover:bg-accent border-b text-sm ${customerId === Number(c.id) ? "bg-accent" : ""}`}
                >
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">رصيد: {c.currentBalance ?? "0.00"} د.ع</div>
                </button>
              )) : (
                <p className="p-2 text-sm text-muted-foreground">لا نتائج</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
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
          </div>

          <div className="grid gap-2">
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

          <Button
            onClick={() => {
              if (!customerId) return toast.error("اختر عميلاً");
              if (!/^\d+(\.\d{1,2})?$/.test(maxAmount)) return toast.error("سقف غير صالح");
              createMut.mutate({ customerId, maxAmount, ttlMinutes, notes: notes.trim() || undefined });
            }}
            disabled={createMut.isPending}
          >
            إنشاء الموافقة
          </Button>

          {createdId && (
            <div className="bg-green-50 text-green-900 p-3 rounded text-sm">
              ✓ approvalId = <span className="font-mono font-bold">{createdId}</span> — سلّم هذا الرقم للكاشير.
            </div>
          )}
        </CardContent>
      </Card>

      {customerId && (
        <Card>
          <CardHeader className="font-semibold">الموافقات النشِطة لهذا العميل</CardHeader>
          <CardContent>
            {active.isLoading ? (
              <p className="text-muted-foreground">جاري التحميل…</p>
            ) : (active.data?.rows.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-sm">لا موافقات نشِطة</p>
            ) : (
              <div className="space-y-2">
                {active.data!.rows.map((r: any) => (
                  <div key={r.id} className="border rounded p-2 text-sm grid grid-cols-3 gap-2">
                    <div><span className="text-muted-foreground">#</span> {r.id}</div>
                    <div><span className="text-muted-foreground">السقف:</span> {r.maxAmount}</div>
                    <div><span className="text-muted-foreground">ينتهي:</span> {fmtDateTime(r.expiresAt)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
