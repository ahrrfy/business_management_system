import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Package,
  Printer,
  ScanLine,
  Trash2,
  Truck,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useIsMutating } from "@tanstack/react-query";
import { RequestsWorkspace } from "@/components/fulfillment/RequestsWorkspace";
import { deliveryDriverOptions, requiresDeliveryDriver } from "../driverOptions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import {
  printDeliveryDispatchSlipAsync,
  type DispatchSlipData,
} from "@/lib/printing/printDeliveryDispatchSlip";
import {
  preopenShippingLabelWindow,
  printShippingLabel,
} from "@/lib/printing/shippingLabel";
import type {
  WorkflowDispatchBatchInput,
  WorkflowDispatchBatchResult,
  WorkflowScanPreview,
} from "@shared/deliveryWorkflow";
import {
  appendDispatchDraftCode,
  commitDispatchDraft,
  dispatchRestorePlan,
  readDispatchDraft,
  writeDispatchDraft,
  type WorkflowDispatchDraft,
} from "./dispatchDraft";

type Party = RouterOutputs["delivery"]["listParties"][number];
type DeliveryDocumentSnapshot =
  RouterOutputs["delivery"]["documents"]["list"][number];
type Scanned = { raw: string; preview: WorkflowScanPreview };

type DispatchSnapshotPayload = {
  eventOccurredAt: string;
  shipment: {
    consignmentId: number;
    consignmentNumber: string;
    fulfillmentRequestId: number | null;
    sourceType: string;
    sourceId: number;
  };
  party: { id: number; name: string };
  recipient: {
    name: string | null;
    phone: string | null;
    address: string | null;
    governorate: string | null;
  };
  money: {
    codAmount: string;
    deliveryFee: string;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
    currentTotal: string;
    paidAmount: string;
  };
  invoices: Array<{
    id: number;
    invoiceNumber: string;
    total: string;
  }>;
};

function dispatchSnapshotPayload(
  snapshot: DeliveryDocumentSnapshot,
): DispatchSnapshotPayload {
  const payload = snapshot.payload as Partial<DispatchSnapshotPayload> | null;
  if (
    !payload ||
    !payload.shipment?.consignmentNumber ||
    !payload.party?.name ||
    !payload.recipient ||
    !payload.money ||
    !Array.isArray(payload.invoices)
  )
    throw new Error("لقطة مستند الإسناد ناقصة؛ أعد إنشاء الحزمة من مسؤول النظام");
  return payload as DispatchSnapshotPayload;
}
const definitiveErrors = new Set([
  "BAD_REQUEST",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);

export function WorkflowDispatchStation({
  branchId,
  userId,
  parties,
  scannedBarcode,
  onBarcodeConsumed,
  onAftercare,
  onRefunds,
}: {
  branchId: number;
  userId: number;
  parties: Party[];
  scannedBarcode?: string | null;
  onBarcodeConsumed?: () => void;
  onAftercare?: (raw: string) => void;
  onRefunds?: (codes: string[]) => void;
}) {
  const [draft, setDraft] = useState(() => readDispatchDraft(userId, branchId));
  const draftRef = useRef(draft);
  const submitLock = useRef(false);
  const queuedCodes = useRef(new Set<string>());
  const [rows, setRows] = useState<Scanned[]>([]);
  const [input, setInput] = useState("");
  const [requestContext, setRequestContext] = useState<{
    requestId?: number;
  } | null>(null);
  const requestBusy = useIsMutating() > 0;
  const [pendingScans, setPendingScans] = useState(0);
  const [message, setMessage] = useState("");
  const [committed, setCommitted] =
    useState<WorkflowDispatchBatchResult | null>(
      () => draft.lastCommitted?.result ?? null,
    );
  const [printing, setPrinting] = useState(false);
  const [printMessage, setPrintMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const rowsRef = useRef<Scanned[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);
  const mounted = useRef(true);
  const restored = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const dispatch = trpc.delivery.workflow.dispatchBatch.useMutation();
  const requestDocumentPrint =
    trpc.delivery.documents.requestPrint.useMutation();
  const completeDocumentPrint =
    trpc.delivery.documents.completePrint.useMutation();
  const availableParties = parties.filter(
    (party) => party.branchId == null || party.branchId === branchId,
  );
  const selectedParty = availableParties.find(
    (p) => String(p.id) === draft.partyId,
  );
  const frozen = draft.pending != null;
  const formFrozen = frozen || confirming || dispatch.isPending;
  const references = rows.map(({ preview }) => ({
    kind: preview.source.kind,
    id: preview.source.id,
    expectedVersion: preview.source.version,
  }));
  const batch = trpc.delivery.workflow.previewBatch.useQuery(
    {
      sources: references,
      branchId,
      deliveryFee: draft.deliveryFee,
      feeCollection: draft.feeCollection,
    },
    { enabled: references.length > 0 && pendingScans === 0 && !frozen },
  );
  const aftercare =
    rows.length === 1 && rows[0].preview.source.kind === "aftercareExecution";
  const blocked = batch.data?.blockedReasons ?? [];
  const summary = batch.data?.summary;
  const unresolvedCodes = draft.codes.filter(
    (code) => !rows.some((row) => row.raw === code),
  );
  const drivers = deliveryDriverOptions(selectedParty, branchId);
  const needsDriver = requiresDeliveryDriver(selectedParty);

  const persistDraft = useCallback(
    (update: (current: WorkflowDispatchDraft) => WorkflowDispatchDraft) => {
      const next = update(draftRef.current);
      draftRef.current = next;
      writeDispatchDraft(userId, branchId, next);
      setDraft(next);
    },
    [userId, branchId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const change = useCallback(
    <K extends keyof WorkflowDispatchDraft>(
      key: K,
      value: WorkflowDispatchDraft[K],
    ) => {
      if (submitLock.current) return;
      persistDraft((old) => (old.pending ? old : { ...old, [key]: value }));
    },
    [persistDraft],
  );
  const syncRows = useCallback(
    (next: Scanned[], pruneCodes = false) => {
      if (pruneCodes && submitLock.current) return;
      rowsRef.current = next;
      setRows(next);
      if (pruneCodes) {
        queuedCodes.current = new Set(next.map((row) => row.raw));
        persistDraft((old) => ({ ...old, codes: next.map((row) => row.raw) }));
      }
    },
    [persistDraft],
  );

  const enqueue = useCallback(
    (raw: string, restore = false) => {
      const code = raw.trim();
      if (
        !code ||
        requestContext != null ||
        draftRef.current.pending ||
        submitLock.current ||
        dispatch.isPending
      )
        return false;
      if (queuedCodes.current.has(code)) {
        const existing = rowsRef.current.find((row) => row.raw === code);
        setMessage(
          existing
            ? `المستند ${existing.preview.source.number} موجود في القائمة؛ لم يضف ثانية`
            : "المستند قيد القراءة؛ احتفظنا بالمسحة الأولى",
        );
        setInput("");
        return true;
      }
      if (
        !draftRef.current.codes.includes(code) &&
        draftRef.current.codes.length >= 30
      ) {
        setMessage("القائمة مكتملة؛ الحد 30 مستنداً");
        return false;
      }
      queuedCodes.current.add(code);
      if (!restore) persistDraft((old) => appendDispatchDraftCode(old, code));
      const currentGeneration = generation.current;
      setPendingScans((value) => value + 1);
      queue.current = queue.current
        .then(async () => {
          const forgetCode = () => {
            queuedCodes.current.delete(code);
            persistDraft((old) => ({
              ...old,
              codes: old.codes.filter((saved) => saved !== code),
            }));
          };
          try {
            if (!mounted.current || currentGeneration !== generation.current)
              return;
            const preview = await utils.delivery.workflow.preview.fetch({
              raw: code,
              station: "dispatch",
              branchId,
            });
            if (!mounted.current || currentGeneration !== generation.current)
              return;
            const key = preview.group?.key ?? preview.source.canonicalKey;
            if (
              rowsRef.current.some(
                (row) =>
                  (row.preview.group?.key ??
                    row.preview.source.canonicalKey) === key,
              )
            ) {
              setMessage(
                `المستند ${preview.source.number} موجود في القائمة؛ لم يضف ثانية`,
              );
              forgetCode();
              return;
            }
            if (rowsRef.current.length >= 30) {
              setMessage("القائمة مكتملة؛ الحد 30 مستنداً");
              forgetCode();
              return;
            }
            const first = rowsRef.current[0]?.preview;
            if (
              first &&
              (first.source.branchId !== preview.source.branchId ||
                first.recipient.customerId !== preview.recipient.customerId ||
                (first.recipient.customerId == null &&
                  first.recipient.phone !== preview.recipient.phone))
            ) {
              setMessage(
                "لم يضف المستند: العميل أو هاتف المستلم أو الفرع يختلف عن القائمة الحالية",
              );
              forgetCode();
              return;
            }
            syncRows([...rowsRef.current, { raw: code, preview }]);
            if (!first)
              persistDraft((old) => ({
                ...old,
                name: restore
                  ? old.name || preview.recipient.name || ""
                  : (preview.recipient.name ?? ""),
                phone: restore
                  ? old.phone || preview.recipient.phone || ""
                  : (preview.recipient.phone ?? ""),
                address: restore
                  ? old.address || preview.recipient.address || ""
                  : (preview.recipient.address ?? ""),
                deliveryFee: restore
                  ? old.deliveryFee
                  : preview.money.deliveryFee,
                feeCollection: restore
                  ? old.feeCollection
                  : preview.source.kind === "aftercareExecution"
                    ? "SHOP"
                    : preview.money.feeCollection,
              }));
            setMessage(`أضيف ${preview.source.number}`);
            setInput("");
            inputRef.current?.focus();
          } catch (error) {
            if (mounted.current && currentGeneration === generation.current) {
              queuedCodes.current.delete(code);
              setInput(code);
              notify.err(
                error,
                "تعذر قراءة المستند؛ بقي الرمز محفوظاً لإعادة المحاولة",
              );
            }
          } finally {
            if (mounted.current && currentGeneration === generation.current)
              setPendingScans((value) => Math.max(0, value - 1));
          }
        })
        .catch(() => undefined);
      return true;
    },
    [
      branchId,
      dispatch.isPending,
      persistDraft,
      requestContext,
      syncRows,
      utils,
    ],
  );

  useEffect(() => {
    if (dispatch.isPending || confirming || submitLock.current) return;
    const plan = dispatchRestorePlan(
      restored.current,
      generation.current,
      draftRef.current,
    );
    if (!plan) return;
    restored.current = plan.generation;
    queuedCodes.current.clear();
    rowsRef.current = [];
    setRows([]);
    setPendingScans(0);
    queue.current = Promise.resolve();
    if (plan.requiresRecovery) {
      setMessage(
        "توجد عملية إسناد لم تحسم نتيجتها؛ استعد النتيجة نفسها قبل بدء عملية أخرى",
      );
      return;
    }
    for (const raw of plan.codes) enqueue(raw, true);
  }, [draft.codes, draft.pending, enqueue, dispatch.isPending, confirming]);
  const externalScan = useRef<{ raw: string; generation: number } | null>(null);
  useEffect(() => {
    if (!scannedBarcode) {
      externalScan.current = null;
      return;
    }
    if (
      externalScan.current?.raw === scannedBarcode &&
      externalScan.current.generation === generation.current
    )
      return;
    if (enqueue(scannedBarcode)) {
      externalScan.current = {
        raw: scannedBarcode,
        generation: generation.current,
      };
      onBarcodeConsumed?.();
    }
  }, [
    scannedBarcode,
    enqueue,
    onBarcodeConsumed,
    confirming,
    frozen,
    dispatch.isPending,
  ]);
  useBarcodeScanner(enqueue, {
    enabled:
      !frozen && !dispatch.isPending && !confirming && requestContext == null,
    ignoreInputFields: true,
  });

  async function printResult(
    result: Pick<WorkflowDispatchBatchResult, "consignmentId">,
    labelWindow?: Window | null,
  ) {
    setPrinting(true);
    try {
      const snapshots = await utils.delivery.documents.list.fetch({
        sourceType: "SHIPMENT",
        sourceId: result.consignmentId,
        branchId,
      });
      const slipSnapshot = snapshots.find(
        (snapshot) => snapshot.documentType === "DISPATCH_SLIP",
      );
      const labelSnapshot = snapshots.find(
        (snapshot) => snapshot.documentType === "SHIPPING_LABEL",
      );
      if (!slipSnapshot || !labelSnapshot)
        throw new Error(
          "لم تكتمل لقطات حزمة الإسناد؛ لا تطبع من القيم الحية",
        );
      const payload = dispatchSnapshotPayload(slipSnapshot);
      const hasPrintedSlip = slipSnapshot.printHistory.some(
        (attempt) => attempt.status === "SENT",
      );
      const slipCopy = hasPrintedSlip ? "REPRINT" : "ORIGINAL";
      const slipAttempt = await requestDocumentPrint.mutateAsync({
        snapshotId: slipSnapshot.id,
        branchId,
        clientRequestId: crypto.randomUUID(),
        copyType: slipCopy,
        ...(slipCopy === "REPRINT"
          ? { reason: "طلب إعادة طباعة من محطة الإسناد" }
          : {}),
      });
      const invoice = payload.invoices.length === 1 ? payload.invoices[0] : null;
      const slip: DispatchSlipData = {
        sourceType: payload.shipment.sourceType,
        sourceId: payload.shipment.sourceId,
        fulfillmentRequestId: payload.shipment.fulfillmentRequestId,
        invoiceId: invoice?.id ?? null,
        invoiceNumber: invoice?.invoiceNumber ?? null,
        consignmentNumber: payload.shipment.consignmentNumber,
        orderNumber:
          payload.invoices.map((item) => item.invoiceNumber).join("، ") ||
          payload.shipment.consignmentNumber,
        orderKind:
          payload.shipment.sourceType === "AFTERCARE_EXECUTION"
            ? "aftercare"
            : undefined,
        partyName: payload.party.name,
        recipientName: payload.recipient.name ?? "",
        recipientPhone: payload.recipient.phone ?? "",
        deliveryAddress: payload.recipient.address ?? "",
        governorate: payload.recipient.governorate,
        salePrice: payload.money.currentTotal,
        deposit: payload.money.paidAmount,
        codAmount: payload.money.codAmount,
        deliveryFee: payload.money.deliveryFee,
        feeCollection: payload.money.feeCollection,
        dispatchedAt: slipSnapshot.eventOccurredAt,
        items: payload.invoices.map((item) => ({
          name: `فاتورة ${item.invoiceNumber}`,
          quantity: 1,
          total: item.total,
        })),
        copy:
          slipCopy === "REPRINT"
            ? {
                kind: "REPRINT",
                reason: "طلب إعادة طباعة من محطة الإسناد",
              }
            : { kind: "ORIGINAL" },
      };
      const printed = await printDeliveryDispatchSlipAsync(slip);
      await completeDocumentPrint.mutateAsync({
        printId: slipAttempt.print.id,
        branchId,
        status: printed.ok ? "SENT" : "FAILED",
        ...(!printed.ok ? { errorMessage: "حجبت نافذة طباعة البوليصة" } : {}),
      });

      const labelPayload = dispatchSnapshotPayload(labelSnapshot);
      const hasPrintedLabel = labelSnapshot.printHistory.some(
        (attempt) => attempt.status === "SENT",
      );
      const labelCopy = hasPrintedLabel ? "REPRINT" : "ORIGINAL";
      const labelAttempt = await requestDocumentPrint.mutateAsync({
        snapshotId: labelSnapshot.id,
        branchId,
        clientRequestId: crypto.randomUUID(),
        copyType: labelCopy,
        ...(labelCopy === "REPRINT"
          ? { reason: "طلب إعادة طباعة من محطة الإسناد" }
          : {}),
      });
      const totalAtDoor =
        Number(labelPayload.money.codAmount) +
        (labelPayload.money.feeCollection === "COURIER"
          ? Number(labelPayload.money.deliveryFee)
          : 0);
      const labelPrinted = await printShippingLabel(
        {
          orderNumber: labelPayload.shipment.consignmentNumber,
          barcodeValue: labelPayload.shipment.consignmentNumber,
          customerName: labelPayload.recipient.name,
          customerPhone: labelPayload.recipient.phone,
          governorate: labelPayload.recipient.governorate,
          addressText: labelPayload.recipient.address,
          total: String(totalAtDoor),
          subtotal: labelPayload.money.currentTotal,
          shippingFee: labelPayload.money.deliveryFee,
          paidAmount: labelPayload.money.paidAmount,
          paymentState:
            Number(labelPayload.money.codAmount) === 0 ? "PREPAID" : "COD",
          deliveryPartyName: labelPayload.party.name,
          createdAt: labelSnapshot.eventOccurredAt,
          printedAt: new Date(),
          isReprint: labelCopy === "REPRINT",
          items: labelPayload.invoices.map((item) => ({
            productName: `فاتورة ${item.invoiceNumber}`,
            unitName: "",
            quantity: "1",
          })),
        },
        { into: labelWindow ?? null },
      );
      await completeDocumentPrint.mutateAsync({
        printId: labelAttempt.print.id,
        branchId,
        status: labelPrinted.ok ? "SENT" : "FAILED",
        ...(!labelPrinted.ok ? { errorMessage: "حجبت نافذة طباعة الملصق" } : {}),
      });
      if (mounted.current)
        setPrintMessage(
          printed.ok && labelPrinted.ok
            ? "تم إرسال بوليصة الإسناد وملصق الشحن للطباعة"
            : "تم الإسناد؛ تعذر جزء من الحزمة، أعد الطباعة",
        );
    } catch (error) {
      if (mounted.current) {
        setPrintMessage(
          "تم الإسناد؛ تعذرت الطباعة، أعد الطباعة دون إعادة الإسناد",
        );
        notify.err(error, "تعذرت الطباعة فقط");
      }
    } finally {
      if (mounted.current) setPrinting(false);
    }
  }

  async function send(pending: WorkflowDispatchBatchInput) {
    persistDraft((old) => ({ ...old, pending }));
    try {
      const result = await dispatch.mutateAsync(pending);
      persistDraft((old) =>
        commitDispatchDraft(
          old,
          result,
          branchId,
          parties.find((party) => party.id === pending.partyId)?.name ?? "",
        ),
      );
      if (!mounted.current) return;
      setCommitted(result);
      queuedCodes.current.clear();
      rowsRef.current = [];
      setRows([]);
      setInput("");
      setMessage(`تم الإسناد ${result.consignmentNumber}`);
      void utils.delivery.invalidate();
      void utils.workOrders.invalidate();
      setPrintMessage("تم الإسناد؛ اطبع الحزمة دون إعادة الإسناد");
    } catch (error) {
      const code = (error as { data?: { code?: string } }).data?.code;
      if (code && definitiveErrors.has(code)) {
        restored.current = null;
        persistDraft((old) => ({ ...old, pending: null }));
        setMessage("لم يثبت الإسناد؛ راجع السبب وحدث المعاينة قبل التأكيد");
        void batch.refetch();
      } else
        setMessage(
          "لم تصل نتيجة مؤكدة؛ استعد نفس العملية بالمفتاح المحفوظ، ولا تبدأ إسناداً آخر",
        );
      notify.err(error, "تعذر تأكيد نتيجة الإسناد");
    }
  }

  async function submit() {
    if (submitLock.current || dispatch.isPending) return;
    submitLock.current = true;
    try {
      if (draftRef.current.pending) {
        await send(draftRef.current.pending);
        return;
      }
      if (
        !rows.length ||
        pendingScans ||
        unresolvedCodes.length ||
        blocked.length ||
        !batch.data ||
        batch.isFetching
      )
        return;
      if (!selectedParty) {
        setMessage("اختر جهة التوصيل صراحة قبل التأكيد");
        return;
      }
      if (
        needsDriver &&
        !draft.driverId
      ) {
        setMessage("اختر الموظف المندوب المرتبط بالجهة");
        return;
      }
      if (selectedParty.partyType === "COMPANY" && !draft.tracking.trim()) {
        setMessage("امسح رقم بوليصة شركة التوصيل");
        return;
      }
      if (
        draft.name.trim().length < 2 ||
        draft.phone.trim().length < 5 ||
        draft.address.trim().length < 3
      ) {
        setMessage("أكمل اسم المستلم وهاتفه وعنوانه داخل البطاقة");
        return;
      }
      const currentGeneration = generation.current;
      const quote = batch.data;
      const snapshot = draftRef.current;
      setConfirming(true);
      const ok = await confirm({
        title: "تأكيد الإسناد",
        description: `${rows.length} مستند — ${selectedParty.name}\nالمستلم: ${draft.name} — ${draft.phone}\nالعنوان: ${draft.address}\nالمتبقي: ${fmt(summary?.codAmount ?? "0")} د.ع\nأجرة واحدة: ${fmt(snapshot.deliveryFee)} د.ع`,
        confirmText: "تأكيد الإسناد",
      });
      if (!ok || !mounted.current || currentGeneration !== generation.current)
        return;
      await send({
        sources: quote.sources.map(({ source }) => ({
          kind: source.kind,
          id: source.id,
          expectedVersion: source.version,
        })),
        branchId,
        partyId: selectedParty.id,
        ...(snapshot.driverId
          ? { assignedUserId: Number(snapshot.driverId) }
          : {}),
        recipientName: snapshot.name.trim(),
        recipientPhone: snapshot.phone.trim(),
        deliveryAddress: snapshot.address.trim(),
        deliveryFee: snapshot.deliveryFee,
        feeCollection: aftercare ? "SHOP" : snapshot.feeCollection,
        externalTrackingRef: snapshot.tracking.trim() || undefined,
        notes: snapshot.notes.trim() || undefined,
        clientRequestId: crypto.randomUUID(),
      });
    } finally {
      submitLock.current = false;
      if (mounted.current) setConfirming(false);
    }
  }

  async function refreshRows() {
    const currentGeneration = generation.current;
    try {
      const next = await Promise.all(
        rowsRef.current.map(async (row) => ({
          raw: row.raw,
          preview: await utils.delivery.workflow.previewBySource.fetch({
            source: {
              kind: row.preview.source.kind,
              id: row.preview.source.id,
            },
            station: "dispatch",
            branchId,
          }),
        })),
      );
      if (mounted.current && currentGeneration === generation.current) {
        rowsRef.current = next;
        setRows(next);
      }
    } catch (error) {
      notify.err(error, "تعذر تحديث الجاهزية؛ المسودة محفوظة");
    }
  }
  if (requestContext)
    return (
      <RequestsWorkspace
        embedded
        branchId={branchId}
        requestId={requestContext.requestId}
        onClose={requestBusy ? undefined : () => setRequestContext(null)}
        onChanged={(id) => {
          if (id) setRequestContext({ requestId: id });
          void refreshRows();
        }}
        onPrintConsignment={(id) => {
          const labelWindow = preopenShippingLabelWindow();
          void printResult({ consignmentId: id }, labelWindow);
        }}
      />
    );

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      {committed && (
        <Card className="gap-2 p-3" role="status">
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="size-4 text-primary" aria-hidden />
            <strong>تم الإسناد {committed.consignmentNumber}</strong>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ms-auto gap-1"
              disabled={printing}
              onClick={() => {
                const labelWindow = preopenShippingLabelWindow();
                void printResult(committed, labelWindow);
              }}
            >
              <Printer className="size-4" aria-hidden />
              طباعة حزمة الإسناد
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{printMessage}</p>
        </Card>
      )}
      <Card className="gap-3 p-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={formFrozen || pendingScans > 0}
          onClick={() => setRequestContext({})}
        >
          طلبات التجهيز والتسليم الجزئي
        </Button>
        <div className="flex items-center gap-2 font-semibold">
          <ScanLine className="size-4" aria-hidden />
          امسح المستندات تباعاً لإسناد واحد
        </div>
        <UnifiedSearchInput
          ref={inputRef}
          value={input}
          onChange={setInput}
          onScan={enqueue}
          onSubmit={enqueue}
          disabled={frozen || dispatch.isPending || confirming}
          placeholder="باركود الفاتورة أو أمر الشغل أو دفعة المعالجة"
          debounceMs={0}
          barcode
          aria-label="مسح مستندات الإسناد"
        />
        <p role="status" className="break-words text-sm text-muted-foreground">
          {message ||
            "المسح يجهز القائمة فقط؛ الإرسال يتم بعد مراجعة الملخص والتأكيد."}
        </p>
        {rows.length > 0 && (
          <ul
            className="divide-y rounded-md border"
            aria-label="مستندات الإسناد"
          >
            {rows.map(({ raw, preview }) => (
              <li
                key={preview.source.canonicalKey}
                className="flex items-start gap-2 p-2 text-sm"
              >
                <Package
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <strong className="break-all" dir="ltr">
                    {preview.source.number}
                  </strong>
                  <p className="break-words text-muted-foreground">
                    {preview.recipient.name || "مستلم عابر"} · المتبقي{" "}
                    {fmt(preview.money.codAmount)} د.ع
                  </p>
                  {!preview.actions.find((a) => a.action === "dispatch")
                    ?.allowed && (
                    <p className="text-destructive">
                      {
                        preview.actions.find((a) => a.action === "dispatch")
                          ?.reason
                      }
                    </p>
                  )}
                </div>
                {(preview.source.kind === "fulfillmentRequest" ||
                  preview.relations.fulfillmentRequestId != null) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={formFrozen}
                    onClick={() =>
                      setRequestContext({
                        requestId:
                          preview.relations.fulfillmentRequestId ??
                          preview.source.id,
                      })
                    }
                  >
                    التجهيز والدفعات
                  </Button>
                )}
                {preview.relations.consignmentId != null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={printing || formFrozen}
                    onClick={() => {
                      if (!preview.relations.consignmentId) return;
                      const labelWindow = preopenShippingLabelWindow();
                      void printResult(
                        { consignmentId: preview.relations.consignmentId },
                        labelWindow,
                      );
                    }}
                  >
                    <Printer className="size-4" aria-hidden />
                    طباعة الحزمة
                  </Button>
                )}
                {preview.actions.find((a) => a.action === "aftercare")
                  ?.allowed && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={formFrozen}
                    onClick={() => onAftercare?.(raw)}
                  >
                    نقص / تعويض
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`حذف ${preview.source.number} من قائمة الإسناد`}
                  disabled={formFrozen || pendingScans > 0}
                  onClick={() =>
                    syncRows(
                      rowsRef.current.filter(
                        (row) =>
                          row.preview.source.canonicalKey !==
                          preview.source.canonicalKey,
                      ),
                      true,
                    )
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!pendingScans && unresolvedCodes.length > 0 && (
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-sm text-muted-foreground">
              لم تحسم قراءة بعض الرموز؛ أعد قراءتها أو أزلها صراحةً قبل الإسناد.
            </p>
            {unresolvedCodes.map((code) => (
              <div
                key={code}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <code className="min-w-0 flex-1 break-all" dir="ltr">
                  {code}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={formFrozen}
                  onClick={() => enqueue(code, true)}
                >
                  إعادة القراءة
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={formFrozen}
                  onClick={() => {
                    if (submitLock.current) return;
                    queuedCodes.current.delete(code);
                    persistDraft((old) => ({
                      ...old,
                      codes: old.codes.filter((saved) => saved !== code),
                    }));
                  }}
                >
                  إزالة الرمز من المسودة
                </Button>
              </div>
            ))}
          </div>
        )}
        {summary && (
          <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/40 p-3 text-sm sm:grid-cols-4">
            <div>
              المستندات
              <strong className="block tabular-nums">{rows.length}</strong>
            </div>
            <div>
              المتبقي للتحصيل
              <strong className="block tabular-nums">
                {fmt(summary.codAmount)} د.ع
              </strong>
            </div>
            <div>
              أمانة توصيل مقبوضة
              <strong className="block tabular-nums">
                {fmt(summary.heldDeliveryFee)} د.ع
              </strong>
            </div>
            <div>
              أجور مرتبطة
              <strong className="block tabular-nums">
                {fmt(summary.serviceCharges)} د.ع
              </strong>
            </div>
          </div>
        )}
        {blocked.map((reason) => (
          <p key={reason} className="text-sm text-destructive">
            {reason}
          </p>
        ))}
        {batch.error && (
          <p className="text-sm text-destructive">
            {batch.error.message}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => void batch.refetch()}
            >
              تحديث المعاينة
            </Button>
          </p>
        )}
        {batch.data?.feeRequirement?.reason && (
          <div className="rounded-md border p-3 text-sm space-y-1">
            <p>{batch.data.feeRequirement.reason}</p>
            <p>
              الزائد المطلوب رده فعلياً:{" "}
              <strong>
                {fmt(batch.data.feeRequirement.refundRequired)} د.ع
              </strong>
            </p>
            <p className="break-words">
              إيصالات الأمانة الأصلية:{" "}
              {batch.data.feeRequirement.receiptIds.join("، ") || "—"}
            </p>
          </div>
        )}
        {(!!batch.data?.feeRequirement?.reason ||
          rows.some(
            (row) =>
              row.preview.money.pendingRefundReceiptIds.length > 0 ||
              row.preview.money.heldReceipts.length > 1,
          )) && (
          <Button
            type="button"
            variant="outline"
            disabled={formFrozen}
            onClick={() => onRefunds?.(rows.map((row) => row.raw))}
          >
            مراجعة أمانات التوصيل ورد الزائد
          </Button>
        )}
      </Card>
      <Card className="gap-3 p-3">
        <div className="flex items-center gap-2 font-semibold">
          <Truck className="size-4" aria-hidden />
          الإسناد والمستلم
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            جهة التوصيل
            <AppSelect
              value={draft.partyId}
              disabled={formFrozen}
              onValueChange={(value) => {
                change("partyId", value);
                change("driverId", "");
              }}
            >
              <option value="">اختر الجهة</option>
              {availableParties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.partyType === "COMPANY" ? "شركة" : "مندوب"})
                </option>
              ))}
            </AppSelect>
          </label>
          {selectedParty && needsDriver && (
              <label className="space-y-1 text-sm">
                الموظف المندوب
                <AppSelect
                  value={draft.driverId}
                  disabled={formFrozen}
                  onValueChange={(value) => change("driverId", value)}
                >
                  <option value="">اختر الموظف المندوب</option>
                  {drivers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </AppSelect>
                {!drivers.length && (
                  <span className="text-destructive">
                    لا يوجد موظف توصيل نشط في فرع العمل؛ راجع مسؤول المناديب لتصحيح الربط.
                  </span>
                )}
              </label>
            )}
          <label className="space-y-1 text-sm">
            اسم المستلم
            <Input
              value={draft.name}
              disabled={formFrozen}
              onChange={(e) => change("name", e.target.value)}
              maxLength={255}
            />
          </label>
          <label className="space-y-1 text-sm">
            هاتف المستلم
            <IntlPhoneInput
              value={draft.phone}
              disabled={formFrozen}
              onChange={(value) => change("phone", value)}
              ariaLabel="هاتف مستلم الإسناد"
            />
          </label>
          <label className="space-y-1 text-sm sm:col-span-2">
            عنوان التوصيل
            <Input
              value={draft.address}
              disabled={formFrozen}
              onChange={(e) => change("address", e.target.value)}
              maxLength={2000}
            />
          </label>
          <label className="space-y-1 text-sm">
            أجرة الشحنة
            <MoneyInput
              value={draft.deliveryFee}
              disabled={formFrozen || aftercare}
              onChange={(value) => change("deliveryFee", value || "0")}
            />
          </label>
          <label className="space-y-1 text-sm">
            تحمل وقبض الأجرة
            <AppSelect
              value={aftercare ? "SHOP" : draft.feeCollection}
              disabled={formFrozen || aftercare}
              onValueChange={(value) => {
                if (
                  value === "COURIER" ||
                  value === "COUNTER" ||
                  value === "SHOP"
                )
                  change("feeCollection", value);
              }}
            >
              <option value="COURIER">يقبضها الناقل من العميل</option>
              <option value="COUNTER">مقبوضة في الكاشير</option>
              <option value="SHOP">على المكتبة</option>
            </AppSelect>
          </label>
          {selectedParty?.partyType === "COMPANY" && (
            <label className="space-y-1 text-sm sm:col-span-2">
              رقم بوليصة شركة التوصيل
              <Input
                value={draft.tracking}
                disabled={formFrozen}
                onChange={(e) => change("tracking", e.target.value)}
                maxLength={100}
                dir="ltr"
              />
            </label>
          )}
          <label className="space-y-1 text-sm sm:col-span-2">
            ملاحظات التوصيل
            <Input
              value={draft.notes}
              disabled={formFrozen}
              onChange={(e) => change("notes", e.target.value)}
              maxLength={2000}
            />
          </label>
        </div>
        {frozen && (
          <p className="text-sm text-primary">
            المسودة مثبتة لاستعادة نتيجة العملية نفسها؛ لا تعاد الفوترة أو حركة
            المخزون.
          </p>
        )}
        <SubmitButton
          type="button"
          className="w-full"
          pending={dispatch.isPending}
          disabled={
            confirming ||
            (!frozen &&
              (!rows.length ||
                unresolvedCodes.length > 0 ||
                pendingScans > 0 ||
                batch.isFetching ||
                !batch.data ||
                blocked.length > 0 ||
                !selectedParty))
          }
          onClick={() => void submit()}
        >
          {frozen ? "استعادة نتيجة الإسناد" : "تأكيد الإسناد"}
        </SubmitButton>
      </Card>
    </div>
  );
}
