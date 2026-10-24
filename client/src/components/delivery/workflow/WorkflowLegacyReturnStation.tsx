import { useEffect, useRef, useState, type RefObject } from "react";
import { Ban, Package, RefreshCcw, ScanLine } from "lucide-react";
import { trpc, type RouterInputs } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import CancelWorkOrderDialog, {
  CancelWorkOrderDialogById,
  type CancelDecision,
} from "@/components/workorder/CancelWorkOrderDialog";
import {
  ManagerApprovalDialog,
  type ManagerApprovalInput,
} from "@/components/reception/ManagerApprovalDialog";
import {
  workOrderDetailOperationAccess,
  workOrderDirectCancellationAllowed,
} from "@/lib/workOrderDetailOperationAccess";
import {
  invoiceStatusBadgeVariant,
  invoiceStatusLabel,
} from "@shared/invoiceStatus";
import { ACTION_LABELS } from "@shared/actionLabels";
import { docBarcode } from "@shared/documentNumber";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { newClientRequestId } from "@/lib/countQueue";

export interface WorkflowLegacyReturnSource {
  id: number;
  kind?: "workOrder" | "invoice" | "onlineOrder";
  orderNumber: string;
  title: string | null;
  status?: string | null;
  branchId?: number | null;
  customerName: string | null;
  customerPhone: string | null;
  salePrice: string;
  deposit: string | null;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryCost: string | null;
  version: number;
  invoiceId?: number | null;
  qrUrl?: string | null;
  activeConsignment?: {
    id: number;
    consignmentNumber: string;
    partyId: number;
    partyName: string | null;
    partyType: "INDIVIDUAL" | "COMPANY" | null;
    parcelStatus: string;
    moneyStatus: string;
    codAmount: string;
    collectedAmount: string;
  } | null;
}

export type WorkflowLegacyReturnStationProps = {
  source: WorkflowLegacyReturnSource | null;
  branchId?: number;
  actorId?: number;
  barcode: string;
  inputRef: RefObject<HTMLInputElement | null>;
  mode: "FULL" | "PARTIAL";
  onModeChange: (mode: "FULL" | "PARTIAL") => void;
  onBarcodeChange: (value: string) => void;
  onLookup: (value: string) => void | Promise<void>;
  onClear: () => void;
};
type CancelInput = RouterInputs["workOrders"]["cancel"];
type ControlInput = Extract<
  RouterInputs["workOrders"]["requestControl"],
  { requestType: "CANCEL" }
>;
type OnlineInput = RouterInputs["storeAdmin"]["orders"]["setStatus"];
type PendingAction =
  | { kind: "DIRECT"; input: CancelInput }
  | { kind: "CONTROL"; input: ControlInput }
  | { kind: "ONLINE"; input: OnlineInput };
const definitive = new Set([
  "BAD_REQUEST",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);

export function WorkflowLegacyReturnStation(
  props: WorkflowLegacyReturnStationProps,
) {
  return (
    <LegacyReturnContext
      key={`${props.actorId ?? ""}:${props.branchId ?? ""}:${props.source?.kind ?? ""}:${props.source?.id ?? "scan"}`}
      {...props}
    />
  );
}

function LegacyReturnContext({
  source,
  branchId,
  actorId,
  barcode,
  inputRef,
  mode,
  onModeChange,
  onBarcodeChange,
  onLookup,
  onClear,
}: WorkflowLegacyReturnStationProps) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isWorkOrder =
    source != null &&
    source.kind !== "invoice" &&
    source.kind !== "onlineOrder";
  const invoice = trpc.returns.getInvoice.useQuery(
    { invoiceId: source?.kind === "invoice" ? source.id : 0 },
    { enabled: source?.kind === "invoice" },
  );
  const order = trpc.workOrders.get.useQuery(
    { workOrderId: isWorkOrder ? source.id : 0 },
    { enabled: isWorkOrder },
  );
  const access = workOrderDetailOperationAccess(me.data);
  const preflight = trpc.workOrders.controlPreflight.useQuery(
    { workOrderId: isWorkOrder ? source.id : 0 },
    {
      enabled:
        isWorkOrder &&
        access.canReadControlPreflight &&
        access.canOpenCancellation,
    },
  );
  const direct = workOrderDirectCancellationAllowed(
    me.data,
    preflight.data,
    access.canCancelDirectly,
  );
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reviewedVersion, setReviewedVersion] = useState<number | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const replayKey =
    actorId && source
      ? `workflow-native-cancel:v1:${actorId}:${source.branchId ?? branchId}:${source.kind}:${source.id}`
      : null;
  const [pending, setPending] = useState<PendingAction | null>(() => {
    try {
      const value = replayKey
        ? (JSON.parse(
            sessionStorage.getItem(replayKey) ?? "null",
          ) as PendingAction | null)
        : null;
      const id =
        value?.kind === "ONLINE" ? value.input.id : value?.input.workOrderId;
      return value &&
        ["DIRECT", "CONTROL", "ONLINE"].includes(value.kind) &&
        id === source?.id
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const pendingRef = useRef(pending);
  const [reason, setReason] = useState(() =>
    pending?.kind === "ONLINE" ? (pending.input.cancelReason ?? "") : "",
  );
  function remember(value: PendingAction | null) {
    pendingRef.current = value;
    if (mounted.current) setPending(value);
    try {
      if (replayKey) {
        if (value)
          sessionStorage.setItem(
            replayKey,
            JSON.stringify(
              value.kind === "ONLINE"
                ? {
                    ...value,
                    input: { ...value.input, managerApproval: undefined },
                  }
                : value,
            ),
          );
        else sessionStorage.removeItem(replayKey);
      }
    } catch {
      /* The mounted command keeps its original recovery payload. */
    }
  }
  function completed(requested = false) {
    remember(null);
    void utils.workOrders.invalidate();
    void utils.delivery.invalidate();
    void utils.storeAdmin.orders.invalidate();
    if (!mounted.current) return;
    notify.ok(
      requested
        ? "أُرسل طلب الإلغاء للمراجعة؛ لم يُنفّذ رد أو حركة مخزون بعد"
        : "تم تنفيذ إجراء الإلغاء الأصلي",
    );
    onClear();
  }
  function failed(error: unknown) {
    const code = (error as { data?: { code?: string } } | null)?.data?.code;
    if (code && definitive.has(code)) remember(null);
    else if (mounted.current) setCancelOpen(false);
    if (mounted.current) notify.err(error);
  }
  const cancel = trpc.workOrders.cancel.useMutation({
    onSuccess: () => completed(),
    onError: failed,
  });
  const requestControl = trpc.workOrders.requestControl.useMutation({
    onSuccess: () => completed(true),
    onError: failed,
  });
  const cancelOnline = trpc.storeAdmin.orders.setStatus.useMutation({
    onSuccess: () => completed(),
    onError: (error) => {
      if (
        error.data?.code === "FORBIDDEN" &&
        /اعتماد المشرف المباشر/.test(error.message)
      ) {
        remember(null);
        if (mounted.current) setApprovalOpen(true);
      } else failed(error);
    },
  });
  const mutating =
    cancel.isPending ||
    requestControl.isPending ||
    cancelOnline.isPending ||
    retrying;
  const frozen = mutating || pending != null;
  function run(action: PendingAction) {
    if (action.kind === "DIRECT") cancel.mutate(action.input);
    else if (action.kind === "CONTROL") requestControl.mutate(action.input);
    else cancelOnline.mutate(action.input);
  }
  async function recover() {
    const action = pendingRef.current;
    if (!action || mutating) return;
    if (action.kind !== "ONLINE") {
      run(action);
      return;
    }
    setRetrying(true);
    try {
      const current = await utils.storeAdmin.orders.detail.fetch({
        id: action.input.id,
      });
      if (!mounted.current) return;
      if (current?.status === "CANCELLED") completed();
      else run(action);
    } catch (error) {
      if (mounted.current) notify.err(error);
    } finally {
      if (mounted.current) setRetrying(false);
    }
  }
  function submitCancellation(decision: CancelDecision) {
    if (
      !source ||
      pendingRef.current ||
      !preflight.data ||
      reviewedVersion == null ||
      reviewedVersion !== preflight.data.version
    ) {
      notify.err(
        "تغيّر الأمر أو لم يكتمل تمهيده؛ أغلق النموذج وافتحه على النسخة الحالية قبل التأكيد",
      );
      return;
    }
    if (!direct && !access.canRequestCancel) {
      notify.err(
        "يتطلب هذا الإلغاء طلب اعتماد لا يملكه حسابك؛ راجع الموظف المخوّل",
      );
      return;
    }
    const common = {
      refundShiftId: decision.refundShiftId,
      refundRail: decision.refundRail,
      refundReference: decision.refundReference,
      materials: decision.materials,
    };
    const action: PendingAction = direct
      ? {
          kind: "DIRECT",
          input: {
            workOrderId: source.id,
            branchId: order.data?.branchId ?? source.branchId ?? branchId,
            expectedVersion: reviewedVersion,
            reason: decision.reason,
            clientRequestId: newClientRequestId(),
            ...common,
          },
        }
      : {
          kind: "CONTROL",
          input: {
            requestType: "CANCEL",
            requestKey: newClientRequestId(),
            workOrderId: source.id,
            baseVersion: reviewedVersion,
            reason: decision.reason,
            payload: common,
          },
        };
    remember(action);
    run(action);
  }
  function submitOnline(managerApproval?: ManagerApprovalInput) {
    if (
      !source ||
      pendingRef.current ||
      source.kind !== "onlineOrder" ||
      source.activeConsignment ||
      reason.trim().length < 5
    )
      return;
    const action: PendingAction = {
      kind: "ONLINE",
      input: {
        id: source.id,
        status: "CANCELLED",
        cancelReason: reason.trim(),
        managerApproval,
      },
    };
    remember(action);
    setApprovalOpen(false);
    run(action);
  }
  const approvalPreflight =
    preflight.data == null
      ? null
      : {
          needsCashDrawer: preflight.data.cashRefundRequired,
          cardRefundAllowed: preflight.data.cardRefundAllowed,
          estimatedCashOut: preflight.data.expectedCashRefund,
          branchId: preflight.data.branchId,
          drawers: preflight.data.openReceptionShifts.map((shift) => ({
            shiftId: shift.id,
            userId: shift.userId,
            userName: shift.userName ?? `#${shift.userId}`,
            shiftType: "RECEPTION",
            ...(shift.expectedCash == null
              ? {}
              : { expectedCash: shift.expectedCash }),
            sufficient: shift.sufficient,
          })),
          treasuryCash: preflight.data.treasuryCash,
          treasurySufficient: preflight.data.treasurySufficient,
        };
  const activeShipment = source?.activeConsignment;
  const cancelled = (order.data?.status ?? source?.status) === "CANCELLED";
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="gap-0 p-4">
        <h2 className="mb-3 font-extrabold">نوع الإجراء</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(["FULL", "PARTIAL"] as const).map((value) => (
            <Button
              key={value}
              variant={mode === value ? "destructive" : "outline"}
              disabled={frozen}
              onClick={() => onModeChange(value)}
            >
              {value === "FULL" ? (
                <>
                  <Ban className="size-4" aria-hidden /> إلغاء / مرتجع كامل
                </>
              ) : (
                <>
                  <RefreshCcw className="size-4" aria-hidden /> مرتجع جزئي
                </>
              )}
            </Button>
          ))}
        </div>
      </Card>
      {pending && (
        <div role="status" className="space-y-2 rounded border p-3 text-sm">
          <p>
            نتيجة الإجراء لم تحسم بعد. استعد العملية الأصلية قبل تغيير القرار أو
            بدء إلغاء آخر.
          </p>
          <Button
            variant="outline"
            disabled={mutating}
            onClick={() => void recover()}
          >
            استعادة نتيجة العملية الأصلية
          </Button>
        </div>
      )}
      {!source && (
        <div className="rounded border border-dashed p-6 text-center">
          <ScanLine aria-hidden className="mx-auto size-8 text-destructive" />
          <p className="mt-2 font-semibold">امسح باركود الطلب أو الفاتورة</p>
          <div className="mt-4 flex gap-2">
            <UnifiedSearchInput
              ref={inputRef}
              value={barcode}
              onChange={onBarcodeChange}
              onScan={(value) => void onLookup(value)}
              onSubmit={(value) => {
                if (value.trim()) void onLookup(value.trim());
              }}
              placeholder="رقم الطلب أو الفاتورة (Enter)"
              className="flex-1 text-center font-bold"
              dir="ltr"
              barcode
            />
            <Button
              variant="outline"
              disabled={!barcode.trim() || !branchId}
              onClick={() => void onLookup(barcode.trim())}
            >
              بحث
            </Button>
          </div>
        </div>
      )}
      {source && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 font-bold">
                <Package className="size-4" aria-hidden />
                {source.orderNumber}
              </h3>
              <p className="text-sm text-muted-foreground">
                {source.customerName}
              </p>
            </div>
            <Button variant="ghost" disabled={frozen} onClick={onClear}>
              مسح مستند آخر
            </Button>
          </div>
          {activeShipment ? (
            <div role="status" className="space-y-2 rounded border p-3">
              <p>
                المصدر مرتبط بالإرسالية {activeShipment.consignmentNumber}. افتح
                إجراء الإرسالية الحالي لاستلامها وفحصها وتسوية آثارها.
              </p>
              <Button
                variant="outline"
                disabled={frozen}
                onClick={() =>
                  void onLookup(
                    docBarcode("CN", activeShipment.consignmentNumber),
                  )
                }
              >
                فتح إجراء الإرسالية
              </Button>
            </div>
          ) : source.kind === "invoice" ? (
            <>
              {invoice.data && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>فاتورة بيع #{invoice.data.invoiceNumber}</span>
                  <Badge
                    variant={invoiceStatusBadgeVariant(invoice.data.status)}
                  >
                    {invoiceStatusLabel(invoice.data.status)}
                  </Badge>
                  <span>{invoice.data.customerName || "زبون نقدي"}</span>
                </div>
              )}
              {invoice.error && (
                <p role="alert" className="text-destructive">
                  {invoice.error.message}
                </p>
              )}
              {!invoice.data && !invoice.error && (
                <p role="status">{ACTION_LABELS.loading}</p>
              )}
              {invoice.data?.branchId &&
                branchId &&
                invoice.data.branchId !== branchId && (
                  <p role="status" className="text-sm text-muted-foreground">
                    الفاتورة تخص الفرع #{invoice.data.branchId}؛ يراجع النموذج
                    سلطة الفرع ومصدر الرد الفعلي قبل التنفيذ.
                  </p>
                )}
              <ReturnComposer
                invoiceId={source.id}
                initialMode={mode}
                onDone={() => {
                  notify.ok("تم تسجيل المرتجع بنجاح");
                  void utils.workOrders.invalidate();
                  void utils.delivery.invalidate();
                  if (mounted.current) onClear();
                }}
              />
            </>
          ) : mode === "PARTIAL" ? (
            <div className="space-y-3 text-sm">
              <p>
                لإرجاع بنود وكميات محددة امسح الفاتورة الأصلية. إلغاء الطلب غير
                المسلّم يمر بمراجعة مصدر المال ومصير الخامات الفعلية.
              </p>
              <Button
                variant="outline"
                disabled={frozen}
                onClick={() => onModeChange("FULL")}
              >
                فتح إجراء إلغاء الطلب
              </Button>
            </div>
          ) : source.kind === "onlineOrder" ? (
            <>
              <p className="text-sm text-muted-foreground">
                إلغاء الطلب غير المسند يمر بحارس المتجر واعتماد المشرف عند
                الحاجة. لا يثبت هذا استلام طرد أو صرف رد مالي.
              </p>
              <label className="block space-y-1 text-sm">
                سبب الإلغاء
                <Input
                  value={reason}
                  disabled={frozen}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                />
              </label>
              <Button
                variant="destructive"
                disabled={frozen || cancelled || reason.trim().length < 5}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "إلغاء طلب المتجر غير المسند",
                      description: `#${source.orderNumber} — ${reason.trim()}`,
                      confirmText: "تأكيد الإلغاء",
                      variant: "warning",
                    })
                  ) {
                    if (mounted.current) submitOnline();
                  }
                }}
              >
                {cancelOnline.isPending
                  ? ACTION_LABELS.cancelling
                  : "إلغاء طلب المتجر"}
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm">
                قيمة الطلب: {fmt(order.data?.salePrice ?? source.salePrice)} د.ع
              </p>
              <p className="text-sm text-muted-foreground">
                يراجع النموذج الموحد الرد المستحق ورافده الفعلي، ويحدد الكمية
                العائدة والتالفة من الخامات قبل الإلغاء أو طلب اعتماده.
              </p>
              {(order.error || preflight.error) && (
                <p role="alert" className="text-destructive">
                  {order.error?.message ?? preflight.error?.message}
                </p>
              )}
              {(!access.canOpenCancellation ||
                (preflight.data && !direct && !access.canRequestCancel)) &&
                me.data && (
                  <p role="status" className="text-sm text-muted-foreground">
                    لا يملك حسابك إجراء إلغاء أمر الشغل؛ اطلبه من الموظف
                    المخوّل.
                  </p>
                )}
              {(order.isPending || preflight.isPending) && (
                <p role="status" className="text-sm text-muted-foreground">
                  {ACTION_LABELS.loading}
                </p>
              )}
              {cancelled && (
                <p role="status" className="text-sm text-destructive">
                  هذا الطلب ملغى مسبقاً.
                </p>
              )}
              {order.data?.status === "DELIVERED" && (
                <p role="status" className="text-sm text-muted-foreground">
                  الأمر مسلّم؛ افتح مصدر التسليم الحالي لمعالجة الرجوع الفعلي أو
                  حقوق العميل.
                </p>
              )}
              <Button
                variant="destructive"
                disabled={
                  frozen ||
                  cancelled ||
                  !access.canOpenCancellation ||
                  (!direct && !access.canRequestCancel) ||
                  !preflight.data ||
                  preflight.isFetching ||
                  !order.data ||
                  order.data.status === "DELIVERED"
                }
                onClick={() => {
                  setReviewedVersion(preflight.data!.version);
                  setCancelOpen(true);
                }}
              >
                {direct
                  ? "مراجعة إلغاء أمر الشغل"
                  : "مراجعة طلب إلغاء أمر الشغل"}
              </Button>
            </>
          )}
        </Card>
      )}
      {cancelOpen &&
        source &&
        isWorkOrder &&
        (direct ? (
          <CancelWorkOrderDialogById
            workOrderId={source.id}
            pending={frozen}
            onOpenChange={setCancelOpen}
            onConfirm={submitCancellation}
          />
        ) : (
          <CancelWorkOrderDialog
            open
            onOpenChange={setCancelOpen}
            workOrderId={source.id}
            orderNumber={order.data?.orderNumber ?? source.orderNumber}
            title={order.data?.title ?? source.title ?? ""}
            materials={
              order.data && ["IN_PROGRESS", "READY"].includes(order.data.status)
                ? (order.data.materials ?? []).map((row) => ({
                    id: Number(row.id),
                    name:
                      [row.productName, row.variantName]
                        .filter(Boolean)
                        .join(" — ") ||
                      row.sku ||
                      `#${row.variantId}`,
                    baseQuantity: Number(row.baseQuantity),
                    unitCost: row.unitCost ?? null,
                  }))
                : []
            }
            requiresApproval
            refundPreflight={approvalPreflight}
            refundPreflightPending={preflight.isFetching}
            refundPreflightError={preflight.isError}
            onRetryRefundPreflight={() => void preflight.refetch()}
            pending={frozen}
            onConfirm={submitCancellation}
          />
        ))}
      {approvalOpen && source?.kind === "onlineOrder" && (
        <ManagerApprovalDialog
          title="اعتماد إلغاء طلب المتجر"
          description="يتحقق الخادم من اعتماد المشرف لهذا الإلغاء قبل تغيير حالة الطلب."
          onApprove={submitOnline}
          onCancel={() => setApprovalOpen(false)}
        />
      )}
    </div>
  );
}
