/**
 * موافقات الائتمان المُسبَقة — managerProcedure.
 * إنشاء موافقة (customer + maxAmount + ttl) ⇒ approvalId يستعمله الكاشير.
 * تبويب «السجلّ»: كل الموافقات (كل العملاء/الحالات) — عرض + إلغاء موافقة لم تُستهلَك بعد.
 */
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { RowActions } from "@/components/list/RowActions";
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
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { Check, History, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

type Tab = "create" | "log";
type ApprovalStatus = "" | "ACTIVE" | "EXPIRED" | "CONSUMED" | "CANCELLED";

const STATUS_LABEL: Record<Exclude<ApprovalStatus, "">, { label: string; cls: string }> = {
  ACTIVE: { label: "نشِطة", cls: "badge-status-active" },
  EXPIRED: { label: "منتهية", cls: "bg-muted text-muted-foreground" },
  CONSUMED: { label: "مُستهلَكة (فاتورة)", cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]" },
  CANCELLED: { label: "مُلغاة", cls: "bg-destructive/15 text-destructive" },
};

/** صفوف الجدولين — مشتقّةٌ من عقد الراوتر فلا تنجرف عن الخادم (كانت `any`). */
type ActiveApprovalRow = RouterOutputs["creditApproval"]["listForCustomer"]["rows"][number];
type ApprovalLogRow = RouterOutputs["creditApproval"]["list"]["rows"][number];

/** أعمدة «الموافقات النشِطة لهذا العميل» — جدولٌ مُضمَّن في بطاقةٍ تحمل عنوانه. */
const activeApprovalColumns: ColumnDef<ActiveApprovalRow, unknown>[] = [
  { id: "id", header: "#", accessorFn: (r) => r.id, meta: { kind: "number", width: "id" }, cell: ({ row }) => row.original.id },
  { id: "maxAmount", header: "السقف", accessorFn: (r) => fmtAr(r.maxAmount), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.maxAmount) },
  { id: "expiresAt", header: "ينتهي", accessorFn: (r) => fmtDateTime(r.expiresAt), meta: { kind: "datetime" }, cell: ({ row }) => fmtDateTime(row.original.expiresAt) },
];

/** حالة مُشتقّة من نفس أعمدة الراوتر (لا حقل status في الردّ — نشتقّه هنا للعرض فقط). */
function deriveStatus(r: { expiresAt: string | Date; consumedAt: string | Date | null; consumedByInvoiceId: number | null }): Exclude<ApprovalStatus, ""> {
  if (r.consumedByInvoiceId != null) return "CONSUMED";
  if (r.consumedAt != null) return "CANCELLED";
  if (new Date(r.expiresAt).getTime() <= Date.now()) return "EXPIRED";
  return "ACTIVE";
}

export default function CreditApprovalsPage() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canPickBranch = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  const [pickedBranchId, setPickedBranchId] = useState<number | null>(null);
  const effectiveBranchId = me.data?.branchId != null ? Number(me.data.branchId) : pickedBranchId;
  const [tab, setTab] = useState<Tab>("create");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [maxAmount, setMaxAmount] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [notes, setNotes] = useState("");
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (canPickBranch && pickedBranchId == null && branches.data?.[0]?.id) {
      setPickedBranchId(Number(branches.data[0].id));
    }
  }, [branches.data, canPickBranch, pickedBranchId]);

  // قائمة عملاء سريعة للاختيار (search مع filter اسم)
  const customers = trpc.creditApproval.customerOptions.useQuery(
    { branchId: effectiveBranchId ?? undefined, q: customerSearch || undefined, limit: 20 },
    { enabled: effectiveBranchId != null },
  );
  const active = trpc.creditApproval.listForCustomer.useQuery(
    { customerId: customerId ?? 0, branchId: effectiveBranchId ?? undefined },
    { enabled: !!customerId && effectiveBranchId != null },
  );

  const createMut = trpc.creditApproval.create.useMutation({
    onSuccess: (r) => {
      notify.ok(`أُنشئت الموافقة #${r.id} — تنتهي ${fmtDateTime(r.expiresAt)}`);
      setCreatedId(r.id);
      utils.creditApproval.listForCustomer.invalidate();
      utils.creditApproval.list.invalidate();
      setMaxAmount("");
      setNotes("");
      setClientRequestId(crypto.randomUUID());
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
                {canPickBranch && (
                  <div className="grid gap-2 md:col-span-2">
                    <label className="text-sm font-medium">الفرع</label>
                    <AppSelect
                      value={effectiveBranchId?.toString() ?? ""}
                      onValueChange={(value) => {
                        setPickedBranchId(Number(value));
                        setCustomerId(null);
                        setCustomerSearch("");
                      }}
                      aria-label="فرع قرار الائتمان"
                    >
                      {(branches.data ?? []).map((branch) => (
                        <option key={branch.id} value={branch.id}>{branch.name}</option>
                      ))}
                    </AppSelect>
                  </div>
                )}
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
                  if (!effectiveBranchId) return notify.err("اختر الفرع");
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
                  createMut.mutate({
                    customerId,
                    branchId: effectiveBranchId,
                    maxAmount,
                    ttlMinutes,
                    notes: notes.trim() || undefined,
                    clientRequestId,
                  });
                }}
                disabled={createMut.isPending || effectiveBranchId == null}
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
              <CardContent className="p-0">
                {/* مُضمَّن في بطاقةٍ تحمل عنوانه ⇒ بلا شريط حالةٍ ولا بحثٍ ولا ترقيم. */}
                <DataTable<ActiveApprovalRow>
                  embedded
                  searchable={false}
                  bounded={false}
                  pageSize={Infinity}
                  columns={activeApprovalColumns}
                  data={active.data?.rows ?? []}
                  loading={active.isLoading}
                  errorState={{ isError: active.isError, message: active.error?.message, onRetry: () => void active.refetch() }}
                  emptyText="لا موافقات نشِطة"
                />
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

  // أعمدة السجلّ — تقرأ الحالة المشتقّة وحالة طفرة الإلغاء، فتُبنى في جسم المكوّن.
  const columns: ColumnDef<ApprovalLogRow, unknown>[] = [
    { id: "id", header: "#", accessorFn: (r) => r.id, meta: { kind: "number", width: "id" }, cell: ({ row }) => row.original.id },
    {
      id: "customerName",
      header: "العميل",
      accessorFn: (r) => r.customerName,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => <span className="font-medium">{row.original.customerName}</span>,
    },
    { id: "maxAmount", header: "السقف", accessorFn: (r) => fmtAr(r.maxAmount), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.maxAmount) },
    {
      id: "approvedBy",
      header: "أنشأها",
      accessorFn: (r) => r.approvedByName ?? "—",
      meta: { kind: "actor" },
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.approvedByName ?? "—"}</span>,
    },
    {
      id: "expiresAt",
      header: "ينتهي",
      accessorFn: (r) => fmtDateTime(r.expiresAt),
      meta: { kind: "datetime" },
      cell: ({ row }) => <span className="text-xs">{fmtDateTime(row.original.expiresAt)}</span>,
    },
    {
      id: "status",
      header: "الحالة",
      // التسمية العربية المعروضة لا الرمز — الحالة مشتقّة (لا عمود status في الردّ).
      accessorFn: (r) => STATUS_LABEL[deriveStatus(r)].label,
      meta: { kind: "status" },
      cell: ({ row }) => {
        const st = deriveStatus(row.original);
        return (
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_LABEL[st].cls}`}>
            {STATUS_LABEL[st].label}
          </span>
        );
      },
    },
    {
      id: "notes",
      header: "ملاحظات",
      accessorFn: (r) => r.notes ?? "—",
      cell: ({ row }) => (
        <span className="block max-w-56 truncate text-xs text-muted-foreground" title={row.original.notes ?? undefined}>
          {row.original.notes ?? "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "الإجراءات والتواصل",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const r = row.original;
        const st = deriveStatus(r);
        return (
          <RowActions
            actions={[
              {
                key: "cancel",
                kind: "cancel",
                label: "إلغاء الموافقة",
                onSelect: () => setCancelTarget({ id: Number(r.id), customerName: r.customerName }),
                variant: "destructive",
                disabled: st !== "ACTIVE" || cancelMut.isPending,
                disabledReason: st !== "ACTIVE"
                  ? "لا يمكن إلغاء موافقة غير نشطة"
                  : "توجد عملية إلغاء قيد التنفيذ",
                gate: { managerOnly: true },
              },
            ]}
            contact={{
              phone: r.customerPhone,
              label: `التواصل مع ${r.customerName}`,
              message: buildOperationalContactMessage({
                entityLabel: "موافقة ائتمان",
                reference: String(r.id),
                partyName: r.customerName,
                status: STATUS_LABEL[st].label,
                dueAt: r.expiresAt,
                title: `سقف الموافقة: ${fmtAr(r.maxAmount)} د.ع`,
                nextAction: st === "ACTIVE" ? "يرجى تأكيد استلام تفاصيل الموافقة." : undefined,
              }),
              gate: { managerOnly: true },
            }}
          />
        );
      },
    },
  ];

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
        {/* الفلاتر (الحالة/العميل) في ترويسة البطاقة أعلاه وتغذّي الاستعلام الخادميّ ⇒
            `searchable={false}`، و`externalFiltersActive` كي لا يُعلن الجدول «لا صفوف بعد»
            على فلترٍ حاجب. والترقيم صار موحّداً عبر serverPagination بدل زرَّي «السابق/التالي»
            اليدويَّين (سهماهما كانا معكوسَين في RTL). */}
        <DataTable<ApprovalLogRow>
          columns={columns}
          data={rows}
          searchable={false}
          externalFiltersActive={status !== "" || customerId != null}
          loading={log.isLoading}
          errorState={{ isError: log.isError, message: log.error?.message, onRetry: () => void log.refetch() }}
          serverPagination={{
            page: Math.floor(offset / LIMIT),
            onPageChange: (next) => setOffset(next * LIMIT),
            pageSize: LIMIT,
            total,
            isFetching: log.isFetching,
          }}
          emptyText="لا موافقات مطابقة للفلاتر."
        />
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
