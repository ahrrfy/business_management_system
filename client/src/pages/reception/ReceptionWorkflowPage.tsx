/**
 * DeliveryWorkflowPage - شاشة الإسناد والتوصيل /reception/workflow
 * محطات المسح والإسناد والتحصيل والتصحيح والمعالجة في الصفحة المعتادة.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useSessionBranchInference } from "@/hooks/useSessionContext";
import { WorkflowDispatchStation } from "@/components/delivery/workflow/WorkflowDispatchStation";
import { WorkflowPrintActions } from "@/components/delivery/workflow/WorkflowPrintActions";
import { WorkflowCollectStation } from "@/components/delivery/workflow/WorkflowCollectStation";
import { WorkflowReturnSourceCard } from "@/components/delivery/workflow/WorkflowReturnSourceCard";
import {
  WorkflowLegacyReturnStation,
  type WorkflowLegacyReturnSource as ScannedOrder,
} from "@/components/delivery/workflow/WorkflowLegacyReturnStation";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { Skeleton } from "@/components/ui/skeleton";
import {
  explicitWorkflowSection,
  positiveWorkflowParam,
  workflowSection,
  workflowSourceContext,
  workflowSourceBarcode,
} from "@/components/delivery/workflow/navigation";
import { WorkflowModeNavigation } from "@/components/delivery/workflow/WorkflowModeNavigation";
import {
  browserWorkflowModeStorage,
  persistWorkflowMode,
  readStoredWorkflowMode,
  workflowDefaultSection,
  workflowModeForSection,
  type WorkflowMode,
} from "@/components/delivery/workflow/workflowModes";
import type { WorkflowScanPreview } from "@shared/deliveryWorkflow";
const AftercareStation = lazyWithRetry(() =>
  import("@/components/fulfillment/AftercareStation").then((module) => ({
    default: module.AftercareStation,
  })),
);
import { Link, useLocation, useSearch } from "wouter";

import {
  AlertTriangle,
  BadgeDollarSign,
  BarChart3,
  Building2,
  CheckCircle2,
  CheckSquare,
  Clock,
  FilePenLine,
  FileText,
  Info,
  Printer,
  ScanLine,
  Square,
  Truck,
  User,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { parseScan, resolveOrderLookupBarcode } from "@/lib/scanRouter";
import { docBarcode } from "@shared/documentNumber";
import {
  printDeliveryDispatchSlip,
  type DispatchSlipData,
} from "@/lib/printing/printDeliveryDispatchSlip";
import { printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { storefrontUrl } from "@/lib/siteHosts";
import { ReceptionCollectSection } from "@/components/reception/ReceptionCollectSection";
import { DispatchPreviewCard } from "@/components/delivery/DispatchPreviewCard";
import { CancelDeliveryAssignmentDialog } from "@/components/delivery/CancelDeliveryAssignmentDialog";
import { CancelDeliveryAssignmentSection } from "@/components/delivery/CancelDeliveryAssignmentSection";
import { DeliveryOperationalIntelligenceBar } from "@/components/delivery/DeliveryOperationalIntelligenceBar";
import {
  invoiceStatusBadgeVariant,
  invoiceStatusLabel,
} from "@shared/invoiceStatus";
import {
  workOrderStatusBadgeCls,
  workOrderStatusLabel,
} from "@shared/workOrderStatus";
import { fmtDateTime } from "@/lib/date";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";

type Section = ReturnType<typeof workflowSection>;

export default function DeliveryWorkflowPage() {
  const pageSearch = useSearch();
  const [location, navigate] = useLocation();
  const isDeliveryModule = location.startsWith("/delivery");
  const [activeSection, setActiveSection] = useState<Section>(() => {
    const explicitSection = explicitWorkflowSection(pageSearch);
    if (explicitSection) return explicitSection;
    const storedMode = readStoredWorkflowMode(browserWorkflowModeStorage());
    return workflowDefaultSection(storedMode ?? "assignment");
  });
  const pendingMutations = useIsMutating();
  const pageParams = new URLSearchParams(pageSearch);
  const [cancelScannedCode, setCancelScannedCode] = useState<string | null>(
    null,
  );
  const [dispatchScannedCode, setDispatchScannedCode] = useState<string | null>(
    null,
  );
  const [aftercareScannedCode, setAftercareScannedCode] = useState<
    string | null
  >(null);
  const [returnWorkflow, setReturnWorkflow] =
    useState<WorkflowScanPreview | null>(null);
  const [refundCodes, setRefundCodes] = useState<string[]>([]);
  const [collectScannedCode, setCollectScannedCode] = useState<string | null>(
    null,
  );
  const [editInvoiceNumber, setEditInvoiceNumber] = useState<string | null>(
    null,
  );
  const [editScanContext, setEditScanContext] =
    useState<WorkflowScanPreview | null>(null);
  const [editBarcodeInput, setEditBarcodeInput] = useState("");
  const [returnScanned, setReturnScanned] = useState<ScannedOrder | null>(null);
  const [returnBarcodeInput, setReturnBarcodeInput] = useState("");
  const [returnType, setReturnType] = useState<"FULL" | "PARTIAL">("FULL");
  const [cancellingConsignment, setCancellingConsignment] = useState<{
    id: number;
    number: string;
  } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const returnRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  // Keep the scanned key, not a copy of the result: financial events refresh these observers.
  const editPreview = trpc.sales.lookupForCorrection.useQuery(
    { invoiceNumber: editInvoiceNumber ?? "" },
    { enabled: editInvoiceNumber != null },
  );
  const editScanned = editPreview.data;
  const me = trpc.auth.me.useQuery();
  const branchContext = useSessionBranchInference();
  const [chosenBranch, setChosenBranch] = useState(() =>
    positiveWorkflowParam(new URLSearchParams(pageSearch), "branchId"),
  );
  const invalidBranch =
    pageParams.has("branchId") &&
    !positiveWorkflowParam(pageParams, "branchId");
  const branchId = invalidBranch
    ? undefined
    : chosenBranch
      ? branchContext.canOverride
        ? branchContext.branches.some((branch) => branch.id === chosenBranch)
          ? chosenBranch
          : undefined
        : chosenBranch === branchContext.branchId
          ? chosenBranch
          : undefined
      : (branchContext.branchId ?? undefined);
  const lookupContext = useRef({ branchId, section: activeSection });
  lookupContext.current = { branchId, section: activeSection };
  useEffect(() => {
    const explicit = positiveWorkflowParam(
      new URLSearchParams(pageSearch),
      "branchId",
    );
    if (explicit) setChosenBranch(explicit);
  }, [pageSearch, branchContext.canOverride]);
  useEffect(() => {
    setReturnScanned(null);
    setReturnWorkflow(null);
    setEditInvoiceNumber(null);
    setEditScanContext(null);
    setDispatchScannedCode(null);
    setCancelScannedCode(null);
    setCollectScannedCode(null);
    setAftercareScannedCode(null);
  }, [branchId]);
  const editWorkflow = trpc.delivery.workflow.previewBySource.useQuery(
    {
      source: { kind: "invoice", id: editScanned?.id ?? 0 },
      station: "edit",
      branchId,
    },
    { enabled: editScanned != null && branchId != null },
  );
  const currentEditContext = editWorkflow.data ?? editScanContext;
  const workflowEditAction = currentEditContext?.actions.find(
    (action) => action.action === "edit",
  );
  const editBlockReason =
    editScanned?.blockReason ??
    (workflowEditAction?.allowed === false ? workflowEditAction.reason : null);
  function chooseSection(section: Section, extra?: Record<string, string>) {
    setActiveSection(section);
    const params = new URLSearchParams(pageSearch);
    for (const key of [
      "caseId",
      "executionId",
      "requestId",
      "chargeId",
      "invoiceId",
      "workOrderId",
      "consignmentId",
      "onlineOrderId",
      "invoice",
      "action",
    ])
      params.delete(key);
    params.set("section", section);
    if (location.startsWith("/delivery")) params.set("tab", "workflow");
    if (extra)
      for (const [key, value] of Object.entries(extra)) params.set(key, value);
    navigate(location + "?" + params.toString(), { replace: true });
  }
  function chooseMode(mode: WorkflowMode) {
    chooseSection(workflowDefaultSection(mode));
  }
  function openAftercare(context: {
    raw?: string;
    caseId?: number;
    executionId?: number;
  }) {
    if (context.raw) setAftercareScannedCode(context.raw);
    const extra: Record<string, string> = {};
    if (context.caseId) extra.caseId = String(context.caseId);
    if (context.executionId) extra.executionId = String(context.executionId);
    chooseSection("aftercare", extra);
  }
  useEffect(() => {
    const explicitSection = explicitWorkflowSection(pageSearch);
    if (explicitSection) setActiveSection(explicitSection);
  }, [pageSearch]);
  useEffect(() => {
    persistWorkflowMode(
      browserWorkflowModeStorage(),
      workflowModeForSection(activeSection),
    );
  }, [activeSection]);
  // enabled: !!branchId يمنع الاستعلام حتى يصل me.data — لا سقوط صامت على فرع افتراضي (§ G3)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const shiftQ = trpc.shifts.current.useQuery(
    { branchId: branchId!, shiftType: "RECEPTION" },
    { enabled: !!branchId },
  );
  const shift = shiftQ.data ?? null;
  const partiesQ = trpc.delivery.listParties.useQuery(
    { activeOnly: true },
    { staleTime: 60_000 },
  );
  const allParties = (partiesQ.data ?? []).filter(
    (p) => p.branchId == null || p.branchId === branchId,
  );
  const lookupWorkOrder = useCallback(
    async (raw: string) => {
      const orderNumber = resolveOrderLookupBarcode(raw);
      if (!orderNumber || !branchId) return;
      try {
        const preview = await utils.delivery.workflow.preview.fetch({
          raw: orderNumber,
          station: "return",
          branchId,
        });
        if (
          lookupContext.current.branchId !== branchId ||
          lookupContext.current.section !== "return"
        )
          return;
        if (
          preview.source.kind === "consignment" ||
          preview.source.kind === "aftercareExecution" ||
          preview.source.kind === "fulfillmentRequest" ||
          preview.source.kind === "charge" ||
          preview.relations.consignmentId != null ||
          preview.relations.fulfillmentRequestId != null ||
          preview.relations.aftercareExecutionId != null
        ) {
          setReturnWorkflow(preview);
          setReturnScanned(null);
          setReturnBarcodeInput("");
          return;
        }
        const wo = await utils.workOrders.getByNumber.fetch({ orderNumber });
        if (
          lookupContext.current.branchId !== branchId ||
          lookupContext.current.section !== "return"
        )
          return;
        if (!wo) {
          notify.err("المستند غير موجود في فرع العمل");
          return;
        }
        const activeCn = (
          wo as { activeConsignment?: ScannedOrder["activeConsignment"] }
        ).activeConsignment;
        setReturnScanned({
          id: wo.id,
          kind: wo.kind ?? "workOrder",
          orderNumber: wo.orderNumber,
          title: wo.title,
          status: wo.status ?? null,
          branchId: wo.branchId ? Number(wo.branchId) : null,
          customerName: wo.customerName,
          customerPhone: wo.customerPhone,
          salePrice: wo.salePrice,
          deposit: wo.deposit,
          deliveryAddress: wo.deliveryAddress,
          deliveryPhone: wo.deliveryPhone,
          deliveryCost: wo.deliveryCost,
          version: (wo as { version?: number }).version ?? 1,
          invoiceId: (wo as { invoiceId?: number | null }).invoiceId ?? null,
          activeConsignment: activeCn ?? null,
        });
        setReturnWorkflow(null);
        setReturnBarcodeInput("");
      } catch (error) {
        notify.err(error, "تعذر قراءة مصدر المرتجع");
      }
    },
    [branchId, utils],
  );

  const lookupInvoiceForEdit = useCallback(
    async (raw: string) => {
      if (!raw.trim() || !branchId) return;
      try {
        const preview = await utils.delivery.workflow.preview.fetch({
          raw,
          station: "edit",
          branchId,
        });
        if (
          lookupContext.current.branchId !== branchId ||
          lookupContext.current.section !== "edit"
        )
          return;
        setEditScanContext(preview);
        const invoiceId =
          preview.source.kind === "invoice"
            ? preview.source.id
            : preview.relations.invoiceId;
        if (!invoiceId) {
          notify.warn(
            preview.actions.find((action) => action.action === "edit")
              ?.reason ??
              "هذا المستند لا يحمل فاتورة قابلة للتصحيح؛ راجع محطته المرتبطة",
          );
          return;
        }
        const invoiceSource =
          preview.source.kind === "invoice"
            ? preview
            : await utils.delivery.workflow.previewBySource.fetch({
                source: { kind: "invoice", id: invoiceId },
                station: "edit",
                branchId,
              });
        const invoiceNumber = invoiceSource.source.number;
        const invoice = await utils.sales.lookupForCorrection.fetch({
          invoiceNumber,
        });
        if (
          lookupContext.current.branchId !== branchId ||
          lookupContext.current.section !== "edit"
        )
          return;
        if (!invoice) {
          notify.err(`لم توجد فاتورة بهذا الرقم في فرعك: ${invoiceNumber}`);
          return;
        }
        setEditInvoiceNumber(invoiceNumber);
        setEditBarcodeInput("");
      } catch (error) {
        notify.err(error, "تعذّر جلب الفاتورة");
      }
    },
    [branchId, utils],
  );

  const directInvoiceLookupRef = useRef<string | null>(null);
  useEffect(() => {
    const invoiceNumber = new URLSearchParams(pageSearch)
      .get("invoice")
      ?.trim();
    const key = `${branchId}:${invoiceNumber}`;
    if (
      activeSection !== "edit" ||
      !invoiceNumber ||
      directInvoiceLookupRef.current === key
    )
      return;
    directInvoiceLookupRef.current = key;
    void lookupInvoiceForEdit(invoiceNumber);
  }, [activeSection, branchId, lookupInvoiceForEdit, pageSearch]);

  const cancelAssignmentEnabled = activeSection === "cancelAssignment";
  const returnEnabled =
    activeSection === "return" && !returnScanned && !returnWorkflow;
  const collectEnabled =
    activeSection === "collect" && !pageParams.get("action");
  const editEnabled = activeSection === "edit" && !editInvoiceNumber;
  const aftercareEnabled = activeSection === "aftercare";
  useBarcodeScanner(
    useCallback(
      async (raw: string) => {
        if (cancelAssignmentEnabled) setCancelScannedCode(raw.trim());
        else if (returnEnabled) await lookupWorkOrder(raw);
        else if (collectEnabled) setCollectScannedCode(raw.trim());
        else if (editEnabled) await lookupInvoiceForEdit(raw);
        else if (aftercareEnabled) setAftercareScannedCode(raw.trim());
      },
      [
        cancelAssignmentEnabled,
        returnEnabled,
        collectEnabled,
        editEnabled,
        aftercareEnabled,
        lookupWorkOrder,
        lookupInvoiceForEdit,
      ],
    ),
    {
      enabled:
        pendingMutations === 0 &&
        (cancelAssignmentEnabled ||
          returnEnabled ||
          collectEnabled ||
          editEnabled ||
          aftercareEnabled),
    },
  );
  useEffect(() => {
    if (returnEnabled) returnRef.current?.focus();
    else if (editEnabled) editRef.current?.focus();
  }, [returnEnabled, editEnabled]);
  const sourceContextKey = useRef<string | null>(null);
  useEffect(() => {
    if (!branchId || activeSection === "aftercare") return;
    const source = workflowSourceContext(pageSearch);
    if (!source) return;
    const key =
      branchId + ":" + activeSection + ":" + source.kind + ":" + source.id;
    if (sourceContextKey.current === key) return;
    let current = true;
    void utils.delivery.workflow.previewBySource
      .fetch({ source, station: activeSection, branchId })
      .then((preview) => {
        if (!current) return;
        sourceContextKey.current = key;
        const raw = workflowSourceBarcode(preview.source);
        if (activeSection === "dispatch") setDispatchScannedCode(raw);
        else if (activeSection === "cancelAssignment")
          setCancelScannedCode(raw);
        else if (activeSection === "collect") setCollectScannedCode(raw);
        else if (activeSection === "return") void lookupWorkOrder(raw);
        else void lookupInvoiceForEdit(raw);
      })
      .catch((error) => {
        if (current) {
          sourceContextKey.current = null;
          notify.err(error, "تعذر فتح المستند المرتبط");
        }
      });
    return () => {
      current = false;
    };
  }, [
    activeSection,
    branchId,
    pageSearch,
    utils,
    lookupInvoiceForEdit,
    lookupWorkOrder,
  ]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      dir="rtl"
    >
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <PageHeader
          title={
            isDeliveryModule ? "تنفيذ التوصيل بالباركود" : "التوصيل والإسناد"
          }
          description={
            isDeliveryModule
              ? "امسح المستند في محطته المعتادة، راجع الأثر، ثم نفذ الإجراء الرئيسي مرة واحدة."
              : undefined
          }
          icon={<Truck aria-hidden className="size-5 text-primary" />}
          backHref={isDeliveryModule ? undefined : "/pos?mode=RECEPTION"}
          backLabel={isDeliveryModule ? undefined : "الاستقبال"}
          actions={
            <div className="flex items-center gap-2">
              {shift ? (
                <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
                  وردية #{shift.id}
                </span>
              ) : (
                <span className="rounded-full bg-destructive/10 px-3 py-1 text-xs font-bold text-destructive">
                  لا وردية
                </span>
              )}
              {isDeliveryModule && (
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                  className="gap-1.5 font-bold text-xs"
                >
                  <Link href="/delivery?tab=dispatch">لوحة وجداول التوصيل</Link>
                </Button>
              )}
            </div>
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 text-sm">
        <span>فرع العمل:</span>
        {branchContext.canOverride ? (
          <AppSelect
            aria-label="فرع محطات سير العمل"
            value={branchId ? String(branchId) : ""}
            className="w-56"
            disabled={pendingMutations > 0}
            onValueChange={async (value) => {
              if (!value || Number(value) === branchId) return;
              const ok = await confirm({
                title: "تغيير فرع العمل",
                description:
                  "ستفتح محطات الفرع المختار؛ مسودة الإسناد محفوظة لكل فرع. أكمل أو احفظ أي نموذج آخر قبل الانتقال.",
                confirmText: "تغيير الفرع",
              });
              if (!ok) return;
              setChosenBranch(Number(value));
              setReturnScanned(null);
              setReturnWorkflow(null);
              setEditInvoiceNumber(null);
              const params = new URLSearchParams(pageSearch);
              params.set("branchId", value);
              for (const key of [
                "invoiceId",
                "workOrderId",
                "consignmentId",
                "onlineOrderId",
                "requestId",
                "caseId",
                "executionId",
                "chargeId",
                "invoice",
              ])
                params.delete(key);
              navigate(location + "?" + params.toString(), { replace: true });
            }}
          >
            <option value="">اختر الفرع</option>
            {branchContext.branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </AppSelect>
        ) : (
          <strong>{branchContext.branchName ?? "لم يحدد فرع العمل"}</strong>
        )}
        {branchContext.message && (
          <span className="text-destructive">
            {branchContext.message}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={branchContext.retry}
            >
              إعادة المحاولة
            </Button>
          </span>
        )}
        {!branchId && !branchContext.message && (
          <span className="text-destructive">
            اختر فرعاً مصرحاً به قبل تنفيذ أي إجراء؛ الفرع المطلوب غير متاح لهذه
            الجلسة.
          </span>
        )}
      </div>

      <WorkflowModeNavigation
        activeSection={activeSection}
        disabled={pendingMutations > 0}
        disabledReason="توجد عملية قيد الحفظ؛ منعنا تغيير المحطة حتى لا يفقد الموظف نتيجتها."
        nextStep="انتظر اكتمال الحفظ ثم تابع المسح من المحطة المختارة."
        onModeChange={chooseMode}
        onSectionChange={chooseSection}
      />

      <div
        id="workflow-active-panel"
        role="tabpanel"
        aria-labelledby={`workflow-tab-${activeSection}`}
        className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4"
      >
        {allParties.length > 0 && (
          <div className="mx-auto max-w-4xl mb-4">
            <DeliveryOperationalIntelligenceBar parties={allParties} />
          </div>
        )}
        {activeSection === "dispatch" && branchId && me.data && (
          <WorkflowDispatchStation
            key={me.data.id + ":" + branchId}
            branchId={branchId}
            userId={me.data.id}
            parties={allParties}
            scannedBarcode={dispatchScannedCode}
            onBarcodeConsumed={() => setDispatchScannedCode(null)}
            onAftercare={(raw) => openAftercare({ raw })}
            onRefunds={(codes) => {
              setRefundCodes(codes);
              chooseSection("collect", { action: "refunds" });
            }}
          />
        )}

        {activeSection === "cancelAssignment" && branchId && (
          <CancelDeliveryAssignmentSection
            branchId={branchId}
            scannedBarcode={cancelScannedCode}
            onBarcodeConsumed={() => setCancelScannedCode(null)}
            onAssignmentCancelled={() => {
              void utils.delivery.invalidate();
            }}
            onNavigateToDispatchBarcode={(raw) => {
              setDispatchScannedCode(raw);
              chooseSection("dispatch");
            }}
            onNavigateToAftercare={openAftercare}
          />
        )}
        {activeSection === "collect" && branchId && (
          <WorkflowCollectStation
            branchId={branchId}
            shift={shift}
            scannedBarcode={collectScannedCode}
            onBarcodeConsumed={() => setCollectScannedCode(null)}
            action={pageParams.get("action")}
            chargeId={positiveWorkflowParam(pageParams, "chargeId")}
            refundCodes={refundCodes}
            onNavigateToAftercare={openAftercare}
            onAction={(action, chargeId) => {
              const params = new URLSearchParams(pageSearch);
              params.set("section", "collect");
              if (action) params.set("action", action);
              else params.delete("action");
              if (chargeId) params.set("chargeId", String(chargeId));
              else params.delete("chargeId");
              if (branchId) params.set("branchId", String(branchId));
              navigate(location + "?" + params.toString(), { replace: true });
            }}
          />
        )}
        {activeSection === "aftercare" && branchId && (
          <React.Suspense
            fallback={
              <div role="status" aria-label="تحميل محطة المعالجة">
                <Skeleton className="mx-auto h-28 max-w-4xl" />
              </div>
            }
          >
            <AftercareStation
              key={String(branchId)}
              branchId={branchId}
              caseId={positiveWorkflowParam(pageParams, "caseId")}
              executionId={positiveWorkflowParam(pageParams, "executionId")}
              scannedBarcode={aftercareScannedCode}
              onBarcodeConsumed={() => setAftercareScannedCode(null)}
            />
          </React.Suspense>
        )}

        {activeSection === "edit" && (
          <div className="mx-auto max-w-2xl space-y-4">
            {!editInvoiceNumber && (
              <div className="rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-6 text-center">
                <ScanLine
                  aria-hidden
                  className="mx-auto size-10 text-primary/60"
                />
                <p className="mt-2 text-base font-extrabold text-primary">
                  امسح باركود الفاتورة للتعديل
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  أو أدخل رقم الفاتورة يدوياً
                </p>
                <div className="mt-4 flex gap-2">
                  <UnifiedSearchInput
                    ref={editRef}
                    value={editBarcodeInput}
                    onChange={setEditBarcodeInput}
                    onScan={(code: string) => void lookupInvoiceForEdit(code)}
                    onSubmit={(val: string) => {
                      if (val.trim()) void lookupInvoiceForEdit(val.trim());
                    }}
                    placeholder="رقم الفاتورة (Enter)"
                    className="flex-1 text-center font-bold"
                    dir="ltr"
                    barcode={true}
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      void lookupInvoiceForEdit(editBarcodeInput.trim())
                    }
                    disabled={!editBarcodeInput.trim()}
                  >
                    بحث
                  </Button>
                </div>
              </div>
            )}

            {editInvoiceNumber && (!editScanned || editPreview.error) && (
              <Card className="space-y-3 p-4" role="status">
                <p className="text-sm">
                  {editPreview.error?.message ??
                    (editPreview.isFetching
                      ? "جارٍ تحميل الفاتورة الحالية…"
                      : "الفاتورة غير متاحة حالياً. أعد مسحها للتحقق من حالتها.")}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditInvoiceNumber(null);
                    setEditBarcodeInput("");
                  }}
                >
                  مسح فاتورة أخرى
                </Button>
              </Card>
            )}

            {editScanned && !editPreview.error && (
              <Card className="overflow-hidden gap-0 py-0 shadow-sm">
                <div className="flex items-start justify-between border-b bg-muted/30 p-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <FileText aria-hidden className="size-5 text-primary" />
                      <span className="text-lg font-extrabold">
                        فاتورة #{editScanned.invoiceNumber}
                      </span>
                      <Badge
                        variant={invoiceStatusBadgeVariant(editScanned.status)}
                        className="font-bold"
                      >
                        {invoiceStatusLabel(editScanned.status)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      أُنشئت {fmtDateTime(editScanned.invoiceDate)} · آخر تحديث{" "}
                      {fmtDateTime(editScanned.updatedAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditInvoiceNumber(null);
                      setEditBarcodeInput("");
                    }}
                  >
                    مسح فاتورة أخرى
                  </Button>
                </div>
                <div className="space-y-4 p-4">
                  {branchId && <WorkflowPrintActions branchId={branchId} invoiceIds={[editScanned.id]} preview={editScanContext ?? undefined} mode="edit" />}
                  <div className="grid overflow-hidden rounded-md border bg-background sm:grid-cols-2">
                    <div className="border-b p-3 sm:border-e">
                      <p className="text-xs text-muted-foreground">العميل</p>
                      <p className="font-bold">
                        {editScanned.customerName ?? "زبون نقدي"}
                      </p>
                      {editScanned.customerPhone && (
                        <p className="text-xs text-muted-foreground" dir="ltr">
                          {editScanned.customerPhone}
                        </p>
                      )}
                    </div>
                    <div className="border-b p-3">
                      <p className="text-xs text-muted-foreground">
                        الفاتورة والدفع
                      </p>
                      <p className="font-bold">
                        {fmt(editScanned.total)} د.ع · مدفوع{" "}
                        {fmt(editScanned.paidAmount)} د.ع
                      </p>
                      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        {editScanned.paymentMethod === "CARD" && (
                          <CardBrandLogos size="xs" />
                        )}
                        <span>
                          {paymentMethodLabel(editScanned.paymentMethod)} ·{" "}
                          {editScanned.itemCount} صنف/خدمة
                        </span>
                      </p>
                    </div>
                    <div className="border-b p-3 sm:border-b-0 sm:border-e">
                      <p className="text-xs text-muted-foreground">أنشأها</p>
                      <p className="font-bold">
                        {editScanned.salespersonName ?? "غير موثّق"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {editScanned.shiftType === "RECEPTION"
                          ? "نقطة الاستقبال"
                          : "نقطة البيع"}
                      </p>
                    </div>
                    <div className="p-3">
                      <p className="text-xs text-muted-foreground">التوصيل</p>
                      <p className="font-bold">
                        {editScanned.consignmentNumber ?? "غير مسندة"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {editScanned.consignmentStatus ?? "لا توجد عهدة توصيل"}
                      </p>
                    </div>
                  </div>

                  {editBlockReason && (
                    <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
                      <AlertTriangle
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0 text-destructive"
                      />
                      <div>
                        <p className="font-extrabold text-destructive">
                          لا يمكن بدء التعديل الآن
                        </p>
                        <p className="text-muted-foreground">
                          {editBlockReason}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {currentEditContext?.relations.consignmentId && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setCancelScannedCode(
                                  currentEditContext.source.number,
                                );
                                chooseSection("cancelAssignment");
                              }}
                            >
                              مراجعة الإسناد والعهدة
                            </Button>
                          )}
                          {currentEditContext?.relations.aftercareCaseId && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                openAftercare({
                                  caseId:
                                    currentEditContext.relations
                                      .aftercareCaseId,
                                })
                              }
                            >
                              فتح المعالجة المرتبطة
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <Button
                    className="w-full py-6 text-base font-extrabold"
                    disabled={
                      !editScanned.canCorrect ||
                      !!editBlockReason ||
                      editPreview.isFetching ||
                      editWorkflow.isFetching ||
                      !!editWorkflow.error
                    }
                    onClick={() =>
                      navigate(
                        `/invoices/${editScanned.id}/correct?from=reception-edit`,
                      )
                    }
                  >
                    <FilePenLine aria-hidden className="size-5" />
                    تعديل الفاتورة
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    يُفتح محرر الفاتورة الحالية. عند عدم وجود مبلغ مقبوض لا يوجد
                    استرداد مالي؛ يحدّد الخادم مسار الحفظ حسب حالة الفاتورة.
                  </p>
                </div>
              </Card>
            )}
          </div>
        )}

        {activeSection === "return" && returnWorkflow && branchId && (
          <WorkflowReturnSourceCard
            key={`${branchId}:${returnWorkflow.source.canonicalKey}`}
            branchId={branchId}
            shiftId={shift?.id}
            preview={returnWorkflow}
            onClear={() => setReturnWorkflow(null)}
            onAftercare={openAftercare}
            onChanged={(value) => setReturnWorkflow(value)}
            onCollect={(raw) => {
              setCollectScannedCode(raw);
              chooseSection("collect");
            }}
          />
        )}
        {activeSection === "return" && !returnWorkflow && (
          <WorkflowLegacyReturnStation
            source={returnScanned}
            branchId={branchId}
            actorId={me.data?.id}
            barcode={returnBarcodeInput}
            inputRef={returnRef}
            mode={returnType}
            onModeChange={setReturnType}
            onBarcodeChange={setReturnBarcodeInput}
            onLookup={lookupWorkOrder}
            onClear={() => {
              setReturnScanned(null);
              setReturnBarcodeInput("");
            }}
          />
        )}
      </div>

      <CancelDeliveryAssignmentDialog
        consignment={cancellingConsignment}
        open={Boolean(cancellingConsignment)}
        onOpenChange={(open) => {
          if (!open) setCancellingConsignment(null);
        }}
        onCompleted={() => {
          setCancellingConsignment(null);
          void utils.delivery.invalidate();
          void utils.workOrders.invalidate();
        }}
      />
    </div>
  );
}
