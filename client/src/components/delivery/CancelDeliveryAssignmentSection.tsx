import { useCallback, useEffect, useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { Checkbox } from "@/components/ui/checkbox";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { docBarcode } from "@shared/documentNumber";
import type { WorkflowScanPreview } from "@shared/deliveryWorkflow";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import { WorkflowPrintActions } from "./workflow/WorkflowPrintActions";
import { useWorkflowDocumentPrinter } from "@/hooks/useWorkflowDocumentPrinter";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";

export interface ScannedOrderForCancellation {
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
  notes?: string | null;
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

export interface CancelDeliveryAssignmentSectionProps {
  branchId?: number | null;
  scannedBarcode?: string | null;
  onBarcodeConsumed?: () => void;
  onNavigateToDispatch?: (order: ScannedOrderForCancellation) => void;
  onNavigateToDispatchBarcode?: (raw: string) => void;
  onNavigateToAftercare?: (context: {
    caseId?: number;
    executionId?: number;
    raw?: string;
  }) => void;
  onOpenCharge?: (chargeId: number) => void;
  onAssignmentCancelled?: (
    orderNumber: string,
    consignmentNumber: string,
  ) => void;
}

export function CancelDeliveryAssignmentSection({
  branchId,
  scannedBarcode,
  onBarcodeConsumed,
  onNavigateToDispatch,
  onNavigateToDispatchBarcode,
  onNavigateToAftercare,
  onOpenCharge,
  onAssignmentCancelled,
}: CancelDeliveryAssignmentSectionProps) {
  const utils = trpc.useUtils();
  const [barcodeInput, setBarcodeInput] = useState("");
  const [preview, setPreview] = useState<WorkflowScanPreview | null>(null);
  const [completed, setCompleted] = useState<{
    label: string;
    action: "cancelAssignment" | "declareReturn" | "reassign";
    branchId: number;
    source: { kind: WorkflowScanPreview["source"]["kind"]; id: number };
    consignmentId: number;
  } | null>(null);
  const [sourceRaw, setSourceRaw] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<
    "cancelAssignment" | "declareReturn" | "reassign"
  >("cancelAssignment");
  const [partyId, setPartyId] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [externalTrackingRef, setExternalTrackingRef] = useState("");
  const [physicalHeld, setPhysicalHeld] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const sequence = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const retryIdentity = useRef<{ signature: string; key: string } | null>(null);
  const parties = trpc.delivery.listParties.useQuery(
    { activeOnly: true },
    { staleTime: 60_000 },
  );
  const members = trpc.delivery.partyMembers.useQuery(
    { partyId: Number(partyId) },
    { enabled: !!partyId, staleTime: 30_000 },
  );
  const target = parties.data?.find((p) => String(p.id) === partyId);
  const drivers = (members.data ?? []).filter(
    (m) => m.isActive && m.memberRole === "DRIVER",
  );
  const internalDriverRequired =
    target?.partyType === "INDIVIDUAL" &&
    (target.userId != null || drivers.length > 0);
  const workflowPrinter = useWorkflowDocumentPrinter(preview?.source.branchId ?? completed?.branchId ?? branchId);
  const busyRef = useRef(false);
  const mutation = trpc.delivery.workflow.assignment.useMutation({
    onError: (error) =>
      notify.err(error, "تعذر الإجراء؛ بقيت بياناته لإعادة المحاولة"),
  });
  busyRef.current = mutation.isPending;
  useEffect(() => {
    sequence.current++;
    setPreview(null);
    setCompleted(null);
    setSourceRaw("");
    setReason("");
    retryIdentity.current = null;
    return () => {
      sequence.current++;
    };
  }, [branchId]);
  const lookup = useCallback(
    async (raw: string) => {
      if (busyRef.current || !raw.trim()) return;
      const generation = ++sequence.current;
      setIsSearching(true);
      try {
        const next = await utils.delivery.workflow.preview.fetch({
          raw,
          station: "cancelAssignment",
          branchId: branchId ?? undefined,
        });
        if (generation !== sequence.current || busyRef.current) return;
        setPreview(next);
        setCompleted(null);
        setSourceRaw(raw);
        setReason("");
        setPartyId("");
        setAssignedUserId("");
        setExternalTrackingRef("");
        setPhysicalHeld(false);
        retryIdentity.current = null;
        setMode(
          next.actions.some((a) => a.action === "cancelAssignment" && a.allowed)
            ? "cancelAssignment"
            : next.actions.some(
                  (a) => a.action === "declareReturn" && a.allowed,
                )
              ? "declareReturn"
              : "reassign",
        );
        setBarcodeInput("");
        onBarcodeConsumed?.();
      } catch (error) {
        if (generation === sequence.current)
          notify.err(error, "تعذر قراءة المصدر الحالي");
      } finally {
        if (generation === sequence.current) setIsSearching(false);
      }
    },
    [utils, branchId, onBarcodeConsumed],
  );
  const externalRaw = useRef<string | null>(null);
  useEffect(() => {
    if (!scannedBarcode) {
      externalRaw.current = null;
      return;
    }
    if (externalRaw.current === scannedBarcode || busyRef.current) return;
    externalRaw.current = scannedBarcode;
    void lookup(scannedBarcode);
  }, [scannedBarcode, lookup]);
  const action = preview?.actions.find((a) => a.action === mode);
  const isAftercare = preview?.relations.aftercareExecutionId != null;
  const openAftercare = () =>
    preview &&
    onNavigateToAftercare?.({
      caseId: preview.relations.aftercareCaseId,
      executionId: preview.relations.aftercareExecutionId,
      raw: sourceRaw,
    });
  const goDispatch = async () => {
    if (!preview) return;
    if (onNavigateToDispatchBarcode) {
      onNavigateToDispatchBarcode(sourceRaw);
      return;
    }
    if (
      onNavigateToDispatch &&
      ["invoice", "workOrder", "onlineOrder"].includes(preview.source.kind)
    ) {
      const prefix =
        preview.source.kind === "invoice"
          ? "INV"
          : preview.source.kind === "workOrder"
            ? "WO"
            : "ORD";
      const original = await utils.workOrders.getByNumber.fetch({
        orderNumber: docBarcode(prefix, preview.source.number),
      });
      if (original)
        onNavigateToDispatch({
          ...original,
          version:
            "version" in original && typeof original.version === "number"
              ? original.version
              : 1,
        });
    }
  };
  async function execute() {
    if (
      !preview ||
      mutation.isPending ||
      !action?.allowed ||
      reason.trim().length < 3
    )
      return;
    if (
      mode === "reassign" &&
      (!partyId || (internalDriverRequired && !assignedUserId))
    ) {
      notify.err("اختر جهة التوصيل والمندوب الموظف المرتبط بها صراحةً");
      return;
    }
    if (mode === "cancelAssignment" && !physicalHeld) {
      notify.err(
        "تحقق أولاً أن كامل الشحنة عادت فعلياً إلى عهدة المكتبة",
      );
      return;
    }
    const label =
      mode === "cancelAssignment"
        ? "إلغاء الإسناد"
        : mode === "declareReturn"
          ? "إعلان رجوع الطرد"
          : "إعادة الإسناد";
    if (
      !(await confirm({
        title: label,
        description: `${preview.printSource.number} — ${preview.recipient.name ?? "المستلم"}\n${reason.trim()}\nإلغاء الإسناد يفك عهدة الجهة بعد عودة كامل الشحنة، ولا يلغي البيع أو يعيد المخزون. إعلان الرجوع وحده لا يثبت الاستلام.`,
        confirmText: label,
        variant: mode === "reassign" ? "info" : "warning",
      }))
    )
      return;
    const payload = {
      source: {
        kind: preview.source.kind,
        id: preview.source.id,
        expectedVersion: preview.source.version,
      },
      branchId: preview.source.branchId,
      action: mode,
      reason: reason.trim(),
      partyId: mode === "reassign" ? Number(partyId) : undefined,
      assignedUserId: assignedUserId ? Number(assignedUserId) : undefined,
      externalTrackingRef: externalTrackingRef.trim() || undefined,
      physicalHeldConfirmed: physicalHeld,
    };
    const signature = JSON.stringify(payload);
    if (retryIdentity.current?.signature !== signature)
      retryIdentity.current = { signature, key: crypto.randomUUID() };
    const packWin = preopenDocumentWindow();
    const labelWin = mode === "reassign" ? preopenShippingLabelWindow() : null;
    let committed = false;
    try {
      const result = await mutation.mutateAsync({
        ...payload,
        clientRequestId: retryIdentity.current.key,
      });
      committed = true;
      setCompleted({
        label,
        action: mode,
        branchId: preview.source.branchId,
        source: { kind: preview.source.kind, id: preview.source.id },
        consignmentId: result.consignmentId,
      });
      retryIdentity.current = null;
      notify.ok(`تم ${label}`);
      if (mode === "reassign") {
        void workflowPrinter.printShipmentAndLabel(result.consignmentId, packWin, labelWin, preview.source.branchId);
      } else {
        void workflowPrinter.printLatestByType(result.consignmentId, "PHYSICAL_RETURN_RECEIPT", packWin, preview.source.branchId);
      }
      if (mode === "cancelAssignment")
        onAssignmentCancelled?.(
          preview.source.number,
          preview.group?.consignmentNumber ?? "",
        );
      setPreview(null);
      await Promise.all([
        utils.delivery.workflow.invalidate(),
        utils.delivery.openConsignments.invalidate(),
        utils.delivery.obligations.invalidate(),
      ]);
      const fresh = await utils.delivery.workflow.previewBySource.fetch({
        source: { kind: preview.source.kind, id: preview.source.id },
        station: "cancelAssignment",
        branchId: preview.source.branchId,
      });
      setPreview(fresh);
      if (fresh.actions.some((a) => a.action === "reassign" && a.allowed))
        setMode("reassign");
      setReason("");
      setPhysicalHeld(false);
    } catch {
      if (!committed) {
        if (packWin && !packWin.closed) packWin.close();
        if (labelWin && !labelWin.closed) labelWin.close();
      }
      if (committed)
        notify.warn(
          "تم الإجراء وحفظ مستنداته؛ تعذر تحديث المعاينة فقط",
          "استخدم نتيجة الإجراء للطباعة، ولا تعِد المعاملة",
        );
      /* Mutation error preserves the same retry identity and draft. */
    }
  }
  return (
    <div className="mx-auto max-w-2xl space-y-4" dir="rtl">
      <div className="rounded-xl border border-dashed p-4 space-y-3">
        <p className="flex items-center gap-2 font-bold">
          <ScanLine aria-hidden className="size-5" /> مسح مصدر التوصيل لإلغاء
          الإسناد أو إعلان الرجوع
        </p>
        <UnifiedSearchInput
          ref={inputRef}
          value={barcodeInput}
          onChange={setBarcodeInput}
          onScan={(raw) => void lookup(raw)}
          onSubmit={(raw) => void lookup(raw)}
          placeholder="باركود الفاتورة أو الطلب أو CN أو AE"
          barcode
          dir="ltr"
          disabled={mutation.isPending}
        />
        {isSearching && (
          <p className="text-sm text-muted-foreground">{L.loading}</p>
        )}
      </div>
      {completed && (
        <Card className="p-3 space-y-2" role="status">
          <p className="font-medium">
            تم {completed.label}؛ مستندات الإجراء محفوظة.
          </p>
          <WorkflowPrintActions
            branchId={completed.branchId}
            source={completed.source}
            consignmentId={completed.consignmentId}
            mode={completed.action === "reassign" ? "dispatch" : "cancel"}
          />
        </Card>
      )}
      {preview && (
        <Card className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <strong dir="ltr">{preview.printSource.number}</strong>
            <Button
              variant="ghost"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => {
                sequence.current++;
                setPreview(null);
                retryIdentity.current = null;
                inputRef.current?.focus();
              }}
            >
              مسح آخر
            </Button>
          </div>
          <p className="text-sm">
            {preview.recipient.name ?? "مستلم عابر"} —{" "}
            {preview.recipient.phone ?? "حدد هوية المستلم في طلبه"}
          </p>
          <p className="text-sm text-muted-foreground">
            المطلوب الحالي {fmt(preview.money.codAmount)} د.ع ·{" "}
            {preview.group?.consignmentIds.length ?? 0} مستند توصيل مرتبط
          </p>
          <WorkflowPrintActions
            branchId={preview.source.branchId}
            preview={preview}
            mode="cancel"
          />
          {preview.relations.chargeId != null && (
            <Button
              variant="outline"
              onClick={() => onOpenCharge?.(preview.relations.chargeId!)}
            >
              فتح مستند الأجور
            </Button>
          )}
          {isAftercare && (
            <Button variant="outline" onClick={openAftercare}>
              فتح المعالجة وإثبات العهدة أو تجهيز إعادة الإصدار
            </Button>
          )}
          {preview.relations.consignmentId == null ? (
            <div className="space-y-2">
              <p className="text-sm">
                لا توجد إرسالية قائمة؛ افتح المصدر في محطة الإرسال.
              </p>
              <Button onClick={() => void goDispatch()}>
                فتح الإرسال بنفس المصدر
              </Button>
            </div>
          ) : (
            <>
              <AppSelect
                value={mode}
                onValueChange={(value) => {
                  setMode(value as typeof mode);
                  setPhysicalHeld(false);
                }}
                disabled={mutation.isPending}
              >
                <option
                  value="cancelAssignment"
                  disabled={
                    !preview.actions.find(
                      (item) => item.action === "cancelAssignment",
                    )?.allowed
                  }
                >
                  إلغاء الإسناد — عادت الشحنة للمكتبة
                </option>
                <option
                  value="declareReturn"
                  disabled={
                    !preview.actions.find(
                      (item) => item.action === "declareReturn",
                    )?.allowed
                  }
                >
                  إعلان الرجوع — دون إثبات استلام
                </option>
                <option
                  value="reassign"
                  disabled={
                    !preview.actions.find((item) => item.action === "reassign")
                      ?.allowed
                  }
                >
                  إعادة الإسناد للمندوب
                </option>
              </AppSelect>
              {!action?.allowed && (
                <p className="text-sm text-muted-foreground">
                  {action?.reason}
                </p>
              )}
              <Label htmlFor="workflow-cancel-reason">سبب الإجراء</Label>
              <Textarea
                id="workflow-cancel-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                disabled={mutation.isPending}
              />
              {mode === "cancelAssignment" && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={physicalHeld}
                    onCheckedChange={(checked) =>
                      setPhysicalHeld(checked === true)
                    }
                    disabled={mutation.isPending}
                  />{" "}
                  تحققت فعلياً أن كامل الشحنة عادت إلى عهدة المكتبة
                </label>
              )}
              {mode === "reassign" && !isAftercare && (
                <div className="space-y-2">
                  <AppSelect
                    value={partyId}
                    onValueChange={(value) => {
                      setPartyId(value);
                      setAssignedUserId("");
                    }}
                    disabled={mutation.isPending}
                  >
                    <option value="">اختر جهة التوصيل</option>
                    {(parties.data ?? [])
                      .filter(
                        (p) =>
                          p.branchId == null ||
                          p.branchId === preview.source.branchId,
                      )
                      .map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name}
                        </option>
                      ))}
                  </AppSelect>
                  {target?.partyType === "COMPANY" && (
                    <div className="space-y-1">
                      <Label htmlFor="workflow-reassign-tracking">
                        رقم بوليصة الشركة
                      </Label>
                      <Input
                        id="workflow-reassign-tracking"
                        value={externalTrackingRef}
                        onChange={(event) =>
                          setExternalTrackingRef(event.target.value)
                        }
                        dir="ltr"
                        disabled={mutation.isPending}
                        maxLength={100}
                      />
                    </div>
                  )}
                  {(drivers.length > 0 || target?.userId != null) && (
                    <AppSelect
                      value={assignedUserId}
                      onValueChange={setAssignedUserId}
                      disabled={mutation.isPending || members.isLoading}
                    >
                      <option value="">اختر المندوب الموظف صراحةً</option>
                      {target?.userId != null &&
                        !drivers.some((d) => d.userId === target.userId) && (
                          <option value={String(target.userId)}>
                            {target.name}
                          </option>
                        )}
                      {drivers.map((d) => (
                        <option key={d.userId} value={String(d.userId)}>
                          {d.name ?? d.username ?? `موظف ${d.userId}`}
                        </option>
                      ))}
                    </AppSelect>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    !action?.allowed ||
                    reason.trim().length < 3 ||
                    mutation.isPending ||
                    (mode === "cancelAssignment" && !physicalHeld) ||
                    (mode === "reassign" &&
                      (!partyId || (internalDriverRequired && !assignedUserId)))
                  }
                  onClick={() => void execute()}
                >
                  {mutation.isPending
                    ? L.saving
                    : mode === "cancelAssignment"
                      ? "إلغاء الإسناد"
                      : mode === "declareReturn"
                        ? "تسجيل إعلان الرجوع"
                        : "تأكيد إعادة الإسناد"}
                </Button>
                {onNavigateToDispatchBarcode && (
                  <Button
                    variant="outline"
                    onClick={() => void goDispatch()}
                    disabled={mutation.isPending}
                  >
                    فتح الإرسال بنفس المصدر
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
