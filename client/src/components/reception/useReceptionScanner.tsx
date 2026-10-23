import { receptionDialogBlocksInput } from "@/lib/receptionReceiptSettlement";
import { useCallback } from "react";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { offlineFindByBarcode } from "@/lib/offline/catalogSync";
import { notify } from "@/lib/notify";
import { parseScan } from "@/lib/scanRouter";
import { trpc } from "@/lib/trpc";
import { type PosRow, type Tier } from "@/components/reception/cartMath";
export interface useReceptionScannerInput {
  draftResumeEpochRef: React.RefObject<number>;
  barcodePricingContextRef: React.RefObject<string>;
  requireAction: (path: string) => void;
  offline: boolean;
  effectiveTier: import("@/components/reception/cartMath").Tier;
  branchId: number;
  utils: ReturnType<typeof trpc.useUtils>;
  customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer;
  addRow: (row: import("@/components/reception/cartMath").PosRow) => void;
  draftPromotionFlightRef: React.RefObject<boolean>;
  draftTransitionPending: boolean;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  setCustomer: (
    customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer,
  ) => void;
  depositOpen: boolean;
  cardsOpen: boolean;
  fulfillIntentId: number | null;
  closing: boolean;
  deliveryDialogOpen: false;
  customerContextId: number | null;
  showInbox: boolean;
  showCustomization: {
    row: import("@/components/reception/cartMath").PosRow;
    editingKey?: string | undefined;
  } | null;
  cashDropping: boolean;
  approvalAsk: { lineKey: string; pct: number } | null;
  showReceiptOverlay: boolean;
  submitting: boolean;
  setShowDrop: React.Dispatch<React.SetStateAction<boolean>>;
}
export function useReceptionScanner({
  draftResumeEpochRef,
  barcodePricingContextRef,
  requireAction,
  offline,
  effectiveTier,
  branchId,
  utils,
  customer,
  addRow,
  draftPromotionFlightRef,
  draftTransitionPending,
  setSearch,
  setCustomer,
  depositOpen,
  cardsOpen,
  fulfillIntentId,
  closing,
  deliveryDialogOpen,
  customerContextId,
  showInbox,
  showCustomization,
  cashDropping,
  approvalAsk,
  showReceiptOverlay,
  submitting,
  setShowDrop,
}: useReceptionScannerInput) {
  const lookupBarcode = useCallback(
    async (code: string) => {
      const lookupEpoch = draftResumeEpochRef.current,
        pricingContext = barcodePricingContextRef.current;
      try {
        requireAction("catalog.byBarcode");
        // أوفلاين: المطابقة من النموذج المحلي (الباركود الأساسي + البدائل)، نمط POS.tsx.
        const row = offline
          ? await offlineFindByBarcode(code, effectiveTier, branchId)
          : await utils.catalog.byBarcode.fetch({
              barcode: code,
              branchId,
              tier: effectiveTier,
              customerId: customer.customerId ?? undefined,
            });
        if (
          lookupEpoch !== draftResumeEpochRef.current ||
          pricingContext !== barcodePricingContextRef.current
        )
          return;
        if (!row) notify.err(`باركود غير معروف: ${code}`);
        else addRow(row as PosRow);
      } catch (e: unknown) {
        if (
          lookupEpoch === draftResumeEpochRef.current &&
          pricingContext === barcodePricingContextRef.current
        )
          notify.err(e, "خطأ في المسح");
      }
    },
    [branchId, addRow, utils, effectiveTier, offline, customer.customerId],
  );

  const handleWorkOrderScan = useCallback(async (orderNumber: string) => {
    // التسليم والإسناد انتقلا إلى /reception/handover و /reception/workflow
    notify.info(`مسح أمر شغل ${orderNumber} — استخدم شاشة التسليم المباشر`);
  }, []);

  const handleHidScan = useCallback(
    async (raw: string) => {
      if (draftPromotionFlightRef.current || draftTransitionPending) return;
      const r = parseScan(raw);
      if (r.type === "workOrder") {
        await handleWorkOrderScan(r.number);
        setSearch("");
      } else if (r.type === "product") {
        await lookupBarcode(r.barcode);
        setSearch("");
      } else if (r.type === "customer") {
        setCustomer({
          customerId: r.id,
          name: `عميل #${r.id}`,
          phone: null,
          isNew: false,
        });
        notify.ok(`تم تحديد العميل #${r.id}`);
      }
    },
    [lookupBarcode, handleWorkOrderScan, draftTransitionPending],
  );
  const blockingDialogOpen = receptionDialogBlocksInput([
    depositOpen,
    cardsOpen,
    fulfillIntentId,
    closing,
    deliveryDialogOpen,
    customerContextId,
    showInbox,
    showCustomization,
    cashDropping,
    approvalAsk,
  ]);
  useBarcodeScanner(handleHidScan, {
    enabled:
      !blockingDialogOpen &&
      !showReceiptOverlay &&
      !submitting &&
      !draftTransitionPending,
  });
  // مطابقة الماسح داخل حقل البحث المركَّز عبر hook مخصّص (PR #501): توقيتُ الحرف نفسه + تطبيع
  // مسح لوحة المفاتيح العربية (normalizeBarcodeScannerInput) — يحلّ خطأ «الباركود لا يُضاف
  // تلقائياً» بلا الاعتماد على استقرار البحث المؤجَّل، ويصحّح المسح حين تكون اللوحة عربيةً.
  const handleSearchScan = useCallback(
    (code: string) => {
      setSearch("");
      setShowDrop(false);
      const r = parseScan(code);
      if (r.type === "workOrder") {
        void handleWorkOrderScan(r.number);
      } else {
        void lookupBarcode(code);
      }
    },
    [handleWorkOrderScan, lookupBarcode],
  );

  return { blockingDialogOpen, handleSearchScan };
}
