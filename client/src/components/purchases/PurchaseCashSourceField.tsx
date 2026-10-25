import { skipToken } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { bypassUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { shiftTypeLabel } from "@/lib/labels";
import { trpc } from "@/lib/trpc";

export type PurchaseCashSourceMode = "AUTO" | "DRAWER" | "TREASURY";

export type PurchaseCashSourcePayload = {
  mode: "DRAWER" | "TREASURY";
  shiftId?: number;
};

export function buildPurchaseCashSourcePayload(
  mode: PurchaseCashSourceMode,
  shiftId: string,
): PurchaseCashSourcePayload | undefined {
  if (mode === "AUTO") return undefined;
  if (mode === "TREASURY") return { mode: "TREASURY" };
  return {
    mode: "DRAWER",
    ...(shiftId ? { shiftId: Number(shiftId) } : {}),
  };
}

export function normalizePurchaseBranchId(
  branchId: number | null | undefined,
): number | null {
  return branchId != null &&
    Number.isInteger(Number(branchId)) &&
    Number(branchId) > 0
    ? Number(branchId)
    : null;
}

export interface PurchaseCashSourceDecisionInput {
  normalizedBranchId: number | null;
  enabled: boolean;
  context: "create" | "edit" | "approval";
  isCreator: boolean;
  mode: PurchaseCashSourceMode;
  shiftId: string;
  data:
    | {
        drawers: Array<{ id: number; shiftType: string }>;
        canUseTreasury: boolean;
      }
    | undefined;
  isLoading: boolean;
  isError?: boolean;
}

export function derivePurchaseCashSourceDecision({
  normalizedBranchId,
  enabled,
  context,
  isCreator,
  mode,
  shiftId,
  data,
  isLoading,
  isError = false,
}: PurchaseCashSourceDecisionInput) {
  const drawers = data?.drawers ?? [];
  const canUseTreasury = data?.canUseTreasury === true;
  const canChooseDrawer =
    context === "create" ||
    (context === "edit" && isCreator) ||
    (context === "approval" && (canUseTreasury || isCreator));
  const isResolved = enabled && normalizedBranchId != null && data != null;
  const validShiftId =
    isResolved && drawers.some((d) => String(d.id) === shiftId) ? shiftId : "";

  let validationError: string | null = null;
  if (enabled && mode !== "AUTO") {
    if (mode === "DRAWER" && !canChooseDrawer) {
      validationError =
        "لا يخصم سداد الفاتورة النقدية من درج محرر او معتمد مستقل؛ اختر الوضع التلقائي.";
    } else if (normalizedBranchId == null) {
      validationError =
        "حدد الفرع اولا للتحقق من مصدر النقد المتاح لسداد الفاتورة النقدية.";
    } else if (isError || (!data && !isLoading)) {
      validationError =
        "تعذر التحقق من مصادر النقد المتاحة في هذا الفرع؛ اعد المحاولة او اختر الوضع التلقائي.";
    } else if (data) {
      if (mode === "TREASURY" && !canUseTreasury) {
        validationError =
          "لا تملك صلاحية الصرف من خزينة الفرع؛ اختر الوضع التلقائي او درج الوردية المفتوح.";
      } else if (mode === "DRAWER") {
        if (drawers.length === 0) {
          validationError = canUseTreasury
            ? "لا يوجد درج وردية مفتوح لك في هذا الفرع؛ اختر خزينة الفرع او الوضع التلقائي."
            : "لا يوجد درج وردية مفتوح لك في هذا الفرع؛ افتح وردية اولا او اختر الوضع التلقائي ليعتمدها المالك من الخزينة.";
        } else if (!validShiftId) {
          validationError = "اختر درج الوردية المفتوح لسداد الفاتورة النقدية.";
        }
      }
    }
  }

  const isActionBlocked =
    enabled &&
    (validationError != null ||
      (mode !== "AUTO" && (!isResolved || isLoading)));

  const payload =
    enabled && validationError == null && (mode === "AUTO" || isResolved)
      ? buildPurchaseCashSourcePayload(mode, validShiftId)
      : undefined;

  return {
    drawers,
    canUseTreasury,
    canChooseDrawer,
    isResolved,
    validShiftId,
    validationError,
    isActionBlocked,
    payload,
  };
}

export interface UsePurchaseCashSourceOptions {
  branchId: number | null | undefined;
  enabled: boolean;
  context: "create" | "edit" | "approval";
  isCreator?: boolean;
}

export function usePurchaseCashSourceState({
  branchId,
  enabled,
  context,
  isCreator = false,
}: UsePurchaseCashSourceOptions) {
  const [mode, setModeState] = useState<PurchaseCashSourceMode>("AUTO");
  const [shiftId, setShiftId] = useState("");
  const userTouchedRef = useRef(false);

  const normalizedBranchId = normalizePurchaseBranchId(branchId);
  const prevBranchIdRef = useRef<number | null>(normalizedBranchId);
  const query = trpc.supplierPayments.cashSources.useQuery(
    enabled && normalizedBranchId != null
      ? { branchId: normalizedBranchId }
      : skipToken,
    {
      retry: false,
    },
  );

  useEffect(() => {
    if (prevBranchIdRef.current === normalizedBranchId) return;
    prevBranchIdRef.current = normalizedBranchId;
    setShiftId("");
    if (!userTouchedRef.current) {
      setModeState("AUTO");
    }
  }, [normalizedBranchId]);

  const decision = derivePurchaseCashSourceDecision({
    normalizedBranchId,
    enabled,
    context,
    isCreator,
    mode,
    shiftId,
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError === true,
  });
  const {
    drawers,
    canUseTreasury,
    canChooseDrawer,
    isResolved,
    validShiftId,
    validationError,
    isActionBlocked,
    payload,
  } = decision;

  useEffect(() => {
    if (!enabled) {
      userTouchedRef.current = false;
      return;
    }
    const data = query.data;
    if (!data) return;

    if (drawers.length > 0) {
      if (!shiftId || !drawers.some((d) => String(d.id) === shiftId)) {
        setShiftId(String(drawers[0]!.id));
      }
    } else if (shiftId) {
      setShiftId("");
    }

    if (context === "create" && !userTouchedRef.current) {
      if (drawers.length > 0) {
        setModeState("DRAWER");
      } else if (data.canUseTreasury) {
        setModeState("TREASURY");
      } else {
        setModeState("AUTO");
      }
    }
  }, [enabled, query.data, drawers, shiftId, context]);

  function setMode(next: PurchaseCashSourceMode) {
    userTouchedRef.current = true;
    setModeState(next);
  }

  function reset() {
    userTouchedRef.current = false;
    setModeState("AUTO");
    setShiftId("");
  }

  const sourceSummaryLabel =
    mode === "TREASURY"
      ? "خزينة الفرع"
      : mode === "DRAWER"
        ? `درج الوردية #${validShiftId || "المفتوح"}`
        : "المصدر المعلن للفاتورة او الخزينة المعتمدة";

  return {
    mode,
    setMode,
    shiftId: validShiftId,
    setShiftId,
    drawers,
    canUseTreasury,
    canChooseDrawer,
    isResolved,
    isLoading: query.isLoading,
    validationError,
    isActionBlocked,
    payload,
    sourceSummaryLabel,
    reset,
  };
}

export interface PurchaseCashSourceFieldProps {
  idPrefix: string;
  context: "create" | "edit" | "approval";
  state: ReturnType<typeof usePurchaseCashSourceState>;
  declaredSourceHint?: string | null;
}

export function PurchaseCashSourceField({
  idPrefix,
  context,
  state,
  declaredSourceHint,
}: PurchaseCashSourceFieldProps) {
  const autoLabel =
    context === "approval"
      ? declaredSourceHint
        ? `تلقائي حسب تصريح الفاتورة (${declaredSourceHint})`
        : "تلقائي (درج منشئ الفاتورة او خزينة المالك)"
      : context === "edit"
        ? "الابقاء على مصدر الصرف المعلن للفاتورة"
        : "تلقائي عند الاعتماد (درج المنشئ او خزينة المالك)";

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2.5 text-xs">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-cash-mode`} className="text-xs">
          مصدر سداد الفاتورة النقدية
        </Label>
        <AppSelect
          id={`${idPrefix}-cash-mode`}
          className="h-9"
          value={state.mode}
          onValueChange={(v) => state.setMode(v as PurchaseCashSourceMode)}
          aria-label="مصدر سداد الفاتورة النقدية"
        >
          <option value="AUTO">{autoLabel}</option>
          {state.canChooseDrawer ? (
            <option value="DRAWER">
              {context === "approval"
                ? "درج ورديتي المفتوح (تجاوز)"
                : "درج الوردية المفتوح"}
            </option>
          ) : null}
          {state.canUseTreasury ? (
            <option value="TREASURY">
              {context === "approval"
                ? "خزينة الفرع الرئيسية (تجاوز)"
                : "خزينة الفرع الرئيسية"}
            </option>
          ) : null}
        </AppSelect>
      </div>

      {state.mode === "DRAWER" && state.drawers.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-cash-shift`} className="text-xs">
            الوردية المفتوحة
          </Label>
          <AppSelect
            id={`${idPrefix}-cash-shift`}
            className="h-9"
            value={state.shiftId}
            onValueChange={state.setShiftId}
            aria-label="الوردية المفتوحة"
          >
            {state.drawers.map((row) => (
              <option key={row.id} value={String(row.id)}>
                {shiftTypeLabel(row.shiftType)} — درج #{row.id}
              </option>
            ))}
          </AppSelect>
        </div>
      ) : null}

      {state.validationError ? (
        <p className="text-xs text-[var(--sem-warn)]">{state.validationError}</p>
      ) : context === "create" &&
        state.mode === "AUTO" &&
        state.isResolved &&
        !state.isLoading &&
        state.drawers.length === 0 &&
        !state.canUseTreasury ? (
        <p className="text-xs text-muted-foreground">
          لا توجد وردية مفتوحة باسمك حاليا؛ ستحفظ الفاتورة النقدية ليعتمدها المالك من الخزينة، او افتح وردية قبل الحفظ للصرف من درجك.
        </p>
      ) : null}
    </div>
  );
}

export interface PurchaseSettlementPolicyCardProps {
  idPrefix: string;
  context: "create" | "edit";
  paymentTerms: string;
  currency: string;
  cashSourceState: ReturnType<typeof usePurchaseCashSourceState>;
}

export function PurchaseSettlementPolicyCard({
  idPrefix,
  context,
  paymentTerms,
  currency,
  cashSourceState,
}: PurchaseSettlementPolicyCardProps) {
  return (
    <Card>
      <CardContent className="space-y-2.5 px-4 py-3 text-sm">
        <div className="font-extrabold">سياسة تسوية المورد ومصدر السداد</div>
        {paymentTerms === "CASH" ? (
          <>
            <p className="text-muted-foreground">
              نقدي: المورد استلم نقديته بالكامل وصافي الذمة المتبقية على هذه الفاتورة يساوي صفرا (0.00). يسدد النظام الفاتورة ذريا فور اعتمادها وترحيلها من مصدر النقد المحدد ادناه.
            </p>
            {currency === "IQD" ? (
              <PurchaseCashSourceField
                idPrefix={idPrefix}
                context={context}
                state={cashSourceState}
              />
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">
            اجل: ترفع هذه الفاتورة ذمة المورد بقيمتها عند الاعتماد والترحيل، وتنخفض الذمة تلقائيا مع تسوية الفاتورة عند اصدار واعتماد سند صرف للمورد.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export type PurchaseWorkflowCreated = {
  purchaseOrderId: number;
  version: number;
  poNumber: string;
};

export async function runSubmitForApprovalWorkflow(args: {
  isCash: boolean;
  clientRequestId: string;
  createOrder: () => Promise<PurchaseWorkflowCreated>;
  confirmOrder: (input: {
    purchaseOrderId: number;
    expectedVersion: number;
    reason: string;
    clientRequestId: string;
  }) => Promise<unknown>;
  invalidateAll: () => Promise<unknown>;
  onSuccessToast: (msg: string) => void;
  onErrorToast: (err: unknown) => void;
  onNavigate: (path: string) => void;
  setPending: (pending: boolean) => void;
}) {
  args.setPending(true);
  let createdPoId: number | null = null;
  try {
    const created = await args.createOrder();
    createdPoId = created.purchaseOrderId;
    await args.confirmOrder({
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: `ارسال فاتورة الشراء ${created.poNumber} للاعتماد المستقل بعد اكمال البيانات`,
      clientRequestId: `${args.clientRequestId}:submit`,
    });
    await args.invalidateAll();
    args.onSuccessToast(
      args.isCash
        ? `حفظت الفاتورة النقدية ${created.poNumber} وارسلت للاعتماد؛ سيسدد النقد ذريا فور اعتمادها وترحيلها`
        : `حفظت الفاتورة الاجلة ${created.poNumber} وارسلت للاعتماد المستقل`,
    );
    bypassUnsavedGuard();
    args.onNavigate("/purchases");
  } catch (e) {
    args.onErrorToast(e);
    if (createdPoId != null) {
      await args.invalidateAll().catch(() => undefined);
      bypassUnsavedGuard();
      args.onNavigate(`/purchases/${createdPoId}`);
    }
  } finally {
    args.setPending(false);
  }
}

export async function runImmediatePostWorkflow<TCashSource>(args: {
  isCash: boolean;
  clientRequestId: string;
  cashSource: TCashSource;
  createOrder: () => Promise<PurchaseWorkflowCreated>;
  confirmOrder: (input: {
    purchaseOrderId: number;
    expectedVersion: number;
    reason: string;
    clientRequestId: string;
  }) => Promise<{ requestId: number }>;
  decideOrder: (input: {
    requestId: number;
    decisionKey: string;
    approve: true;
    confirmedFullReceipt: true;
    reason: string;
    cashSource: TCashSource;
  }) => Promise<unknown>;
  invalidateAll: () => Promise<unknown>;
  onSuccessToast: (msg: string) => void;
  onWarnToast: (msg: string) => void;
  onErrorToast: (err: unknown) => void;
  onNavigate: (path: string) => void;
  setPending: (pending: boolean) => void;
}) {
  args.setPending(true);
  let createdPoId: number | null = null;
  let createdPoNumber = "";
  let submittedForApproval = false;
  try {
    const created = await args.createOrder();
    createdPoId = created.purchaseOrderId;
    createdPoNumber = created.poNumber;
    const submitted = await args.confirmOrder({
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: `ارسال الفاتورة ${created.poNumber} للترحيل الفوري`,
      clientRequestId: `${args.clientRequestId}:submit`,
    });
    submittedForApproval = true;
    await args.decideOrder({
      requestId: submitted.requestId,
      decisionKey: `${args.clientRequestId}:decide`,
      approve: true,
      confirmedFullReceipt: true,
      reason: `اعتماد واستلام وترحيل فوري للفاتورة ${created.poNumber}`,
      cashSource: args.cashSource,
    });
    await args.invalidateAll();
    args.onSuccessToast(
      args.isCash
        ? `تم استلام وترحيل وسداد الفاتورة النقدية ${created.poNumber} بالكامل — المتبقي على الفاتورة 0.00`
        : `تم استلام وترحيل الفاتورة الاجلة ${created.poNumber} واثبات ذمة المورد بنجاح`,
    );
    bypassUnsavedGuard();
    args.onNavigate("/purchases");
  } catch (e) {
    args.onErrorToast(e);
    if (createdPoId != null) {
      await args.invalidateAll().catch(() => undefined);
      if (submittedForApproval) {
        args.onWarnToast(
          `حفظت الفاتورة ${createdPoNumber} وارسلت للاعتماد بانتظار استكمال الترحيل من صفحتها دون صرف مكرر`,
        );
      }
      bypassUnsavedGuard();
      args.onNavigate(`/purchases/${createdPoId}`);
    }
  } finally {
    args.setPending(false);
  }
}
