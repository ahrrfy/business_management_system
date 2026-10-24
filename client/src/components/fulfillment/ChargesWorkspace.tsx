import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { confirm } from "@/lib/confirm";
import { fmt, moneyInput } from "@/lib/money";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";
import {
  FULFILLMENT_CHARGE_CATEGORIES,
  fulfillmentChargeCategoryLabel,
  fulfillmentChargeStatusLabel,
  type FulfillmentChargeCategory,
} from "@shared/fulfillment";
import { paymentMethodCompact } from "@shared/terms";

type ChargeApiInput = RouterInputs["delivery"]["fulfillment"]["charges"];
type ChargeApiOutput = RouterOutputs["delivery"]["fulfillment"]["charges"];
type Row = ChargeApiOutput["list"]["rows"][number];
type Action =
  | "create"
  | "approve"
  | "collect"
  | "refund"
  | "refundExcess"
  | "refundCourierExcess"
  | "settlePayee"
  | "recordCourierCollection"
  | "remitCourier";
type Command = {
  [A in Action]: { action: A; input: ChargeApiInput[A] };
}[Action];
const uuid = () => crypto.randomUUID();
function persistentKey(name: string) {
  const old = localStorage.getItem(name);
  if (old) return old;
  const key = uuid();
  localStorage.setItem(name, key);
  return key;
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
const paymentKindLabel: Record<string, string> = {
  COLLECTION: "قبض العميل",
  REFUND: "رد إلى العميل",
  PAYEE_PAYMENT: "سداد المستفيد",
  COURIER_COLLECTION: "قبض بعهدة الناقل",
  COURIER_REMITTANCE: "توريد عهدة الناقل",
};

export type ChargesWorkspaceProps = {
  embedded?: boolean;
  branchId?: number;
  initialChargeId?: number;
};

export function ChargesWorkspace({
  embedded = false,
  branchId: selectedBranchId,
  initialChargeId,
}: ChargesWorkspaceProps = {}) {
  const me = trpc.auth.me.useQuery();
  const urlSearch = useSearch();
  const [chosenBranch, setChosenBranch] = useState(
    () => new URLSearchParams(urlSearch).get("branchId") || "",
  );
  const branchValue = chosenBranch || me.data?.branchId;
  const branchId = embedded
    ? selectedBranchId
    : branchValue
      ? Number(branchValue)
      : undefined;
  return (
    <ChargesWorkspaceContent
      key={`${me.data?.id ?? "anonymous"}:${branchId ?? "unselected"}:${embedded}`}
      embedded={embedded}
      branchId={branchId}
      initialChargeId={initialChargeId}
      onBranchChange={setChosenBranch}
    />
  );
}

function ChargesWorkspaceContent({
  embedded,
  branchId,
  initialChargeId,
  onBranchChange,
}: ChargesWorkspaceProps & { onBranchChange: (value: string) => void }) {
  const urlSearch = useSearch();
  const urlParams = useMemo(() => new URLSearchParams(urlSearch), [urlSearch]);
  const linkedRequestId = embedded
    ? 0
    : Number(urlParams.get("requestId") || 0);
  const me = trpc.auth.me.useQuery(),
    branches = trpc.branches.list.useQuery(undefined, { enabled: !embedded }),
    utils = trpc.useUtils();
  const [search, setSearch] = useState(""),
    [searchDebounced, setSearchDebounced] = useState(""),
    [page, setPage] = useState(0);
  const [lookupSearch, setLookupSearch] = useState(""),
    [lookupDebounced, setLookupDebounced] = useState("");
  const [selected, setSelected] = useState<number | null>(
      initialChargeId ?? null,
    ),
    [showCreate, setShowCreate] = useState(linkedRequestId > 0);
  const [category, setCategory] =
      useState<FulfillmentChargeCategory>("SERVICE"),
    [customer, setCustomer] = useState(""),
    [request, setRequest] = useState(
      linkedRequestId > 0 ? String(linkedRequestId) : "",
    );
  const [description, setDescription] = useState(""),
    [amount, setAmount] = useState(""),
    [externalCost, setExternalCost] = useState("");
  const [payeeKind, setPayeeKind] = useState("SUPPLIER"),
    [payeeId, setPayeeId] = useState(""),
    [payeeName, setPayeeName] = useState(""),
    [payeePhone, setPayeePhone] = useState("");
  const [action, setAction] = useState<Exclude<Action, "create">>("collect"),
    [paymentAmount, setPaymentAmount] = useState(""),
    [method, setMethod] = useState<"CASH" | "CARD" | "TRANSFER" | "WALLET">(
      "CASH",
    );
  const [bucket, setBucket] = useState<"DRAWER" | "TREASURY">("DRAWER"),
    [shift, setShift] = useState(""),
    [reference, setReference] = useState(""),
    [reason, setReason] = useState("");
  const [originalPayment, setOriginalPayment] = useState(""),
    [party, setParty] = useState(""),
    [consignment, setConsignment] = useState("");
  const [proof, setProof] = useState<{
    attemptId: number;
    amount: string;
    method: string;
    reference: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const scope = `fulfillment-charge:${me.data?.id ?? 0}:${branchId}`;
  const [pending, setPending] = useState<Command | null>(() => {
    try {
      const saved = localStorage.getItem(`${scope}:pending`);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const openedInitial = useRef<number | undefined>(undefined);
  const initialActionFor = useRef<number | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(search);
      setPage(0);
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const timer = setTimeout(() => setLookupDebounced(lookupSearch), 220);
    return () => clearTimeout(timer);
  }, [lookupSearch]);
  useEffect(() => {
    setSelected(initialChargeId ?? null);
    setProof(null);
    setError("");
    try {
      const saved = localStorage.getItem(`${scope}:pending`);
      setPending(saved ? JSON.parse(saved) : null);
    } catch {
      setPending(null);
    }
  }, [scope]);
  useEffect(() => {
    if (!pending || pending.action === "create") return;
    const target =
      "id" in pending.input
        ? pending.input.id
        : "allocations" in pending.input
          ? pending.input.allocations[0]?.chargeId
          : undefined;
    if (target) setSelected(target);
    setAction(pending.action);
    setShowCreate(false);
  }, [pending]);
  const list = trpc.delivery.fulfillment.charges.list.useQuery(
    {
      branchId: branchId!,
      search: searchDebounced,
      requestId: linkedRequestId || undefined,
      limit: 25,
      offset: page * 25,
    },
    { enabled: branchId !== undefined && branchId > 0 },
  );
  const lookup = trpc.delivery.fulfillment.charges.lookup.useQuery(
    { branchId: branchId!, search: lookupDebounced },
    { enabled: branchId !== undefined && branchId > 0 },
  );
  const detail = trpc.delivery.fulfillment.charges.get.useQuery(
    { id: selected ?? 0 },
    { enabled: !!selected },
  );
  const linkedRequest = trpc.delivery.fulfillment.requests.get.useQuery(
    { id: Number(request) || 0 },
    { enabled: Number(request) > 0 },
  );
  useEffect(() => {
    const value = linkedRequest.data?.request.customerId;
    if (value) setCustomer(String(value));
  }, [linkedRequest.data?.request.customerId]);
  const row = detail.data?.charge;
  const mutations = {
    create: trpc.delivery.fulfillment.charges.create.useMutation(),
    approve: trpc.delivery.fulfillment.charges.approve.useMutation(),
    collect: trpc.delivery.fulfillment.charges.collect.useMutation(),
    refund: trpc.delivery.fulfillment.charges.refund.useMutation(),
    refundExcess: trpc.delivery.fulfillment.charges.refundExcess.useMutation(),
    refundCourierExcess:
      trpc.delivery.fulfillment.charges.refundCourierExcess.useMutation(),
    settlePayee: trpc.delivery.fulfillment.charges.settlePayee.useMutation(),
    recordCourierCollection:
      trpc.delivery.fulfillment.charges.recordCourierCollection.useMutation(),
    remitCourier: trpc.delivery.fulfillment.charges.remitCourier.useMutation(),
  };
  const initiate =
      trpc.delivery.fulfillment.charges.initiateExternalPayment.useMutation(),
    confirmProof =
      trpc.delivery.fulfillment.charges.confirmExternalPayment.useMutation();
  useEffect(() => {
    if (
      !initialChargeId ||
      !Number.isSafeInteger(initialChargeId) ||
      initialChargeId <= 0 ||
      openedInitial.current === initialChargeId ||
      busy ||
      pending ||
      proof ||
      initiate.isPending ||
      confirmProof.isPending ||
      localStorage.getItem(`${scope}:pending`)
    )
      return;
    openedInitial.current = initialChargeId;
    setSelected(initialChargeId);
    setAction("collect");
    setShowCreate(false);
    setPaymentAmount("");
    setReference("");
    setOriginalPayment("");
    setParty("");
    setConsignment("");
    setError("");
    setNotice("");
  }, [
    initialChargeId,
    busy,
    pending,
    proof,
    initiate.isPending,
    confirmProof.isPending,
    scope,
  ]);
  useEffect(() => {
    if (
      !row ||
      row.id !== initialChargeId ||
      initialActionFor.current === row.id ||
      pending ||
      busy ||
      proof
    )
      return;
    initialActionFor.current = row.id;
    setAction(
      row.status === "DRAFT"
        ? "approve"
        : row.category === "SHOP_EXPENSE"
          ? "settlePayee"
          : "collect",
    );
  }, [
    row?.id,
    row?.status,
    row?.category,
    initialChargeId,
    pending,
    busy,
    proof,
  ]);
  const can = (op: Action) =>
    lifecycleActionAllowed(
      me.data,
      `delivery.fulfillment.charges.${op}`,
      !!me.data &&
        moduleAccessAllowed(
          me.data.role,
          me.data.permissionsOverride as PermissionMap | null,
          "store",
          "FULL",
          ["approve", "refund", "refundExcess", "refundCourierExcess"].includes(
            op,
          )
            ? ["manager"]
            : ["cashier", "manager"],
        ),
    );
  async function refresh() {
    await utils.delivery.fulfillment.charges.invalidate();
  }
  async function execute(command: Command) {
    setBusy(true);
    setError("");
    setNotice("");
    setPending(command);
    localStorage.setItem(`${scope}:pending`, JSON.stringify(command));
    try {
      switch (command.action) {
        case "create": {
          const value = await mutations.create.mutateAsync(command.input);
          setSelected(value.id);
          setAction("approve");
          setShowCreate(false);
          setDescription("");
          setAmount("");
          setExternalCost("");
          break;
        }
        case "approve":
          await mutations.approve.mutateAsync(command.input);
          setAction(
            row?.category === "SHOP_EXPENSE" ? "settlePayee" : "collect",
          );
          break;
        case "collect":
          await mutations.collect.mutateAsync(command.input);
          break;
        case "refund":
          await mutations.refund.mutateAsync(command.input);
          break;
        case "refundExcess":
          await mutations.refundExcess.mutateAsync(command.input);
          break;
        case "refundCourierExcess":
          await mutations.refundCourierExcess.mutateAsync(command.input);
          break;
        case "settlePayee":
          await mutations.settlePayee.mutateAsync(command.input);
          break;
        case "recordCourierCollection":
          await mutations.recordCourierCollection.mutateAsync(command.input);
          break;
        case "remitCourier":
          await mutations.remitCourier.mutateAsync(command.input);
          break;
      }
      localStorage.removeItem(`${scope}:pending`);
      setPending(null);
      setProof(null);
      setPaymentAmount("");
      setNotice("تم تثبيت الإجراء وإعادة قراءة الأرصدة");
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "تعذر إتمام الإجراء؛ أعد المحاولة بالطلب المحفوظ",
      );
    } finally {
      setBusy(false);
    }
  }
  async function submitCreate() {
    if (pending) return;
    if (!branchId) {
      setError("اختر الفرع قبل تسجيل الأجر");
      return;
    }
    const cost = category === "SERVICE" ? "0" : externalCost || "0";
    await execute({
      action: "create",
      input: {
        branchId,
        clientRequestId: uuid(),
        requestId: request ? Number(request) : null,
        customerId:
          category === "SHOP_EXPENSE"
            ? null
            : customer
              ? Number(customer)
              : null,
        category,
        description,
        amount: category === "SHOP_EXPENSE" ? "0" : amount || "0",
        externalCost: cost,
        payeeSupplierId:
          payeeKind === "SUPPLIER" && payeeId ? Number(payeeId) : null,
        payeePartyId: payeeKind === "PARTY" && payeeId ? Number(payeeId) : null,
        payeeUserId: payeeKind === "USER" && payeeId ? Number(payeeId) : null,
        payeeName: payeeKind === "NAMED" ? payeeName : null,
        payeePhone: payeeKind === "NAMED" ? payeePhone : null,
      },
    });
  }
  async function submitAction() {
    if (!row || pending) return;
    if (!branchId || branchId !== row.branchId) {
      setError("اختر فرع المطالبة قبل الإجراء");
      return;
    }
    if (
      !(await confirm({
        title: "تثبيت إجراء الأجر",
        description: `${row.description} — ${action === "approve" ? "اعتماد المطالبة والاستحقاق" : fmt(paymentAmount || "0") + " د.ع"}`,
        variant: action === "refund" ? "danger" : "warning",
      }))
    )
      return;
    const identity = {
      id: row.id,
      expectedVersion: row.version,
      clientRequestId: uuid(),
    };
    const tender = {
      method,
      cashBucket: method === "CASH" ? bucket : null,
      shiftId: shift ? Number(shift) : null,
      reference: reference || null,
      externalPaymentAttemptId: proof?.attemptId,
      externalPaymentDeviceId: persistentKey("fulfillment-charge-device"),
    };
    if (action === "approve") await execute({ action, input: identity });
    if (action === "collect")
      await execute({
        action,
        input: {
          branchId,
          clientRequestId: identity.clientRequestId,
          allocations: [
            {
              chargeId: row.id,
              expectedVersion: row.version,
              amount: moneyInput(paymentAmount).lte(
                moneyInput(detail.data?.remainingAmount),
              )
                ? paymentAmount
                : (detail.data?.remainingAmount ?? "0"),
            },
          ],
          amount: paymentAmount,
          tender,
        },
      });
    if (action === "settlePayee")
      await execute({
        action,
        input: { ...identity, amount: paymentAmount, tender },
      });
    if (action === "refund")
      await execute({
        action,
        input: {
          ...identity,
          amount: paymentAmount,
          originalPaymentId: Number(originalPayment),
          reason,
          reference: reference || null,
        },
      });
    if (action === "refundExcess")
      await execute({
        action,
        input: {
          ...identity,
          amount: paymentAmount,
          originalReceiptId: Number(originalPayment),
          reason,
          reference: reference || null,
        },
      });
    if (action === "refundCourierExcess") {
      const original = detail.data?.excessCollections.find(
        (p) => p.id === Number(originalPayment),
      );
      if (!original) {
        setError("اختر قيد القبض الزائد الأصلي");
        return;
      }
      await execute({
        action,
        input: {
          ...identity,
          amount: paymentAmount,
          originalExcessEntryId: original.id,
          consignmentId: original.consignmentId,
          reason,
          tender,
        },
      });
    }
    if (action === "recordCourierCollection")
      await execute({
        action,
        input: {
          branchId,
          clientRequestId: identity.clientRequestId,
          allocations: [
            {
              chargeId: row.id,
              expectedVersion: row.version,
              amount: paymentAmount,
            },
          ],
          partyId: Number(party),
          consignmentId: Number(consignment),
        },
      });
    if (action === "remitCourier")
      await execute({
        action,
        input: {
          ...identity,
          amount: paymentAmount,
          originalPaymentId: Number(originalPayment),
          tender,
        },
      });
  }
  async function verifyProof() {
    if (!branchId) {
      setError("اختر الفرع قبل إثبات الدفع");
      return;
    }
    try {
      setError("");
      const deviceId = persistentKey("fulfillment-charge-device");
      const attempt = await initiate.mutateAsync({
        branchId,
        method: method as "CARD" | "TRANSFER" | "WALLET",
        amount: paymentAmount,
        reference,
        requestId: persistentKey(
          `${scope}:proof:${selected}:${method}:${paymentAmount}:${reference}`,
        ),
        deviceId,
      });
      const result = await confirmProof.mutateAsync({
        branchId,
        attemptId: attempt.attemptId,
        deviceId,
      });
      if (result.state !== "CONFIRMED")
        throw new Error("لم يؤكد المزوّد عملية القبض بعد");
      setProof({
        attemptId: attempt.attemptId,
        amount: paymentAmount,
        method,
        reference,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تأكيد الدفع");
    }
  }
  const columns = useMemo<ColumnDef<Row>[]>(() => {
    const result: ColumnDef<Row>[] = [
      { accessorKey: "id", header: "الرقم" },
      { accessorKey: "description", header: "البيان" },
      { accessorKey: "customerName", header: "العميل" },
      {
        id: "category",
        header: "التصنيف",
        cell: ({ row }) =>
          fulfillmentChargeCategoryLabel[row.original.category],
      },
      {
        id: "status",
        header: "الحالة",
        cell: ({ row }) => fulfillmentChargeStatusLabel[row.original.status],
      },
      {
        accessorKey: "amount",
        header: "أجر العميل",
        cell: ({ row }) => fmt(row.original.amount),
      },
      {
        accessorKey: "remainingAmount",
        header: "المتبقي",
        cell: ({ row }) => fmt(row.original.remainingAmount),
      },
      {
        id: "payeeRemaining",
        accessorKey: "payeeRemaining",
        header: "مستحق الجهة",
        cell: ({ row }) =>
          row.original.payeeRemaining == null
            ? ""
            : fmt(row.original.payeeRemaining),
      },
      {
        id: "open",
        header: "التفاصيل",
        cell: ({ row }) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSelected(row.original.id);
              setAction(
                row.original.status === "DRAFT" ? "approve" : "collect",
              );
              setPaymentAmount(row.original.remainingAmount);
              setOriginalPayment("");
              setProof(null);
            }}
          >
            عرض وتنفيذ
          </Button>
        ),
      },
    ];
    return list.data?.costVisible
      ? result
      : result.filter((c) => c.id !== "payeeRemaining");
  }, [list.data?.costVisible]);
  const paymentColumns: ColumnDef<
    NonNullable<typeof detail.data>["payments"][number]
  >[] = [
    {
      id: "kind",
      header: "الحركة",
      cell: ({ row }) => paymentKindLabel[row.original.payment.kind],
    },
    {
      id: "amount",
      header: "المبلغ",
      cell: ({ row }) => fmt(row.original.payment.amount),
    },
    {
      id: "receipt",
      header: "الإيصال",
      cell: ({ row }) =>
        row.original.receipt ? (
          <a
            className="underline"
            href={`/vouchers/${row.original.receipt.id}`}
          >
            {row.original.receipt.id}
          </a>
        ) : (
          "بعهدة الناقل"
        ),
    },
    {
      id: "method",
      header: "الوسيلة / المصدر",
      cell: ({ row }) =>
        row.original.receipt
          ? `${paymentMethodCompact(row.original.receipt.paymentMethod)} / ${row.original.receipt.cashBucket === "DRAWER" ? "الدرج" : row.original.receipt.cashBucket === "TREASURY" ? "الخزينة" : "غير نقدي"}`
          : `جهة ${row.original.payment.partyId}`,
    },
  ];
  const disabled = busy || !!pending;
  const opts = lookup.data;
  const externalProofValid =
    proof?.amount === paymentAmount &&
    proof.method === method &&
    proof.reference === reference;
  return (
    <section dir="rtl" className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        {!embedded && (
          <Field label="الفرع">
            <AppSelect
              value={String(branchId ?? "")}
              onValueChange={(value) => {
                onBranchChange(value);
              }}
              disabled={busy}
            >
              <option value="">اختر الفرع</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </Field>
        )}
        <Button
          variant="outline"
          disabled={!branchId || disabled || !can("create")}
          onClick={() => setShowCreate((v) => !v)}
        >
          أجر أو مبلغ إضافي جديد
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          تحديث الأرصدة
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded border border-destructive p-3 text-sm text-destructive whitespace-pre-wrap"
        >
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {pending && (
        <div className="space-y-2 rounded border p-3 text-sm">
          <p>
            يوجد طلب محفوظ لم تصل نتيجته المؤكدة. أعد نفس الطلب لاسترجاع النتيجة
            دون قبض أو صرف مكرر.
          </p>
          <SubmitButton
            type="button"
            pending={busy}
            onClick={() => void execute(pending)}
          >
            إعادة الطلب المحفوظ
          </SubmitButton>
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm({
                  title: "إغلاق الطلب المحفوظ",
                  description:
                    "راجع المستند والإيصالات أولاً. إغلاق الطلب لا يلغي أي إجراء التزم في الخادم.",
                  variant: "warning",
                })
              ) {
                localStorage.removeItem(`${scope}:pending`);
                setPending(null);
                await refresh();
              }
            }}
          >
            راجعت النتيجة؛ إغلاق الطلب المحفوظ
          </Button>
        </div>
      )}
      {showCreate && (
        <form
          className="space-y-3 rounded border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCreate();
          }}
        >
          <p className="font-medium">
            مستند أجور مستقل — لا ينشئ فاتورة أو حركة مخزون
          </p>
          <UnifiedSearchInput
            value={lookupSearch}
            onChange={setLookupSearch}
            placeholder="بحث عن عميل أو طلب أو مستفيد"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="التصنيف">
              <AppSelect
                value={category}
                onValueChange={(v) =>
                  setCategory(v as FulfillmentChargeCategory)
                }
                disabled={disabled}
              >
                {FULFILLMENT_CHARGE_CATEGORIES.map((v) => (
                  <option key={v} value={v}>
                    {fulfillmentChargeCategoryLabel[v]}
                  </option>
                ))}
              </AppSelect>
            </Field>
            <Field label="طلب التوصيل">
              <AppSelect
                searchable
                value={request}
                onSearchChange={setLookupSearch}
                onValueChange={(v) => {
                  setRequest(v);
                  const r = opts?.requests.find((r) => r.id === Number(v));
                  if (r?.customerId) setCustomer(String(r.customerId));
                }}
                disabled={disabled}
              >
                <option value="">مستند مستقل</option>
                {linkedRequest.data &&
                  !opts?.requests.some(
                    (r) => r.id === linkedRequest.data.request.id,
                  ) && (
                    <option value={String(linkedRequest.data.request.id)}>
                      {linkedRequest.data.request.requestNumber} —{" "}
                      {linkedRequest.data.request.recipientName}
                    </option>
                  )}
                {opts?.requests.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.name} — {r.recipientName}
                  </option>
                ))}
              </AppSelect>
            </Field>
            {category !== "SHOP_EXPENSE" && (
              <Field label="العميل">
                <AppSelect
                  searchable
                  value={customer}
                  onSearchChange={setLookupSearch}
                  onValueChange={setCustomer}
                  disabled={disabled}
                >
                  <option value="">اختر عميلاً معروفاً</option>
                  {opts?.customers.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name} — {c.phone}
                    </option>
                  ))}
                </AppSelect>
              </Field>
            )}
            <Field label="بيان الأجر">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                maxLength={2000}
                disabled={disabled}
              />
            </Field>
            {category !== "SHOP_EXPENSE" && (
              <Field label="المطلوب من العميل">
                <MoneyInput
                  value={amount}
                  onChange={setAmount}
                  required
                  disabled={disabled}
                />
              </Field>
            )}
            {category !== "SERVICE" && (
              <>
                <Field label="تكلفة أو استحقاق الجهة">
                  <MoneyInput
                    value={externalCost}
                    onChange={setExternalCost}
                    required
                    disabled={disabled}
                  />
                </Field>
                <Field label="نوع المستفيد">
                  <AppSelect
                    value={payeeKind}
                    onValueChange={(v) => {
                      setPayeeKind(v);
                      setPayeeId("");
                    }}
                    disabled={disabled}
                  >
                    <option value="SUPPLIER">مورد</option>
                    <option value="PARTY">جهة توصيل</option>
                    <option value="USER">موظف</option>
                    <option value="NAMED">جهة خارجية مسماة</option>
                  </AppSelect>
                </Field>
                {payeeKind === "NAMED" ? (
                  <>
                    <Field label="اسم المستفيد">
                      <Input
                        value={payeeName}
                        onChange={(e) => setPayeeName(e.target.value)}
                        required
                        disabled={disabled}
                      />
                    </Field>
                    <Field label="هاتف المستفيد">
                      <IntlPhoneInput
                        value={payeePhone}
                        onChange={setPayeePhone}
                        disabled={disabled}
                      />
                    </Field>
                  </>
                ) : (
                  <Field label="المستفيد">
                    <AppSelect
                      searchable
                      value={payeeId}
                      onSearchChange={setLookupSearch}
                      onValueChange={setPayeeId}
                      disabled={disabled}
                    >
                      <option value="">اختر المستفيد</option>
                      {(payeeKind === "SUPPLIER"
                        ? opts?.suppliers
                        : payeeKind === "PARTY"
                          ? opts?.parties
                          : opts?.users
                      )?.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name}
                        </option>
                      ))}
                    </AppSelect>
                  </Field>
                )}
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            التحصيل بالنيابة: أجر العميل يساوي استحقاق الجهة. مصروف المكتبة لا
            ينشئ مطالبة على العميل. كل تكلفة جهة تحتاج اعتماد مسؤول مستقل.
          </p>
          <SubmitButton pending={busy} disabled={disabled || !can("create")}>
            حفظ المسودة
          </SubmitButton>
        </form>
      )}
      <DataTable
        data={list.data?.rows ?? []}
        columns={columns}
        loading={list.isLoading}
        errorState={{
          isError: list.isError,
          message: list.error?.message,
          onRetry: () => void list.refetch(),
        }}
        serverPagination={{
          page,
          onPageChange: setPage,
          pageSize: 25,
          total: list.data?.total,
          isFetching: list.isFetching,
        }}
        serverSearch={{ value: search, onChange: setSearch }}
        viewKey="fulfillment-charges"
      />
      {row && (
        <div className="space-y-3 rounded border p-3">
          <p className="font-medium">
            أجر {row.id}: {row.description} —{" "}
            {fulfillmentChargeStatusLabel[row.status]}
          </p>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <p>أجر العميل: {fmt(row.amount)}</p>
            <p>
              المقبوض: {fmt(row.paidAmount)} / المردود:{" "}
              {fmt(row.refundedAmount)}
            </p>
            <p>المتبقي: {fmt(detail.data?.remainingAmount ?? "0")}</p>
            {row.externalCost != null &&
              detail.data?.payeeRemaining != null && (
                <p>
                  تكلفة الجهة: {fmt(row.externalCost)} / المستحق:{" "}
                  {fmt(detail.data.payeeRemaining)}
                </p>
              )}
          </div>
          <p className="text-xs text-muted-foreground">
            العميل: {detail.data?.customer?.name ?? "مصروف المكتبة"} / الطلب:{" "}
            {detail.data?.request?.requestNumber ?? "مستقل"} / المستفيد:{" "}
            {row.payeeName ??
              (row.payeeSupplierId
                ? `مورد ${row.payeeSupplierId}`
                : row.payeePartyId
                  ? `جهة توصيل ${row.payeePartyId}`
                  : row.payeeUserId
                    ? `موظف ${row.payeeUserId}`
                    : "لا يوجد")}
          </p>
          <DataTable
            data={detail.data?.payments ?? []}
            columns={paymentColumns}
            pageSize={10}
            bounded={false}
            viewKey="fulfillment-charge-payments"
          />
          <form
            className="space-y-3 border-t pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitAction();
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="الإجراء">
                <AppSelect
                  value={action}
                  onValueChange={(v) => {
                    setAction(v as Exclude<Action, "create">);
                    setOriginalPayment("");
                    setProof(null);
                    if (["remitCourier", "refundCourierExcess"].includes(v))
                      setMethod("CASH");
                  }}
                  disabled={disabled}
                >
                  {row.status === "DRAFT" && (
                    <option value="approve">
                      اعتماد المطالبة واستحقاق الجهة
                    </option>
                  )}
                  {row.status !== "DRAFT" && (
                    <>
                      <option value="collect">قبض من العميل</option>
                      <option value="refund">
                        رد إلى العميل من تخصيصه الأصلي
                      </option>
                      <option value="refundExcess">رد أمانة فائض القبض</option>
                      <option value="refundCourierExcess">
                        رد أمانة قبض زائد لدى الناقل
                      </option>
                      {detail.data?.costVisible && (
                        <option value="settlePayee">
                          سداد الجهة المستفيدة
                        </option>
                      )}
                      <option value="recordCourierCollection">
                        إثبات قبض بعهدة الناقل
                      </option>
                      <option value="remitCourier">توريد عهدة الناقل</option>
                    </>
                  )}
                </AppSelect>
              </Field>
              {action !== "approve" && (
                <Field label="المبلغ الفعلي">
                  <MoneyInput
                    value={paymentAmount}
                    onChange={(v) => {
                      setPaymentAmount(v);
                      setProof(null);
                    }}
                    required
                    disabled={disabled}
                  />
                </Field>
              )}
              {["refund", "remitCourier"].includes(action) && (
                <Field label="تخصيص القبض الأصلي">
                  <AppSelect
                    value={originalPayment}
                    onValueChange={setOriginalPayment}
                    disabled={disabled}
                  >
                    <option value="">اختر حركة القبض</option>
                    {detail.data?.payments
                      .filter((p) =>
                        action === "refund"
                          ? ["COLLECTION", "COURIER_REMITTANCE"].includes(
                              p.payment.kind,
                            ) &&
                            p.receipt?.status === "COMPLETED" &&
                            p.receipt.approvalStatus === "APPROVED" &&
                            p.receipt.direction === "IN" &&
                            p.receipt.branchId === row.branchId
                          : p.payment.kind === "COURIER_COLLECTION",
                      )
                      .map((p) => (
                        <option key={p.payment.id} value={String(p.payment.id)}>
                          {paymentKindLabel[p.payment.kind] ?? "حركة"}{" "}
                          {p.payment.id}
                          {p.receipt ? ` — إيصال ${p.receipt.id}` : ""} —{" "}
                          {fmt(p.payment.amount)} —{" "}
                          {p.receipt
                            ? paymentMethodCompact(p.receipt.paymentMethod)
                            : "بعهدة الناقل"}
                        </option>
                      ))}
                  </AppSelect>
                </Field>
              )}
              {action === "refundExcess" && (
                <Field label="إيصال فائض القبض">
                  <AppSelect
                    value={originalPayment}
                    onValueChange={setOriginalPayment}
                    disabled={disabled}
                  >
                    <option value="">اختر الإيصال الأصلي</option>
                    {detail.data?.payments
                      .filter(
                        (p) => p.payment.kind === "COLLECTION" && p.receipt,
                      )
                      .map((p) => (
                        <option
                          key={p.payment.id}
                          value={String(p.receipt!.id)}
                        >
                          إيصال {p.receipt!.id} — الفعلي{" "}
                          {fmt(p.receipt!.amount)}
                        </option>
                      ))}
                  </AppSelect>
                </Field>
              )}
              {action === "refundCourierExcess" && (
                <Field label="إثبات القبض الزائد الأصلي">
                  <AppSelect
                    value={originalPayment}
                    onValueChange={setOriginalPayment}
                    disabled={disabled}
                  >
                    <option value="">اختر القبض الموثق</option>
                    {detail.data?.excessCollections.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        إرسالية {p.consignmentId} —{" "}
                        {new Date(p.createdAt).toLocaleDateString(
                          "ar-IQ-u-nu-latn",
                        )}{" "}
                        — المتاح للرد {fmt(p.remainingAmount)} من{" "}
                        {fmt(p.amount)}
                      </option>
                    ))}
                  </AppSelect>
                </Field>
              )}
              {["refund", "refundExcess", "refundCourierExcess"].includes(
                action,
              ) && (
                <Field label="سبب الرد">
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required
                    minLength={5}
                    disabled={disabled}
                  />
                </Field>
              )}
              {action === "recordCourierCollection" && (
                <>
                  <Field label="الناقل">
                    <AppSelect
                      searchable
                      value={party}
                      onValueChange={setParty}
                      disabled={disabled}
                    >
                      <option value="">اختر جهة التوصيل</option>
                      {opts?.parties.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name}
                        </option>
                      ))}
                    </AppSelect>
                  </Field>
                  <Field label="الإرسالية المرتبطة بالطلب">
                    <AppSelect
                      value={consignment}
                      onValueChange={setConsignment}
                      disabled={disabled}
                    >
                      <option value="">اختر الإرسالية</option>
                      {detail.data?.consignmentIds.map((id) => (
                        <option key={id} value={String(id)}>
                          إرسالية {id}
                        </option>
                      ))}
                    </AppSelect>
                  </Field>
                </>
              )}
              {[
                "collect",
                "settlePayee",
                "remitCourier",
                "refundCourierExcess",
              ].includes(action) && (
                <>
                  <Field label="الوسيلة الفعلية">
                    <AppSelect
                      value={method}
                      onValueChange={(v) => {
                        setMethod(v as typeof method);
                        setProof(null);
                      }}
                      disabled={disabled}
                    >
                      {(["remitCourier", "refundCourierExcess"].includes(action)
                        ? ["CASH"]
                        : ["CASH", "CARD", "TRANSFER", "WALLET"]
                      ).map((v) => (
                        <option key={v} value={v}>
                          {paymentMethodCompact(v)}
                        </option>
                      ))}
                    </AppSelect>
                  </Field>
                  {method === "CASH" && (
                    <>
                      <Field label="مصدر أو وجهة النقد">
                        <AppSelect
                          value={bucket}
                          onValueChange={(v) => setBucket(v as typeof bucket)}
                          disabled={disabled}
                        >
                          <option value="DRAWER">درج ورديتي</option>
                          <option value="TREASURY">
                            الخزينة — صلاحية إدارية
                          </option>
                        </AppSelect>
                      </Field>
                      {bucket === "DRAWER" && (
                        <Field label="الوردية المفتوحة">
                          <AppSelect
                            value={shift}
                            onValueChange={setShift}
                            disabled={disabled}
                          >
                            <option value="">اختر ورديتك</option>
                            {opts?.shifts.map((s) => (
                              <option key={s.id} value={String(s.id)}>
                                وردية {s.id} — {s.shiftType}
                              </option>
                            ))}
                          </AppSelect>
                        </Field>
                      )}
                    </>
                  )}
                </>
              )}
              {(["refund", "refundExcess"].includes(action) ||
                method !== "CASH") && (
                <Field
                  label={
                    action === "refund"
                      ? "مرجع رد المزوّد (لغير النقد)"
                      : "مرجع الدفع غير النقدي"
                  }
                >
                  <Input
                    value={reference}
                    onChange={(e) => {
                      setReference(e.target.value);
                      setProof(null);
                    }}
                    disabled={disabled}
                  />
                </Field>
              )}
            </div>
            {action === "collect" && method !== "CASH" && (
              <div className="space-y-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    disabled ||
                    !paymentAmount ||
                    !reference ||
                    initiate.isPending ||
                    confirmProof.isPending
                  }
                  onClick={() => void verifyProof()}
                >
                  تأكيد نجاح الدفع لدى المزوّد
                </Button>
                {externalProofValid && (
                  <p className="text-sm">
                    إثبات مقبوض مؤكد {proof?.attemptId} — {fmt(paymentAmount)}.
                    حفظ القبض يخصص الإثبات مرة واحدة.
                  </p>
                )}
              </div>
            )}
            {action === "refundCourierExcess" && (
              <p className="text-sm">
                رد الأمانة يخرج من النقد المتاح في المصدر المختار. قبض الناقل
                يبقى عهدة عليه حتى يورّده كاملاً، ولا تتغير ذمة العميل.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              الرد يلغي الجزء المردود من الأجر ويخرج من وسيلة ومصدر القبض
              الأصليين. التوريد يبرئ عهدة الناقل فقط. سداد الجهة لا ينشئ مصروفاً
              ثانياً.
            </p>
            {["approve", "settlePayee"].includes(action) &&
              !detail.data?.costVisible && (
                <p className="text-sm text-muted-foreground">
                  اعتماد الكلفة وسداد المستفيد يحتاجان صلاحية عرض التكلفة
                  والربح.
                </p>
              )}
            <SubmitButton
              pending={busy}
              disabled={
                disabled ||
                !can(action) ||
                (["approve", "settlePayee"].includes(action) &&
                  !detail.data?.costVisible) ||
                (action === "collect" &&
                  method !== "CASH" &&
                  !externalProofValid)
              }
            >
              تثبيت الإجراء
            </SubmitButton>
          </form>
          {detail.error && (
            <p role="alert" className="text-destructive">
              {detail.error.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
