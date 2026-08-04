/**
 * موافقات الائتمان المُسبَقة — managerProcedure.
 * إنشاء موافقة (customer + maxAmount + ttl) ⇒ approvalId يستعمله الكاشير.
 * تبويب «السجلّ»: كل الموافقات (كل العملاء/الحالات) — عرض + إلغاء موافقة لم تُستهلَك بعد.
 */
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Check, History, Plus, X } from "lucide-react";
import { useState } from "react";

type Tab = "create" | "log";
type ApprovalStatus = "" | "ACTIVE" | "EXPIRED" | "CONSUMED" | "CANCELLED";

const STATUS_LABEL: Record<Exclude<ApprovalStatus, "">, { label: string; cls: string }> = {
  ACTIVE: { label: "نشِطة", cls: "badge-status-active" },
  EXPIRED: { label: "منتهية", cls: "bg-muted text-muted-foreground" },
  CONSUMED: { label: "مُستهلَكة (فاتورة)", cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]" },
  CANCELLED: { label: "مُلغاة", cls: "bg-destructive/15 text-destructive" },
};

/** حالة مُشتقّة من نفس أعمدة الراوتر (لا حقل status في الردّ — نشتقّه هنا للعرض فقط). */
function deriveStatus(r: { expiresAt: string | Date; consumedAt: string | Date | null; consumedByInvoiceId: number | null }): Exclude<ApprovalStatus, ""> {
  if (r.consumedByInvoiceId != null) return "CONSUMED";
  if (r.consumedAt != null) return "CANCELLED";
  if (new Date(r.expiresAt).getTime() <= Date.now()) return "EXPIRED";
  return "ACTIVE";
}

export default function CreditApprovalsPage() {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<Tab>("create");
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
      utils.creditApproval.list.invalidate();
      setMaxAmount("");
      setNotes("");
    },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="container mx-auto p-4 space-y-4">
      <PageHeader
        title="موافقات الائتمان المُسبَقة"
        description="موافقة مؤقتة محددة السقف والمدة تُستعمل مرة واحدة — سلّم رقمها للكاشير."
      />

      <div className="flex gap-1 rounded-lg border p-1 bg-muted/30 w-fit">
        <button
          type="button"
          onClick={() => setTab("create")}
          className={tab === "create" ? "px-4 py-1.5 text-sm font-bold rounded-md bg-background shadow-sm inline-flex items-center gap-1" : "px-4 py-1.5 text-sm text-muted-foreground inline-flex items-center gap-1"}
        >
          <Plus className="size-3.5" aria-hidden /> إنشاء موافقة
        </button>
        <button
          type="button"
          onClick={() => setTab("log")}
          className={tab === "log" ? "px-4 py-1.5 text-sm font-bold rounded-md bg-background shadow-sm inline-flex items-center gap-1" : "px-4 py-1.5 text-sm text-muted-foreground inline-flex items-center gap-1"}
        >
          <History className="size-3.5" aria-hidden /> السجلّ العامّ
        </button>
      </div>

      {tab === "create" && (
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
                  <MoneyInput
                    value={maxAmount}
                    onChange={setMaxAmount}
                    placeholder="مثل: 500,000"
                    decimals={0}
                    ariaLabel="الحد الائتماني الأقصى"
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
                  <span>رقم الموافقة: <span className="font-mono font-bold">{createdId}</span> — سلّمه للكاشير.</span>
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
                            <td className="p-2 text-end tabular-nums" dir="ltr">{fmtAr(r.maxAmount)}</td>
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
      )}

      {tab === "log" && <ApprovalsLog />}
    </div>
  );
}

/** سجلّ عامّ لكل الموافقات — لا طابور «النشِطة لعميل واحد» فقط (تبويب الإنشاء أعلاه). */
function ApprovalsLog() {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<ApprovalStatus>("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const customers = trpc.customers.search.useQuery(
    { q: customerSearch || undefined, limit: 20 },
    { enabled: customerSearch.trim().length > 0 },
  );
  const log = trpc.creditApproval.list.useQuery({
    customerId: customerId ?? undefined,
    status: status || undefined,
    limit: LIMIT,
    offset,
  });

  const [cancelTarget, setCancelTarget] = useState<{ id: number; customerName: string } | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const cancelMut = trpc.creditApproval.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغيت الموافقة");
      setCancelTarget(null);
      setCancelReason("");
      await utils.creditApproval.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const rows = log.data?.rows ?? [];
  const total = log.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <AppSelect
            value={status}
            onValueChange={(v) => { setStatus(v as ApprovalStatus); setOffset(0); }}
            className="h-9 w-44"
            aria-label="الحالة"
            placeholder="كل الحالات"
          >
            <option value="ACTIVE">نشِطة</option>
            <option value="EXPIRED">منتهية</option>
            <option value="CONSUMED">مُستهلَكة (فاتورة)</option>
            <option value="CANCELLED">مُلغاة</option>
          </AppSelect>
          <div className="min-w-56 flex-1 max-w-xs">
            <input
              type="text"
              value={customerSearch}
              onChange={(e) => { setCustomerSearch(e.target.value); setCustomerId(null); setOffset(0); }}
              placeholder="فلترة بعميل — ابحث بالاسم…"
              className="h-9 w-full px-3 rounded-md border bg-transparent text-sm"
            />
            {customerSearch.trim() && !customerId && (customers.data?.rows?.length ?? 0) > 0 && (
              <div className="border rounded mt-1 max-h-40 overflow-auto bg-popover shadow-md absolute z-10">
                {customers.data!.rows.map((c: any) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { setCustomerId(Number(c.id)); setCustomerSearch(c.name); setOffset(0); }}
                    className="w-full text-end p-2 hover:bg-accent border-b text-sm"
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {customerId && (
            <Button variant="ghost" size="sm" onClick={() => { setCustomerId(null); setCustomerSearch(""); setOffset(0); }} className="gap-1">
              <X className="size-3.5" aria-hidden /> إلغاء فلتر العميل
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {log.isLoading ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">لا موافقات مطابقة للفلاتر.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b bg-muted/50 text-end">
                  <th className="p-2 font-medium text-end">#</th>
                  <th className="p-2 font-medium text-end">العميل</th>
                  <th className="p-2 font-medium text-end">السقف</th>
                  <th className="p-2 font-medium text-end">أنشأها</th>
                  <th className="p-2 font-medium text-end">ينتهي</th>
                  <th className="p-2 font-medium text-center">الحالة</th>
                  <th className="p-2 font-medium text-end">ملاحظات</th>
                  <th className="p-2 font-medium text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = deriveStatus(r);
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="p-2 text-end tabular-nums">{r.id}</td>
                      <td className="p-2 text-end font-medium">{r.customerName}</td>
                      <td className="p-2 text-end tabular-nums" dir="ltr">{fmtAr(r.maxAmount)}</td>
                      <td className="p-2 text-end text-xs text-muted-foreground">{r.approvedByName ?? "—"}</td>
                      <td className="p-2 text-end text-xs tabular-nums" dir="ltr">{fmtDateTime(r.expiresAt)}</td>
                      <td className="p-2 text-center">
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_LABEL[st].cls}`}>
                          {STATUS_LABEL[st].label}
                        </span>
                      </td>
                      <td className="p-2 text-end text-xs text-muted-foreground max-w-56 truncate" title={r.notes ?? undefined}>{r.notes ?? "—"}</td>
                      <td className="p-2 text-center">
                        {st === "ACTIVE" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive gap-1"
                            disabled={cancelMut.isPending}
                            onClick={() => setCancelTarget({ id: Number(r.id), customerName: r.customerName })}
                          >
                            <X className="size-3.5" aria-hidden /> إلغاء
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t p-3 text-xs text-muted-foreground">
            <Button variant="outline" size="sm" disabled={offset <= 0} onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}>
              ← السابق
            </Button>
            <span>صفحة {Math.floor(offset / LIMIT) + 1} من {pages} ({total} موافقة)</span>
            <Button variant="outline" size="sm" disabled={offset + LIMIT >= total} onClick={() => setOffset((o) => o + LIMIT)}>
              التالي →
            </Button>
          </div>
        )}
      </CardContent>

      {/* حوار الإلغاء — سبب اختياري + تأكيد صريح (بدل window.prompt/confirm). */}
      <Dialog open={cancelTarget != null} onOpenChange={(o) => { if (!o) { setCancelTarget(null); setCancelReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إلغاء موافقة ائتمان — {cancelTarget?.customerName}</DialogTitle>
            <DialogDescription>
              ستُصبح الموافقة #{cancelTarget?.id} غير قابلة للاستعمال نهائياً (single-use). لا يمكن التراجع.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label className="text-sm font-medium">سبب الإلغاء (اختياري)</label>
            <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} maxLength={255} placeholder="مثال: طُلب سقف أعلى بالخطأ" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>تراجع</Button>
            <Button
              variant="destructive"
              disabled={cancelMut.isPending}
              onClick={() => cancelTarget && cancelMut.mutate({ id: cancelTarget.id, reason: cancelReason.trim() || undefined })}
            >
              {cancelMut.isPending ? "جارٍ…" : "تأكيد الإلغاء"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
