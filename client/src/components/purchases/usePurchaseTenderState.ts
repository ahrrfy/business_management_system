import { skipToken } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { D, moneyInput } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import {
  purchaseTenderLabel,
  purchaseTenderSchema,
  PURCHASE_TENDER_REFERENCE_MAX_LENGTH,
  type PurchaseTenderInput,
} from "@shared/purchaseTender";
import { normalizePurchaseBranchId } from "./PurchaseCashSourceField";

export type TenderMode = PurchaseTenderInput["mode"];
export type PurchaseLegacyCashSource = {
  mode: "DRAWER" | "TREASURY";
  shiftId: number | null;
};
export interface PurchaseTenderDraft {
  mode: TenderMode;
  shiftId: string;
  accountId: number | null;
  referenceNumber: string;
  cardLastFour: string;
  previousReceiptId: string;
}

export function purchaseTenderDraft(
  tender?: PurchaseTenderInput | null,
  legacySource?: PurchaseLegacyCashSource | null,
): PurchaseTenderDraft {
  const source = tender ?? legacySource;
  return {
    mode: source?.mode ?? "DRAWER",
    shiftId:
      source?.mode === "DRAWER" && source.shiftId ? String(source.shiftId) : "",
    accountId: tender?.mode === "CARD" ? tender.accountId : null,
    referenceNumber: tender?.mode === "CARD" ? tender.referenceNumber : "",
    cardLastFour: tender?.mode === "CARD" ? tender.cardLastFour : "",
    previousReceiptId: tender?.previousReceiptId
      ? String(tender.previousReceiptId)
      : "",
  };
}

export function buildPurchaseTenderPayload(
  draft: PurchaseTenderDraft,
): PurchaseTenderInput | undefined {
  const previous = draft.previousReceiptId
    ? { previousReceiptId: Number(draft.previousReceiptId) }
    : {};
  const result = purchaseTenderSchema.safeParse(
    draft.mode === "CARD"
      ? {
          mode: "CARD",
          accountId: draft.accountId,
          referenceNumber: draft.referenceNumber,
          cardLastFour: draft.cardLastFour,
          ...previous,
        }
      : draft.mode === "TREASURY"
        ? { mode: "TREASURY", ...previous }
        : {
            mode: "DRAWER",
            ...(draft.shiftId ? { shiftId: Number(draft.shiftId) } : {}),
            ...previous,
          },
  );
  return result.success ? result.data : undefined;
}

export function purchaseTenderAmounts(total: string, available = "0") {
  const amount = moneyInput(total);
  const prior = moneyInput(available);
  const applied = amount.lt(prior) ? amount : prior;
  return {
    amount,
    applied,
    remainder: amount.minus(applied).gt(0) ? amount.minus(applied) : D(0),
    unused: prior.minus(applied).gt(0) ? prior.minus(applied) : D(0),
  };
}

export function usePurchaseTenderState({
  branchId,
  supplierId,
  enabled,
  context,
  isCreator = false,
  total,
}: {
  branchId: number | null | undefined;
  supplierId: number | null | undefined;
  enabled: boolean;
  context: "create" | "edit";
  isCreator?: boolean;
  total: string;
}) {
  const normalizedBranchId = normalizePurchaseBranchId(branchId);
  const [draft, setDraft] = useState(() => purchaseTenderDraft());
  const [preservingLegacy, setPreservingLegacy] = useState(context === "edit");
  const [canPreserveLegacy, setCanPreserveLegacy] = useState(
    context === "edit",
  );
  const [legacyCashSource, setLegacyCashSource] =
    useState<PurchaseLegacyCashSource | null>(null);
  const savedRef = useRef<PurchaseTenderInput | null>(null);
  const scope = `${normalizedBranchId ?? ""}:${supplierId ?? ""}`;
  const scopeRef = useRef(scope);
  const sources = trpc.purchases.paymentSources.useQuery(
    enabled &&
      !preservingLegacy &&
      normalizedBranchId != null &&
      supplierId != null
      ? { branchId: normalizedBranchId, supplierId }
      : skipToken,
    { retry: false },
  );
  const cash = trpc.supplierPayments.cashSources.useQuery(
    enabled && !preservingLegacy && normalizedBranchId != null
      ? { branchId: normalizedBranchId }
      : skipToken,
    { retry: false },
  );

  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    savedRef.current = null;
    setDraft((current) => ({
      ...current,
      shiftId: "",
      previousReceiptId: "",
      referenceNumber: "",
      cardLastFour: "",
      accountId: null,
    }));
  }, [scope]);

  const drawers = cash.data?.drawers ?? [];
  const canChooseDrawer = context === "create" || isCreator;
  useEffect(() => {
    if (
      !enabled ||
      preservingLegacy ||
      !canChooseDrawer ||
      savedRef.current != null ||
      draft.shiftId ||
      drawers.length !== 1
    )
      return;
    setDraft((current) => ({ ...current, shiftId: String(drawers[0]!.id) }));
  }, [enabled, preservingLegacy, canChooseDrawer, draft.shiftId, cash.data]);

  const cardAccount = sources.data?.cardAccount ?? null;
  const previousPayments = sources.data?.previousPayments ?? [];
  const selectedPrevious = previousPayments.find(
    (row) => String(row.id) === draft.previousReceiptId,
  );
  const amounts = purchaseTenderAmounts(
    total,
    selectedPrevious?.availableAmount,
  );
  const saved = savedRef.current;
  const retainsDrawer =
    context === "edit" &&
    !isCreator &&
    saved?.mode === "DRAWER" &&
    draft.mode === "DRAWER" &&
    draft.shiftId === String(saved.shiftId ?? "");
  const normalizedDraft = {
    ...draft,
    accountId:
      draft.mode === "CARD"
        ? (draft.accountId ?? cardAccount?.id ?? null)
        : null,
  };
  const payload =
    enabled && !preservingLegacy
      ? buildPurchaseTenderPayload(normalizedDraft)
      : undefined;
  let validationError: string | null = null;
  if (enabled && !preservingLegacy) {
    if (!normalizedBranchId || !supplierId)
      validationError = "حدد الفرع والمورد للتحقق من مصادر السداد.";
    else if (sources.isError || (!sources.data && !sources.isLoading))
      validationError =
        "تعذر التحقق من حساب البطاقة والدفعات السابقة؛ أعد المحاولة قبل الحفظ.";
    else if (draft.previousReceiptId && !selectedPrevious && sources.data)
      validationError =
        "الدفعة السابقة المحددة لم تعد متاحة لهذا المورد والفرع؛ اختر دفعة متاحة أو ألغ ربطها.";
    else if (draft.mode === "CARD" && !cardAccount && sources.data)
      validationError =
        "حساب بطاقة الشركة غير متاح؛ فعّل الحساب من دليل الحسابات أو اختر مصدر سداد آخر.";
    else if (
      draft.mode === "CARD" &&
      draft.accountId != null &&
      cardAccount &&
      draft.accountId !== cardAccount.id
    )
      validationError =
        "حساب البطاقة المحفوظ تغير؛ راجع الحساب قبل تعديل نية السداد.";
    else if (draft.mode === "CARD" && !draft.referenceNumber.trim())
      validationError = "أدخل مرجع عملية بطاقة الشركة قبل الحفظ.";
    else if (
      draft.mode === "CARD" &&
      draft.referenceNumber.trim().length > PURCHASE_TENDER_REFERENCE_MAX_LENGTH
    )
      validationError = `مرجع البطاقة يجب ألا يتجاوز ${PURCHASE_TENDER_REFERENCE_MAX_LENGTH} حرفاً.`;
    else if (draft.mode === "CARD" && !/^\d{4}$/.test(draft.cardLastFour))
      validationError = "أدخل آخر أربعة أرقام من بطاقة الشركة بالضبط.";
    else if (amounts.remainder.gt(0) && draft.mode !== "CARD") {
      if (cash.isError || (!cash.data && !cash.isLoading))
        validationError = "تعذر التحقق من مصدر النقد؛ أعد المحاولة قبل الحفظ.";
      else if (
        draft.mode === "TREASURY" &&
        cash.data &&
        !cash.data.canUseTreasury
      )
        validationError =
          "لا تملك صلاحية الصرف من خزنة الفرع؛ اختر مصدراً مفوضاً.";
      else if (draft.mode === "DRAWER" && !retainsDrawer && !canChooseDrawer)
        validationError =
          "لا يمكن تحميل السداد على درج المحرر؛ احتفظ بمصدر المنشئ المحفوظ أو اختر مصدراً مفوضاً.";
      else if (
        draft.mode === "DRAWER" &&
        !retainsDrawer &&
        cash.data &&
        !drawers.some((row) => String(row.id) === draft.shiftId)
      )
        validationError =
          "اختر وردية مفتوحة باسم الدافع في هذا الفرع؛ لا يتحول السداد إلى الخزنة تلقائياً.";
    }
  }
  const isLoading =
    enabled &&
    !preservingLegacy &&
    (sources.isLoading ||
      (amounts.remainder.gt(0) &&
        draft.mode !== "CARD" &&
        !retainsDrawer &&
        cash.isLoading));
  const isActionBlocked =
    enabled &&
    !preservingLegacy &&
    (isLoading || validationError != null || !payload);
  const legacySourceLabel =
    legacyCashSource?.mode === "TREASURY"
      ? "نقد من الخزنة"
      : legacyCashSource?.mode === "DRAWER"
        ? `نقد من الوردية${legacyCashSource.shiftId ? ` #${legacyCashSource.shiftId}` : ""}`
        : "المصدر المحفوظ سابقاً";
  const sourceSummaryLabel = preservingLegacy
    ? legacySourceLabel
    : payload
      ? purchaseTenderLabel(payload)
      : draft.mode === "CARD"
        ? "بطاقة الشركة"
        : draft.mode === "TREASURY"
          ? "نقد من الخزنة"
          : "نقد من الوردية";
  function reset(
    tender?: PurchaseTenderInput | null,
    nextScope = scope,
    legacySource?: PurchaseLegacyCashSource | null,
    keepLegacy = context === "edit" && tender == null,
  ) {
    scopeRef.current = nextScope;
    savedRef.current = tender ?? null;
    setPreservingLegacy(keepLegacy);
    setCanPreserveLegacy(keepLegacy);
    setLegacyCashSource(keepLegacy ? (legacySource ?? null) : null);
    setDraft(purchaseTenderDraft(tender, legacySource));
  }
  function preserveLegacy() {
    if (!canPreserveLegacy) return;
    setPreservingLegacy(true);
    setDraft(purchaseTenderDraft(null, legacyCashSource));
  }
  function change<K extends keyof PurchaseTenderDraft>(
    key: K,
    value: PurchaseTenderDraft[K],
  ) {
    setPreservingLegacy(false);
    setDraft((current) => ({ ...current, [key]: value }));
  }
  return {
    draft,
    preservingLegacy,
    canPreserveLegacy,
    legacySourceLabel,
    preserveLegacy,
    change,
    payload,
    validationError,
    isActionBlocked,
    isLoading,
    sourceSummaryLabel,
    reset,
    drawers,
    canChooseDrawer,
    canUseTreasury: cash.data?.canUseTreasury === true,
    cardAccount,
    previousPayments,
    amounts,
    showRetry:
      sources.isError ||
      cash.isError ||
      (draft.mode === "CARD" && sources.data != null && !cardAccount),
    retry: () => {
      void sources.refetch();
      void cash.refetch();
    },
  };
}
