import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRightLeft, ShieldAlert } from "lucide-react";
import { Link } from "wouter";
import { assessUnitCostAnomaly, assessUsdRateSanity, USD_RATE_SANITY } from "@shared/balanceTrail";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Textarea } from "@/components/ui/textarea";
import { D, fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";

export type PurchaseRateSanityView = {
  status: "OK" | "WARN" | "ANOMALOUS";
  suggestedRate: string | null;
  referenceRate: string | null;
  message: string | null;
};

export type PurchaseUnitCostWarningView = {
  variantId?: number;
  idx?: number;
  itemLabel: string;
  newUnitCostIqd?: string;
  currentCostIqd?: string;
  kind?: "SHARP_DROP" | "SHARP_SPIKE";
  ratio?: string | null;
  message: string;
};

function useNoopPurchaseList() {
  return { data: undefined };
}

export function usePurchaseRateGuard(params: {
  currency: "IQD" | "USD";
  agreedRate: string;
  branchId: number | null | undefined;
  excludePurchaseOrderId?: number;
  explicitReferenceRate?: string | null;
  items: ReadonlyArray<{
    variantId: number;
    name: string;
    price: string;
    conversionFactor: string;
    costBase?: string | null;
  }>;
  getItemCostBase?: (variantId: number, fallback?: string | null) => string | null | undefined;
  meData?: { isOwner?: boolean | null; role?: string | null } | null;
}) {
  const {
    currency,
    agreedRate,
    branchId,
    excludePurchaseOrderId,
    explicitReferenceRate,
    items,
    getItemCostBase,
    meData,
  } = params;
  const [confirmAnomalousRate, setConfirmAnomalousRate] = useState(false);
  const [rateDeviationReason, setRateDeviationReason] = useState("");
  const usePurchaseListQuery =
    (trpc.purchases as { list?: typeof trpc.purchases.list } | undefined)?.list
      ?.useQuery ?? useNoopPurchaseList;
  const recentOrders = usePurchaseListQuery(
    { branchId: branchId && branchId > 0 ? branchId : undefined, limit: 30 },
    {
      enabled:
        explicitReferenceRate === undefined &&
        currency === "USD" &&
        Boolean(branchId && branchId > 0),
    },
  );
  const derivedReferenceRate = useMemo(() => {
    if (explicitReferenceRate !== undefined) return explicitReferenceRate;
    const match = (recentOrders.data ?? []).find((row) => {
      if (excludePurchaseOrderId && Number(row.id) === excludePurchaseOrderId) return false;
      if (row.agreedCurrency !== "USD") return false;
      if (!["CONFIRMED", "RECEIVED"].includes(row.status)) return false;
      const r = row.agreedRate != null ? D(row.agreedRate) : null;
      return Boolean(
        r &&
          r.gte(USD_RATE_SANITY.MIN_NORMAL_IQD) &&
          r.lte(USD_RATE_SANITY.MAX_NORMAL_IQD),
      );
    });
    return match?.agreedRate ? String(match.agreedRate) : null;
  }, [explicitReferenceRate, recentOrders.data, excludePurchaseOrderId]);
  useEffect(() => {
    setConfirmAnomalousRate(false);
  }, [agreedRate, currency]);

  const canOverrideRateAnomaly =
    meData?.isOwner === true || meData?.role === "admin" || meData?.role === "manager";
  const rateNum = D(agreedRate || "0");
  const rateSanity = useMemo(
    () =>
      currency === "USD" && rateNum.gt(0)
        ? assessUsdRateSanity(agreedRate, derivedReferenceRate)
        : null,
    [currency, agreedRate, rateNum, derivedReferenceRate],
  );
  const unitCostWarnings = useMemo(
    () =>
      items.flatMap((l, idx) => {
        const refCost = getItemCostBase ? getItemCostBase(l.variantId, l.costBase) : l.costBase;
        if (!refCost || D(refCost).lte(0)) return [];
        const lineUnitIqd =
          currency === "USD" && rateNum.gt(0) ? D(l.price || "0").times(rateNum) : D(l.price || "0");
        const cf = D(l.conversionFactor || "1");
        const unitCostBaseIqd = cf.gt(0) ? lineUnitIqd.dividedBy(cf) : lineUnitIqd;
        const res = assessUnitCostAnomaly(unitCostBaseIqd, refCost, l.name);
        return res.isAnomalous && res.message ? [{ idx, itemLabel: l.name, message: res.message }] : [];
      }),
    [items, currency, rateNum, getItemCostBase],
  );
  function validateRateGuard(): string | null {
    if (rateSanity?.status !== "ANOMALOUS") return null;
    if (!canOverrideRateAnomaly || !confirmAnomalousRate) {
      return rateSanity.message ?? "سعر صرف الدولار شاذ — صحح السعر قبل الحفظ.";
    }
    if (rateDeviationReason.trim().length < 5) {
      return "أدخل سبب اعتماد سعر الصرف الشاذ (5 أحرف على الأقل).";
    }
    return null;
  }
  const overridePayload = confirmAnomalousRate
    ? { confirmAnomalousRate: true as const, rateDeviationReason: rateDeviationReason.trim() }
    : {};
  return {
    referenceRate: derivedReferenceRate,
    canOverrideRateAnomaly,
    confirmAnomalousRate,
    setConfirmAnomalousRate,
    rateDeviationReason,
    setRateDeviationReason,
    unitCostWarnings,
    validateRateGuard,
    overridePayload,
  };
}

export function PurchaseRateAnomalyBanner({
  purchaseOrderId, status, agreedCurrency, agreedRate, rateSanity, unitCostWarnings = [], canEdit = false,
}: {
  purchaseOrderId: number; status: string; agreedCurrency?: string | null;
  agreedRate?: string | number | null; rateSanity?: PurchaseRateSanityView | null;
  unitCostWarnings?: PurchaseUnitCostWarningView[]; canEdit?: boolean;
}) {
  const effectiveSanity = agreedCurrency === "USD" ? (rateSanity ?? assessUsdRateSanity(agreedRate)) : null;
  const hasRateIssue = Boolean(effectiveSanity && effectiveSanity.status !== "OK" && effectiveSanity.message);
  if (!hasRateIssue && unitCostWarnings.length === 0) return null;
  const isAnomalous = effectiveSanity?.status === "ANOMALOUS";
  const canReverse = status === "CONFIRMED" || status === "RECEIVED";
  return (
    <div className="space-y-2">
      {hasRateIssue && effectiveSanity?.message ? (
        <div
          role="alert"
          className={
            isAnomalous
              ? "flex flex-col gap-2 rounded-lg border border-[var(--sem-danger)]/40 bg-[var(--sem-danger-bg)] p-3 text-sm text-[var(--sem-danger)]"
              : "flex flex-col gap-2 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]"
          }
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-semibold">
                  {isAnomalous ? "تحذير شذوذ سعر صرف الدولار" : "تنبيه فرق سعر الصرف عن المرجع"}
                </p>
                <p className="text-xs leading-relaxed">{effectiveSanity.message}</p>
              </div>
            </div>
            {status === "DRAFT" && canEdit ? (
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <Link href={`/purchases/${purchaseOrderId}/edit`}>تعديل السعر</Link>
              </Button>
            ) : canReverse ? (
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <Link href="/purchases/goods-receipt-reversals">عكس وتصحيح الاستلام</Link>
              </Button>
            ) : null}
          </div>
          {status === "SENT" ? (
            <p className="text-xs font-medium">
              بانتظار الاعتماد — يمكنك رفض الطلب لإعادة تعديل سعر الصرف
            </p>
          ) : null}
        </div>
      ) : null}
      {unitCostWarnings.length > 0 ? (
        <div role="alert" className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            <span>تنبيه انحراف تكلفة الوحدة عن متوسط الكلفة ({unitCostWarnings.length})</span>
          </div>
          <ul className="mt-1.5 list-disc space-y-1 ps-5 text-xs">
            {unitCostWarnings.map((w, i) => <li key={`${w.variantId ?? w.idx ?? i}`}>{w.message}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function PurchaseRateGuardBox({
  currency, agreedRate, referenceRate, canOverrideAnomaly, confirmAnomalousRate,
  rateDeviationReason, onApplySuggestedRate, onToggleConfirm, onReasonChange, unitCostWarnings = [],
}: {
  currency: "IQD" | "USD"; agreedRate: string; referenceRate?: string | null;
  canOverrideAnomaly: boolean; confirmAnomalousRate: boolean; rateDeviationReason: string;
  onApplySuggestedRate: (suggestedRate: string) => void;
  onToggleConfirm: (checked: boolean) => void; onReasonChange: (reason: string) => void;
  unitCostWarnings?: PurchaseUnitCostWarningView[];
}) {
  const sanity = currency === "USD" && agreedRate.trim() !== "" ? assessUsdRateSanity(agreedRate, referenceRate) : null;
  const hasRateIssue = Boolean(sanity && sanity.status !== "OK" && sanity.message);
  if (!hasRateIssue && unitCostWarnings.length === 0) return null;
  const isAnomalous = sanity?.status === "ANOMALOUS";
  return (
    <div className="space-y-2">
      {hasRateIssue && sanity?.message ? (
        <div
          role="alert"
          className={
            isAnomalous
              ? "space-y-2 rounded-lg border border-[var(--sem-danger)]/40 bg-[var(--sem-danger-bg)] p-3 text-sm text-[var(--sem-danger)]"
              : "space-y-2 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]"
          }
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-0.5">
                <p className="font-semibold">
                  {isAnomalous ? "سعر الصرف شاذ — يرجى المراجعة قبل الحفظ" : "تنبيه انحراف سعر الصرف"}
                </p>
                <p className="text-xs leading-relaxed">{sanity.message}</p>
              </div>
            </div>
            {sanity.suggestedRate ? (
              <Button type="button" size="sm" variant="outline" className="shrink-0 gap-1.5 bg-background text-foreground" onClick={() => onApplySuggestedRate(sanity.suggestedRate!)}>
                <ArrowRightLeft aria-hidden className="size-3.5" />
                تصحيح إلى {fmtAr(sanity.suggestedRate)}
              </Button>
            ) : null}
          </div>
          {isAnomalous ? (
            canOverrideAnomaly ? (
              <div className="space-y-2 border-t border-current/20 pt-2 text-xs text-foreground">
                <label className="flex cursor-pointer items-center gap-2 font-medium">
                  <Checkbox checked={confirmAnomalousRate} onCheckedChange={(v) => onToggleConfirm(v === true)} />
                  <span>أؤكد اعتماد سعر الصرف رغم الانحراف الكبير</span>
                </label>
                {confirmAnomalousRate ? (
                  <div className="space-y-1">
                    <Label htmlFor="rate-deviation-reason" className="text-xs">سبب استثناء سعر الصرف (5 أحرف على الأقل)</Label>
                    <Input id="rate-deviation-reason" value={rateDeviationReason} onChange={(e) => onReasonChange(e.target.value)} placeholder="مثال: سعر خاص متفق عليه مع المورد..." className="h-8 bg-background text-xs" />
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="border-t border-current/20 pt-1.5 text-xs">لا يمكن حفظ أو إرسال الأمر بسعر صرف شاذ — صحح السعر أو راجع المدير/المالك.</p>
            )
          ) : null}
        </div>
      ) : null}
      {unitCostWarnings.length > 0 ? (
        <div role="alert" className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            <span>تنبيه فرق حاد عن متوسط التكلفة الحالي ({unitCostWarnings.length})</span>
          </div>
          <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs">
            {unitCostWarnings.slice(0, 4).map((w, i) => <li key={`${w.idx ?? i}`}>{w.message}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function PurchaseRateAnomalyOverrideFields({
  message, isManagerOrOwner, confirmAnomalousRate, onConfirmAnomalousChange, rateDeviationReason, onRateDeviationReasonChange,
}: {
  message: string; isManagerOrOwner: boolean; confirmAnomalousRate: boolean; onConfirmAnomalousChange: (v: boolean) => void;
  rateDeviationReason: string; onRateDeviationReasonChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-[var(--sem-danger)]/40 bg-[var(--sem-danger-bg)] p-2.5 text-xs text-[var(--sem-danger)]">
      <p>{message}</p>
      {isManagerOrOwner ? (
        <div className="space-y-1.5 text-foreground">
          <label className="flex cursor-pointer items-center gap-2 font-medium">
            <Checkbox checked={confirmAnomalousRate} onCheckedChange={(v) => onConfirmAnomalousChange(v === true)} />
            <span>أؤكد اعتماد سعر الصرف الشاذ رغم الانحراف</span>
          </label>
          {confirmAnomalousRate ? (
            <Input value={rateDeviationReason} onChange={(e) => onRateDeviationReasonChange(e.target.value)} placeholder="سبب الانحراف (5 أحرف على الأقل)" className="h-8 bg-background text-xs" />
          ) : null}
        </div>
      ) : <p>يرجى تعديل سعر الصرف قبل الإرسال.</p>}
    </div>
  );
}

export function PurchaseOrderActionDialogs(props: {
  poNumber: string; isUsd: boolean; costHidden: boolean; isManagerOrOwner: boolean;
  rateSanity?: PurchaseRateSanityView | null;
  submitOpen: boolean; onSubmitOpenChange: (open: boolean) => void;
  submitPending: boolean; submitInvoiceTotal: string; submitInvoicePlaceholder?: string; onSubmitInvoiceTotalChange: (v: string) => void;
  submitReason: string; onSubmitReasonChange: (v: string) => void;
  confirmAnomalousRate: boolean; onConfirmAnomalousChange: (v: boolean) => void;
  rateDeviationReason: string; onRateDeviationReasonChange: (v: string) => void;
  onConfirmSubmit: () => void;
  rejectOpen: boolean; onRejectOpenChange: (open: boolean) => void;
  rejectPending: boolean; rejectReason: string; onRejectReasonChange: (v: string) => void;
  onConfirmReject: () => void;
}) {
  const isAnomalous = !props.costHidden && props.rateSanity?.status === "ANOMALOUS";
  const submitBlocked =
    props.submitPending ||
    props.submitReason.trim().length < 3 ||
    (!props.costHidden && !props.submitInvoiceTotal.trim()) ||
    (isAnomalous && (!props.isManagerOrOwner || !props.confirmAnomalousRate || props.rateDeviationReason.trim().length < 5));
  return (
    <>
      <Dialog open={props.submitOpen} onOpenChange={props.onSubmitOpenChange}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>إرسال أمر الشراء للاعتماد</DialogTitle>
            <DialogDescription className="text-xs">أدخل إجمالي الفاتورة الورقية ومطابقته قبل إرسال الأمر للمراجعة والاعتماد.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            {!props.costHidden ? (
              <div className="space-y-1">
                <Label htmlFor="po-submit-invoice-total" className="text-xs">إجمالي الفاتورة الورقية ({props.isUsd ? "$" : "د.ع"}) *</Label>
                <MoneyInput id="po-submit-invoice-total" value={props.submitInvoiceTotal} placeholder={props.submitInvoicePlaceholder} onChange={props.onSubmitInvoiceTotalChange} />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="po-submit-reason" className="text-xs">سبب الإرسال للاعتماد *</Label>
              <Input id="po-submit-reason" value={props.submitReason} onChange={(e) => props.onSubmitReasonChange(e.target.value)} />
            </div>
            {isAnomalous && props.rateSanity?.message ? (
              <PurchaseRateAnomalyOverrideFields
                message={props.rateSanity.message}
                isManagerOrOwner={props.isManagerOrOwner}
                confirmAnomalousRate={props.confirmAnomalousRate}
                onConfirmAnomalousChange={props.onConfirmAnomalousChange}
                rateDeviationReason={props.rateDeviationReason}
                onRateDeviationReasonChange={props.onRateDeviationReasonChange}
              />
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => props.onSubmitOpenChange(false)} disabled={props.submitPending}>إلغاء</Button>
            <Button type="button" disabled={submitBlocked} onClick={props.onConfirmSubmit}>
              {props.submitPending ? ACTION_LABELS.saving : "تأكيد الإرسال"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={props.rejectOpen} onOpenChange={props.onRejectOpenChange}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>رفض اعتماد أمر الشراء {props.poNumber}</DialogTitle>
            <DialogDescription className="text-xs">يعود الأمر إلى مسودة قابلة للتعديل بعد توثيق سبب الرفض.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="po-reject-reason" className="text-xs">سبب الرفض *</Label>
            <Textarea id="po-reject-reason" rows={2} value={props.rejectReason} onChange={(e) => props.onRejectReasonChange(e.target.value)} placeholder="مثال: خطأ في سعر الصرف أو الأسعار..." />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => props.onRejectOpenChange(false)} disabled={props.rejectPending}>إلغاء</Button>
            <Button type="button" variant="destructive" disabled={props.rejectPending || props.rejectReason.trim().length < 3} onClick={props.onConfirmReject}>
              {props.rejectPending ? ACTION_LABELS.saving : "تأكيد الرفض"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
