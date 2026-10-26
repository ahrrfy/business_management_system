import { skipToken } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { D, fmtAr, moneyInput } from "@/lib/money";
import { shiftTypeLabel } from "@/lib/labels";
import { trpc } from "@/lib/trpc";
import {
  purchaseTenderLabel,
  purchaseTenderSchema,
  type PurchaseTenderInput,
} from "@shared/purchaseTender";
import { normalizePurchaseBranchId } from "./PurchaseCashSourceField";

type TenderMode = PurchaseTenderInput["mode"];
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
): PurchaseTenderDraft {
  return {
    mode: tender?.mode ?? "DRAWER",
    shiftId:
      tender?.mode === "DRAWER" && tender.shiftId ? String(tender.shiftId) : "",
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
  const savedRef = useRef<PurchaseTenderInput | null>(null);
  const scope = `${normalizedBranchId ?? ""}:${supplierId ?? ""}`;
  const scopeRef = useRef(scope);
  const sources = trpc.purchases.paymentSources.useQuery(
    enabled && normalizedBranchId != null && supplierId != null
      ? { branchId: normalizedBranchId, supplierId }
      : skipToken,
    { retry: false },
  );
  const cash = trpc.supplierPayments.cashSources.useQuery(
    enabled && normalizedBranchId != null
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
      !canChooseDrawer ||
      savedRef.current != null ||
      draft.shiftId ||
      drawers.length !== 1
    )
      return;
    setDraft((current) => ({ ...current, shiftId: String(drawers[0]!.id) }));
  }, [enabled, canChooseDrawer, draft.shiftId, cash.data]);

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
  const payload = enabled
    ? buildPurchaseTenderPayload(normalizedDraft)
    : undefined;
  let validationError: string | null = null;
  if (enabled) {
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
    else if (draft.mode === "CARD" && draft.referenceNumber.trim().length > 160)
      validationError = "مرجع البطاقة يجب ألا يتجاوز 160 حرفاً.";
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
    (sources.isLoading ||
      (amounts.remainder.gt(0) &&
        draft.mode !== "CARD" &&
        !retainsDrawer &&
        cash.isLoading));
  const isActionBlocked =
    enabled && (isLoading || validationError != null || !payload);
  const sourceSummaryLabel = payload
    ? purchaseTenderLabel(payload)
    : draft.mode === "CARD"
      ? "بطاقة الشركة"
      : draft.mode === "TREASURY"
        ? "نقد من الخزنة"
        : "نقد من الوردية";
  function reset(tender?: PurchaseTenderInput | null, nextScope = scope) {
    scopeRef.current = nextScope;
    savedRef.current = tender ?? null;
    setDraft(purchaseTenderDraft(tender));
  }
  function change<K extends keyof PurchaseTenderDraft>(
    key: K,
    value: PurchaseTenderDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  return {
    draft,
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

export function PurchaseTenderField({
  idPrefix,
  state,
  paymentTerms,
  currency,
}: {
  idPrefix: string;
  state: ReturnType<typeof usePurchaseTenderState>;
  paymentTerms: string;
  currency: string;
}) {
  if (paymentTerms !== "CASH")
    return (
      <p className="text-xs text-muted-foreground">
        آجلة: تثبت ذمة المورد عند الترحيل، ويُسجل السداد الفعلي بسند صرف معتمد.
      </p>
    );
  if (currency !== "IQD")
    return (
      <p className="text-xs text-[var(--sem-warn)]">
        الفاتورة الدولارية تسدد من مسار الصيرفة؛ اختر آجلة ثم سجل التسديد الفعلي
        بعد الاستلام.
      </p>
    );
  const { draft, change, amounts } = state;
  return (
    <section
      className="space-y-2 rounded-md border bg-card px-3 py-2"
      aria-label="سداد فاتورة المورد"
    >
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-tender-mode`} className="text-xs">
            مصدر السداد
          </Label>
          <AppSelect
            id={`${idPrefix}-tender-mode`}
            value={draft.mode}
            onValueChange={(value) => change("mode", value as TenderMode)}
            aria-label="مصدر السداد"
          >
            <option value="DRAWER">نقد من الوردية</option>
            <option value="TREASURY">نقد من الخزنة</option>
            <option value="CARD">بطاقة الشركة</option>
          </AppSelect>
        </div>
        {draft.mode === "DRAWER" ? (
          <div className="space-y-1 text-xs">
            {state.canChooseDrawer &&
            (state.drawers.length > 1 ||
              (state.drawers.length === 1 &&
                draft.shiftId !== String(state.drawers[0]!.id))) ? (
              <>
                <Label htmlFor={`${idPrefix}-tender-shift`}>وردية الدافع</Label>
                <AppSelect
                  id={`${idPrefix}-tender-shift`}
                  value={draft.shiftId}
                  onValueChange={(value) => change("shiftId", value)}
                  aria-label="وردية الدافع"
                >
                  <option value="">اختر الوردية</option>
                  {state.drawers.map((row) => (
                    <option key={row.id} value={String(row.id)}>
                      {shiftTypeLabel(row.shiftType)} — درج #{row.id}
                    </option>
                  ))}
                </AppSelect>
              </>
            ) : (
              <p>
                {draft.shiftId
                  ? `وردية الدافع المحفوظة / الحالية #${draft.shiftId}`
                  : "لا توجد وردية محددة للدافع"}
              </p>
            )}
          </div>
        ) : null}
        {draft.mode === "CARD" ? (
          <>
            <div className="space-y-1">
              <Label className="text-xs">حساب بطاقة الشركة</Label>
              <p className="text-xs">
                {state.cardAccount
                  ? `${state.cardAccount.code} — ${state.cardAccount.name}`
                  : "حساب بطاقة الشركة غير متاح"}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-card-last-four`} className="text-xs">
                آخر أربعة أرقام
              </Label>
              <Input
                id={`${idPrefix}-card-last-four`}
                aria-label="آخر أربعة أرقام"
                dir="ltr"
                inputMode="numeric"
                maxLength={4}
                value={draft.cardLastFour}
                onChange={(event) =>
                  change(
                    "cardLastFour",
                    event.target.value.replace(/\D/g, "").slice(0, 4),
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-card-reference`} className="text-xs">
                مرجع عملية البطاقة
              </Label>
              <Input
                id={`${idPrefix}-card-reference`}
                aria-label="مرجع عملية البطاقة"
                maxLength={160}
                value={draft.referenceNumber}
                onChange={(event) =>
                  change("referenceNumber", event.target.value)
                }
              />
              <p className="text-[10px] text-muted-foreground">
                مرجع توثيقي للعملية؛ لا يمثل تحققاً مصرفياً آلياً.
              </p>
            </div>
          </>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-prior-payment`} className="text-xs">
            دفعة سابقة معتمدة (اختياري)
          </Label>
          <AppSelect
            id={`${idPrefix}-prior-payment`}
            aria-label="دفعة سابقة معتمدة"
            value={draft.previousReceiptId}
            onValueChange={(value) => change("previousReceiptId", value)}
          >
            <option value="">بدون ربط دفعة سابقة</option>
            {state.previousPayments.map((row) => (
              <option key={row.id} value={String(row.id)}>
                {row.voucherNumber ?? `سند #${row.id}`} — المتاح{" "}
                {fmtAr(row.availableAmount)} د.ع
              </option>
            ))}
          </AppSelect>
        </div>
      </div>
      <div
        className="flex flex-wrap gap-x-5 gap-y-1 border-t pt-2 text-xs"
        aria-label="معاينة السداد"
      >
        <span>قيمة الفاتورة: {fmtAr(amounts.amount.toFixed(2))} د.ع</span>
        <span>من الدفعة السابقة: {fmtAr(amounts.applied.toFixed(2))} د.ع</span>
        <span>
          {amounts.remainder.gt(0)
            ? `الصرف الجديد (${state.sourceSummaryLabel}): ${fmtAr(amounts.remainder.toFixed(2))} د.ع`
            : "لا يوجد صرف جديد"}
        </span>
        {amounts.unused.gt(0) ? (
          <span>
            المتبقي غير المستخدم من الدفعة: {fmtAr(amounts.unused.toFixed(2))}{" "}
            د.ع
          </span>
        ) : null}
        <span>المتبقي على الفاتورة بعد الاعتماد والسداد: 0.00 د.ع</span>
      </div>
      <p className="text-[10px] text-muted-foreground">
        هذه نية سداد تحفظ مع المراجعة؛ لا تتحرك الأموال قبل الاعتماد. دفعات
        المورد الأخرى مستقلة ولا تُستنتج من رصيده.
      </p>
      {state.validationError ? (
        <div
          className="flex items-center gap-2 text-xs text-[var(--sem-warn)]"
          role="alert"
        >
          <p>{state.validationError}</p>
          {state.showRetry ? (
            <button type="button" className="underline" onClick={state.retry}>
              إعادة التحقق
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
