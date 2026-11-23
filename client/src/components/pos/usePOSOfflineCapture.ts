import { useCallback } from "react";
import { variantDisplayName } from "@shared/variantDisplay";
import { deliveryBlocksOfflineCapture, OFFLINE_DELIVERY_BLOCK } from "@/components/pos/deliveryMode";
import { checkoutExtraTotal } from "@/components/pos/checkoutExtraAmounts";
import { computePosSaleReceiptSnapshot } from "@/components/pos/posTotals";
import {
  buildPosReceiptPromoSummary,
  buildSaleLine,
  effectivePrice,
  itemTotal,
  money,
  type CartItem,
  type POSTab,
  type Receipt,
  type ShiftData,
  type Tier,
} from "@/components/pos/posShared";
import { newClientRequestId } from "@/lib/countQueue";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { errMsg, notify } from "@/lib/notify";
import {
  allocateOfflineReceiptNumber,
  assertCanCapture,
  enqueueOfflineSale,
  isOfflineSaleEnabled,
  isPreflightIntentCleared,
} from "@/lib/offline/outbox";

export interface POSSaleReceiptContext {
  tabId: number;
  lines: Receipt["lines"];
  subtotal: number;
  invoiceDiscount: number;
  cashRounding: number;
  total: number;
  received: number;
  change: number;
  credit: number;
  isCredit: boolean;
  method: string;
  methodCode?: string;
  paymentLegs?: Receipt["paymentLegs"];
  customerName?: string;
  customerPhone?: string | null;
  cashierName?: string;
  delivery?: Receipt["delivery"];
  cartSnapshot: CartItem[];
  freeShippingPromoName?: string | null;
  couponLabel?: string | null;
  labelMeta?: {
    governorate?: string | null;
    recipientName?: string | null;
    recipientPhone?: string | null;
    externalTrackingRef?: string | null;
  } | null;
}

/** Captures immutable Decimal receipt metadata snapshot at submit time for the active POS tab. */
export function buildPosSaleReceiptContext(params: {
  activeTab: POSTab;
  cart: CartItem[];
  subtotal: number;
  invoiceDiscountAmount: number;
  cashRoundingDelta: number;
  effectiveTotalD: Parameters<typeof computePosSaleReceiptSnapshot>[0]["effectiveTotalD"];
  cashRoundedPaidD: Parameters<typeof computePosSaleReceiptSnapshot>[0]["cashRoundedPaidD"];
  paidD: Parameters<typeof computePosSaleReceiptSnapshot>[0]["paidD"];
  isCredit: boolean;
  codMode: boolean;
  selectedCustomer?: { name?: string; phone?: string | null } | null;
  cashierName?: string;
  deliveryPayload?: {
    fee: NonNullable<Receipt["delivery"]>["fee"];
    feeCollection: NonNullable<Receipt["delivery"]>["feeCollection"];
    address?: string | null;
    governorate?: string | null;
    recipientName?: string | null;
    recipientPhone?: string | null;
    externalTrackingRef?: string | null;
  } | null;
  freeShippingPromoName?: string | null;
}): POSSaleReceiptContext {
  const {
    activeTab,
    cart,
    subtotal,
    invoiceDiscountAmount,
    cashRoundingDelta,
    effectiveTotalD,
    cashRoundedPaidD,
    paidD,
    isCredit,
    codMode,
    selectedCustomer,
    cashierName,
    deliveryPayload,
    freeShippingPromoName,
  } = params;
  const snap = computePosSaleReceiptSnapshot({
    activeTab,
    effectiveTotalD,
    cashRoundedPaidD,
    paidD,
    isCredit,
    codMode,
  });
  return {
    tabId: activeTab.id,
    lines: cart.map((c) => ({
      name: variantDisplayName({
        productName: c.row.productName,
        variantName: c.row.variantName,
        color: c.row.color,
        size: c.row.size,
        sku: c.row.sku,
      }),
      unit: c.row.unitName,
      qty: c.qty,
      price: effectivePrice(c),
      disc: c.disc,
      total: itemTotal(c),
    })),
    subtotal,
    invoiceDiscount: invoiceDiscountAmount,
    cashRounding: cashRoundingDelta,
    total: snap.total,
    received: snap.received,
    change: snap.change,
    credit: snap.credit,
    isCredit: !codMode && isCredit,
    method: snap.method,
    methodCode: snap.effectiveMethodCode,
    paymentLegs: snap.paymentLegs,
    customerName: selectedCustomer?.name,
    customerPhone: activeTab.delivery?.customerPhone || selectedCustomer?.phone || null,
    cashierName,
    delivery:
      activeTab.delivery && deliveryPayload
        ? {
            partyName: activeTab.delivery.partyName,
            fee: deliveryPayload.fee,
            feeCollection: deliveryPayload.feeCollection,
            address: deliveryPayload.address ?? null,
          }
        : null,
    cartSnapshot: cart,
    freeShippingPromoName,
    couponLabel: activeTab.couponLabel,
    labelMeta: deliveryPayload
      ? {
          governorate: deliveryPayload.governorate ?? null,
          recipientName: deliveryPayload.recipientName ?? null,
          recipientPhone: deliveryPayload.recipientPhone ?? null,
          externalTrackingRef: deliveryPayload.externalTrackingRef ?? null,
        }
      : null,
  };
}

/** Restores the frozen original sale receipt context for same-key automatic preflight replay. */
export function restorePosReceiptContextFromPreflightIntent(
  intent: {
    tabId: number;
    total: string;
    saleInput?: Record<string, unknown>;
    receiptContext?: Record<string, unknown> | null;
  },
  fallbackCashierName?: string,
): POSSaleReceiptContext {
  const saved = intent.receiptContext as Partial<POSSaleReceiptContext> | null | undefined;
  if (saved && typeof saved.tabId === "number" && Array.isArray(saved.lines)) {
    return {
      tabId: saved.tabId,
      lines: saved.lines,
      subtotal: Number(saved.subtotal ?? intent.total ?? 0),
      invoiceDiscount: Number(saved.invoiceDiscount ?? 0),
      cashRounding: Number(saved.cashRounding ?? 0),
      total: Number(saved.total ?? intent.total ?? 0),
      received: Number(saved.received ?? intent.total ?? 0),
      change: Number(saved.change ?? 0),
      credit: Number(saved.credit ?? 0),
      isCredit: Boolean(saved.isCredit),
      method: typeof saved.method === "string" ? saved.method : "نقدي",
      methodCode: saved.methodCode,
      paymentLegs: saved.paymentLegs,
      customerName: saved.customerName,
      customerPhone: saved.customerPhone ?? null,
      cashierName: saved.cashierName ?? fallbackCashierName,
      delivery: saved.delivery ?? null,
      cartSnapshot: Array.isArray(saved.cartSnapshot) ? saved.cartSnapshot : [],
      freeShippingPromoName: saved.freeShippingPromoName ?? null,
      couponLabel: saved.couponLabel ?? null,
      labelMeta: saved.labelMeta ?? null,
    };
  }
  const rawPayment = intent.saleInput?.payment as { amount?: string; method?: string } | undefined;
  const totalNum = Number(intent.total || 0);
  const receivedNum = rawPayment?.amount != null ? Number(rawPayment.amount) : totalNum;
  return {
    tabId: intent.tabId,
    lines: [],
    subtotal: totalNum,
    invoiceDiscount: Number(intent.saleInput?.invoiceDiscount ?? 0),
    cashRounding: 0,
    total: totalNum,
    received: receivedNum,
    change: Math.max(0, receivedNum - totalNum),
    credit: Math.max(0, totalNum - receivedNum),
    isCredit: receivedNum < totalNum,
    method: String(rawPayment?.method ?? "CASH"),
    methodCode: typeof rawPayment?.method === "string" ? rawPayment.method : "CASH",
    cashierName: fallbackCashierName,
    delivery: null,
    cartSnapshot: [],
  };
}

interface UsePOSOfflineCaptureOptions {
  activeTab: POSTab;
  branchId: number;
  shift: ShiftData | undefined;
  cart: CartItem[];
  isCredit: boolean;
  effectiveTier: Tier;
  cashRoundedTotal: number;
  invoiceDiscountAmountD: { gt: (n: number) => boolean; toFixed: (d: number) => string };
  capturedByUserId: number | null;
  enforceOfflinePermPolicy: boolean;
  captureSaleCtx: () => POSSaleReceiptContext;
  setSaleError: (msg: string | null) => void;
  setReceipt: (rec: Receipt | null) => void;
  setLastInv: (v: { num: string; total: number } | null) => void;
  patchTab: (tabId: number, patch: Partial<POSTab>) => void;
  releaseReservedPrintWindow: () => void;
  printAuthorizedReceipt: (rec: Receipt, interactive?: boolean) => Promise<{ ok: boolean; via?: string }>;
}

/** Captures cash-full POS sales locally when offline or on 5xx timeout drop. */
export function usePOSOfflineCapture(options: UsePOSOfflineCaptureOptions) {
  const {
    activeTab,
    branchId,
    shift,
    cart,
    isCredit,
    effectiveTier,
    cashRoundedTotal,
    invoiceDiscountAmountD,
    capturedByUserId,
    enforceOfflinePermPolicy,
    captureSaleCtx,
    setSaleError,
    setReceipt,
    setLastInv,
    patchTab,
    releaseReservedPrintWindow,
    printAuthorizedReceipt,
  } = options;

  return useCallback(async (): Promise<boolean> => {
    let readyToPrint = false;
    try {
      if (checkoutExtraTotal(activeTab.extraCharges).gt(0)) {
        notify.err("قبض الأجور يتطلب اتصالاً بالخادم؛ احتُفظ بالمسودة وإثبات الدفع لإعادة المحاولة بنفس المرجع");
        return false;
      }
      if (!shift || !cart.length) return false;
      if (deliveryBlocksOfflineCapture(activeTab.delivery)) {
        notify.errBig(OFFLINE_DELIVERY_BLOCK.title, OFFLINE_DELIVERY_BLOCK.body);
        return false;
      }
      if (cart.some((c) => c.digital)) {
        notify.errBig("لا بيع رقميّ دون اتصال", "الكروت والاشتراكات تحتاج الخادم للتحقّق من السعر والتنفيذ. أزِلها من السلة.");
        return false;
      }
      if (!(await isOfflineSaleEnabled())) {
        notify.errBig(
          "البيع دون اتصال مُعطَّل على هذا الجهاز",
          "عُطِّل يدوياً من «إعدادات الجهاز» في شارة المزامنة أسفل الشاشة — أعِد تفعيله ليقبل النقد أثناء الانقطاع.",
        );
        return false;
      }
      if (activeTab.method !== "CASH" || isCredit) {
        notify.errBig("أثناء انقطاع الاتصال: البيع النقدي الكامل فقط — الآجل والبطاقة يتطلبان اتصالاً بالخادم.");
        return false;
      }
      if (activeTab.couponCode) {
        notify.errBig("الكوبونات غير متاحة دون اتصال — أزل الكوبون أولاً.");
        return false;
      }
      const gate = await assertCanCapture(cashRoundedTotal, "SALE", {
        branchId,
        shiftId: shift.id,
        capturedByUserId,
        enforceOfflinePermPolicy,
      });
      if (!gate.ok) {
        notify.errBig(gate.reason);
        setSaleError(gate.reason);
        return false;
      }
      const ctx = captureSaleCtx();
      const staleOrClearedKey = await isPreflightIntentCleared(activeTab.clientRequestId);
      const captureClientRequestId = staleOrClearedKey
        ? newClientRequestId()
        : activeTab.clientRequestId;
      if (staleOrClearedKey) {
        patchTab(activeTab.id, { clientRequestId: captureClientRequestId });
      }
      const receiptNumber = await allocateOfflineReceiptNumber(branchId);
      const ok = await enqueueOfflineSale({
        payload: {
          branchId,
          shiftId: shift.id,
          customerId: activeTab.customerId ?? undefined,
          priceTier: effectiveTier,
          lines: cart.map(buildSaleLine),
          ...(invoiceDiscountAmountD.gt(0) ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) } : {}),
          payment: { amount: money(cashRoundedTotal), method: "CASH" },
          clientRequestId: captureClientRequestId,
          cashRoundIQD: true,
          ...(activeTab.salesRepId
            ? {
                salesRepId: activeTab.salesRepId,
                attribution: { repId: activeTab.salesRepId, mode: "DIRECT" as const },
              }
            : {}),
        },
        offlineReceiptNumber: receiptNumber,
        total: money(cashRoundedTotal),
      });
      if (!ok) {
        notify.errBig("تعذّر حفظ البيع محلياً (مساحة المتصفح؟) — لا تُسلّم البضاعة قبل عودة الاتصال.");
        return false;
      }
      const now = new Date();
      const rec: Receipt = {
        invoiceNumber: receiptNumber,
        invoiceId: 0,
        date: fmtDateTime(now),
        printDate: fmtDate(now),
        printTime: fmtTime(now),
        cashierName: ctx.cashierName,
        customerName: ctx.customerName,
        shiftId: shift?.id ?? null,
        lines: ctx.lines,
        subtotal: ctx.subtotal,
        invoiceDiscount: ctx.invoiceDiscount,
        total: ctx.total,
        received: ctx.received,
        change: ctx.change,
        credit: ctx.credit,
        isCredit: ctx.isCredit,
        method: ctx.method,
        methodCode: ctx.methodCode,
        promoSummary: buildPosReceiptPromoSummary({ cart: ctx.cartSnapshot, invoiceDiscount: ctx.invoiceDiscount }),
      };
      setReceipt(rec);
      setLastInv({ num: receiptNumber, total: ctx.total });
      notify.ok(
        `بيع دون اتصال — إيصال مؤقّت ${receiptNumber}`,
        "محفوظ على هذا الجهاز وبانتظار المزامنة — الرقم الرسمي يصدر تلقائياً عند عودة الاتصال",
      );
      patchTab(ctx.tabId, {
        extraCharges: undefined,
        cart: [],
        payInput: "",
        selId: null,
        couponInput: "",
        couponCode: null,
        clientRequestId: newClientRequestId(),
        paymentRef: "",
        externalPayment: null,
        dueDate: "",
        invoiceDiscountPct: "",
        delivery: null,
      });
      readyToPrint = true;
      try {
        const printed = await printAuthorizedReceipt(rec);
        if (!printed.ok) {
          notify.err("تعذّرت طباعة الإيصال المؤقت", "حجب المتصفح نافذة الطباعة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
        } else if (printed.via === "browser") {
          notify.warn("الطابعة المباشرة غير متاحة", "افتُتحت نافذة الطباعة للإيصال المؤقت");
        }
      } catch (cause) {
        notify.warn("البيع المؤقت محفوظ؛ تعذّرت طباعة الإيصال", errMsg(cause));
      }
      return true;
    } catch (cause) {
      notify.errBig(errMsg(cause));
      return false;
    } finally {
      if (!readyToPrint) releaseReservedPrintWindow();
    }
  }, [
    activeTab,
    branchId,
    shift,
    cart,
    isCredit,
    effectiveTier,
    cashRoundedTotal,
    invoiceDiscountAmountD,
    capturedByUserId,
    enforceOfflinePermPolicy,
    captureSaleCtx,
    setSaleError,
    setReceipt,
    setLastInv,
    patchTab,
    releaseReservedPrintWindow,
    printAuthorizedReceipt,
  ]);
}
