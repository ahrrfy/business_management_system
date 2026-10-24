import { useEffect, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs, type RouterInputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { SmartCustomerInput } from "@/components/form/SmartCustomerInput";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { newClientRequestId } from "@/lib/countQueue";

type Detail = RouterOutputs["delivery"]["fulfillment"]["requests"]["get"];
type Candidate =
  RouterOutputs["delivery"]["fulfillment"]["requests"]["candidates"][number];
type Header = Omit<
  RouterInputs["delivery"]["fulfillment"]["requests"]["create"],
  "sources" | "clientRequestId"
>;
type Inputs = RouterInputs["delivery"]["fulfillment"]["requests"];
type PendingSave =
  | { kind: "create"; input: Inputs["create"] }
  | { kind: "update"; input: Inputs["update"] };
const definitiveErrors = new Set([
  "BAD_REQUEST",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);
export function RequestEditor({
  branchId,
  actorId,
  detail,
  contextInvoiceId,
  contextWorkOrderId,
  onSaved,
  onClose,
}: {
  branchId: number;
  actorId?: number;
  detail?: Detail;
  contextInvoiceId?: number;
  contextWorkOrderId?: number;
  onSaved: (id: number) => void;
  onClose: () => void;
}) {
  const mounted = useRef(true);
  const hydratedContext = useRef(false);
  const expectedVersion = useRef(detail?.request.version);
  const replayKey = actorId
    ? `fulfillment-request-editor:v1:${actorId}:${branchId}:${detail?.request.id ?? `new:${contextInvoiceId ?? ""}:${contextWorkOrderId ?? ""}`}`
    : null;
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(() => {
    try {
      const saved = replayKey
        ? (JSON.parse(
            sessionStorage.getItem(replayKey) ?? "null",
          ) as PendingSave | null)
        : null;
      return saved &&
        ["create", "update"].includes(saved.kind) &&
        saved.input?.branchId === branchId &&
        typeof saved.input.clientRequestId === "string"
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  const pendingRef = useRef(pendingSave);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remember = (value: PendingSave | null) => {
    pendingRef.current = value;
    if (mounted.current) setPendingSave(value);
    try {
      if (replayKey) {
        if (value) sessionStorage.setItem(replayKey, JSON.stringify(value));
        else sessionStorage.removeItem(replayKey);
      }
    } catch {
      /* Mounted drafts retain their native replay key. */
    }
  };
  const [header, setHeader] = useState<Header>(() =>
    detail
      ? { ...detail.request }
      : {
          branchId,
          customerId: null,
          recipientName: "",
          recipientPhone: "",
          deliveryAddress: "",
          partyId: null,
          deliveryFee: "0",
          feeCollection: "COURIER",
          partialReleaseAllowed: false,
          futureFeeDecision: "",
          notes: "",
        },
  );
  const [search, setSearch] = useState("");
  const [chargeOnly, setChargeOnly] = useState(detail?.items.length === 0);
  const [selected, setSelected] = useState<Candidate[]>(() =>
    detail
      ? detail.items.map((r) => ({
          key:
            r.workOrderId != null ? `W:${r.workOrderId}` : `I:${r.invoiceId}`,
          invoiceId: r.workOrderId != null ? null : r.invoiceId,
          workOrderId: r.workOrderId,
          number: r.number,
          title: r.title,
          customerId: detail.request.customerId,
          customerName: detail.request.recipientName,
          recipientPhone: detail.request.recipientPhone,
          deliveryAddress: detail.request.deliveryAddress,
          ready: r.ready,
          total: r.total,
          paidAmount: r.paidAmount,
        }))
      : [],
  );
  const [key, setKey] = useState(newClientRequestId);
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const candidates = trpc.delivery.fulfillment.requests.candidates.useQuery({
    branchId,
    customerId: header.customerId,
    search,
    limit: 50,
  });
  const context = trpc.delivery.fulfillment.requests.candidates.useQuery(
    { branchId, invoiceId: contextInvoiceId, workOrderId: contextWorkOrderId },
    {
      enabled:
        !detail && (contextInvoiceId != null || contextWorkOrderId != null),
    },
  );
  useEffect(() => {
    if (
      hydratedContext.current ||
      pendingRef.current ||
      detail ||
      (!contextInvoiceId && !contextWorkOrderId) ||
      !context.data
    )
      return;
    const row = context.data.find((r) =>
      contextInvoiceId
        ? r.invoiceId === contextInvoiceId
        : r.workOrderId === contextWorkOrderId,
    );
    if (row) {
      hydratedContext.current = true;
      setSelected([row]);
      setHeader((h) => ({
        ...h,
        customerId: h.customerId ?? row.customerId,
        recipientName: h.recipientName || row.customerName || "",
        recipientPhone: h.recipientPhone || row.recipientPhone || "",
        deliveryAddress: h.deliveryAddress || row.deliveryAddress || "",
      }));
    }
  }, [context.data, contextInvoiceId, contextWorkOrderId, detail]);
  const success = (row: { id: number }) => {
    remember(null);
    if (!mounted.current) return;
    setKey(newClientRequestId());
    notify.ok("تم حفظ طلب التوصيل");
    onSaved(row.id);
  };
  const failure = (error: unknown) => {
    const code = (error as { data?: { code?: string } } | null)?.data?.code;
    if (code && definitiveErrors.has(code)) remember(null);
    if (mounted.current) notify.err(error);
  };
  const create = trpc.delivery.fulfillment.requests.create.useMutation({
    onSuccess: success,
    onError: failure,
  });
  const update = trpc.delivery.fulfillment.requests.update.useMutation({
    onSuccess: success,
    onError: failure,
  });
  const busy = create.isPending || update.isPending || pendingSave != null;
  const run = (command: PendingSave) => {
    if (command.kind === "create") create.mutate(command.input);
    else update.mutate(command.input);
  };
  const toggle = (row: Candidate) => {
    hydratedContext.current = true;
    setChargeOnly(false);
    const existing = selected.some((r) => r.key === row.key);
    if (!existing && selected.length && row.customerId !== header.customerId) {
      notify.err("اختر مستندات العميل نفسه في الطلب");
      return;
    }
    setSelected((rows) =>
      existing ? rows.filter((r) => r.key !== row.key) : [...rows, row],
    );
    if (!existing && !selected.length)
      setHeader((h) => ({
        ...h,
        customerId: row.customerId,
        recipientName: row.customerName ?? h.recipientName,
        recipientPhone: row.recipientPhone ?? h.recipientPhone,
        deliveryAddress: row.deliveryAddress ?? h.deliveryAddress,
      }));
    setKey(newClientRequestId());
  };
  const customers = Array.from(
    new Map(
      [...(candidates.data ?? []), ...selected]
        .filter((r) => r.customerId != null)
        .map((r) => [
          r.customerId,
          { id: r.customerId!, name: r.customerName ?? String(r.customerId) },
        ]),
    ).values(),
  );
  const columns: ColumnDef<Candidate, unknown>[] = [
    {
      id: "select",
      header: "اختيار",
      cell: ({ row }) => (
        <Checkbox
          aria-label={`اختيار ${row.original.number}`}
          checked={selected.some((r) => r.key === row.original.key)}
          onCheckedChange={() => toggle(row.original)}
        />
      ),
    },
    {
      accessorKey: "number",
      header: "المستند",
      cell: ({ row }) => (
        <div>
          {row.original.number}
          <div className="text-xs text-muted-foreground">
            {row.original.title ?? "فاتورة بيع"}
          </div>
        </div>
      ),
    },
    { accessorKey: "customerName", header: "العميل" },
    {
      id: "ready",
      header: "التجهيز",
      cell: ({ row }) => (row.original.ready ? "جاهز" : "بانتظار التجهيز"),
    },
    {
      accessorKey: "total",
      header: "القيمة الحالية",
      cell: ({ row }) => fmtAr(row.original.total),
    },
  ];
  const change = <K extends keyof Header>(field: K, value: Header[K]) => {
    setHeader((h) => ({ ...h, [field]: value }));
    setKey(newClientRequestId());
  };
  return (
    <section className="space-y-4 rounded border p-4" dir="rtl">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">
          {detail ? `تعديل ${detail.request.requestNumber}` : "طلب توصيل جديد"}
        </h3>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          إغلاق
        </Button>
      </div>
      {pendingSave && (
        <div role="status" className="space-y-2 rounded border p-3 text-sm">
          <p>
            حفظ طلب {pendingSave.input.recipientName} لم تحسم نتيجته. استعد
            العملية نفسها قبل بدء طلب آخر.
          </p>
          <Button
            variant="outline"
            disabled={create.isPending || update.isPending}
            onClick={() => run(pendingSave)}
          >
            استعادة نتيجة الحفظ نفسه
          </Button>
        </div>
      )}
      {detail && detail.request.version !== expectedVersion.current && (
        <p role="alert" className="text-destructive">
          تغيّر الطلب أثناء التعديل. احتفظ ببياناتك وراجع النسخة الحالية قبل حفظ
          تعديل جديد.
        </p>
      )}
      <fieldset disabled={busy} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          اجمع فواتير العميل وأوامر الشغل في طلب واحد. الفاتورة المدفوعة تبقى
          مدفوعة، وأمر الشغل غير الجاهز يؤجل الإرسال افتراضياً.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={chargeOnly}
            onCheckedChange={(v) => {
              hydratedContext.current = true;
              setChargeOnly(v === true);
              if (v) setSelected([]);
              setKey(newClientRequestId());
            }}
          />
          طلب توصيل أو تحصيل أجور فقط دون إنشاء بيع جديد
        </label>
        {chargeOnly && (
          <div className="space-y-1 text-sm">
            العميل المسجل للأجور
            <SmartCustomerInput
              value={{
                customerId: header.customerId ?? null,
                name: header.recipientName,
                phone: header.recipientPhone,
                isNew: false,
              }}
              onChange={(v) => {
                if (v.isNew) {
                  notify.err("اختر عميلاً مسجلاً للأجور المستقلة");
                  return;
                }
                setHeader((h) => ({
                  ...h,
                  customerId: v.customerId,
                  recipientName: v.name,
                  recipientPhone: v.phone ?? h.recipientPhone,
                }));
                setKey(newClientRequestId());
              }}
            />
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            العميل الحقيقي
            <AppSelect
              value={header.customerId != null ? String(header.customerId) : ""}
              onValueChange={(v) => {
                hydratedContext.current = true;
                change("customerId", v ? Number(v) : null);
                setSelected([]);
              }}
              searchable
            >
              <option value="">عابر / اختيار من المستند</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </AppSelect>
          </label>
          <label className="space-y-1 text-sm">
            جهة التوصيل
            <AppSelect
              value={header.partyId != null ? String(header.partyId) : ""}
              onValueChange={(v) => change("partyId", v ? Number(v) : null)}
              searchable
            >
              <option value="">تحدد قبل الإرسال</option>
              {(parties.data ?? [])
                .filter((p) => p.branchId == null || p.branchId === branchId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </AppSelect>
          </label>
          <label className="space-y-1 text-sm">
            اسم المستلم
            <Input
              value={header.recipientName}
              onChange={(e) => change("recipientName", e.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            هاتف المستلم
            <IntlPhoneInput
              ariaLabel="هاتف المستلم"
              value={header.recipientPhone}
              onChange={(value) => change("recipientPhone", value)}
            />
          </label>
          <label className="space-y-1 text-sm sm:col-span-2">
            العنوان
            <Textarea
              value={header.deliveryAddress}
              onChange={(e) => change("deliveryAddress", e.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            أجرة واحدة للشحنة
            <MoneyInput
              value={header.deliveryFee}
              onChange={(v) => change("deliveryFee", v)}
            />
          </label>
          <label className="space-y-1 text-sm">
            تحمل الأجرة
            <AppSelect
              value={header.feeCollection}
              onValueChange={(v) =>
                change("feeCollection", v as Header["feeCollection"])
              }
            >
              <option value="COURIER">يقبضها الناقل من المستلم</option>
              <option value="COUNTER">مقبوضة مسبقاً بإيصال حقيقي</option>
              <option value="SHOP">على المكتبة</option>
            </AppSelect>
          </label>
        </div>
        <UnifiedSearchInput
          value={search}
          onChange={setSearch}
          placeholder="بحث باسم العميل أو رقم الفاتورة أو أمر الشغل أو الهاتف"
          barcode={false}
        />
        {context.isError && (
          <p role="alert" className="text-destructive">
            {context.error.message}
          </p>
        )}
        {!detail &&
          (contextInvoiceId || contextWorkOrderId) &&
          context.isSuccess &&
          !context.data.length && (
            <p role="alert" className="text-destructive">
              المستند غير متاح لهذا الطلب في الفرع الحالي؛ راجع ارتباطه بطلب
              تجهيز قائم أو حالة مصدره.
            </p>
          )}
        <DataTable
          columns={columns}
          data={candidates.data ?? []}
          loading={candidates.isLoading}
          searchable={false}
          errorState={{
            isError: candidates.isError,
            message: candidates.error?.message,
            onRetry: () => void candidates.refetch(),
          }}
        />
        <div className="space-y-2">
          <div className="text-sm font-medium">
            المستندات المختارة ({selected.length})
          </div>
          {selected.map((r) => (
            <div
              key={r.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
            >
              <span>
                {r.number} — {r.customerName} —{" "}
                {r.ready ? "جاهز" : "بانتظار التجهيز"}
              </span>
              <Button size="sm" variant="outline" onClick={() => toggle(r)}>
                إزالة
              </Button>
            </div>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={header.partialReleaseAllowed}
            onCheckedChange={(v) => change("partialReleaseAllowed", v === true)}
          />
          السماح بإرسال جزئي بعد تحديد البنود وتأكيده صراحةً
        </label>
        {header.partialReleaseAllowed && (
          <label className="block space-y-1 text-sm">
            قرار أجرة الإرسال القادم والبنود المتبقية
            <Textarea
              value={header.futureFeeDecision ?? ""}
              onChange={(e) => change("futureFeeDecision", e.target.value)}
            />
          </label>
        )}
        <label className="block space-y-1 text-sm">
          ملاحظات
          <Textarea
            value={header.notes ?? ""}
            onChange={(e) => change("notes", e.target.value)}
          />
        </label>
        <SubmitButton
          type="button"
          pending={create.isPending || update.isPending}
          disabled={
            busy ||
            (!selected.length && !chargeOnly) ||
            (chargeOnly && header.customerId == null)
          }
          onClick={() => {
            if (pendingRef.current) return;
            const sources = selected.map((r) =>
              r.invoiceId != null
                ? { invoiceId: r.invoiceId }
                : { workOrderId: r.workOrderId! },
            );
            const payload = {
              ...header,
              branchId,
              sources,
              clientRequestId: key,
            };
            const command: PendingSave = detail
              ? {
                  kind: "update",
                  input: {
                    ...payload,
                    id: detail.request.id,
                    expectedVersion:
                      expectedVersion.current ?? detail.request.version,
                  },
                }
              : { kind: "create", input: payload };
            remember(command);
            run(command);
          }}
        >
          حفظ طلب التوصيل
        </SubmitButton>
      </fieldset>
    </section>
  );
}
