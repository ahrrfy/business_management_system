/**
 * SalesReturnPortal — المنفذ الأول: مرتجعات المبيعات (العملاء والتجزئة)
 *
 * يشمل:
 *  - مسح الباركود السريع وسلة المنتجات التفاعلية
 *  - الفاتورة الأصلية (اختيارية) مع زر فحص
 *  - العميل المرتبط بـ CRM (ذكي واختياري)
 *  - المسار المخزني للصنف: رجوع للرف (Restock) أو تالف مسجل خسارة (Damaged)
 *  - طرق الاسترداد المالي: نقدي (درج الكاشير)، بطاقة، أو رصيد متجر
 *  - طباعة حرارية فورية 80مم/58مم
 */
import { useEffect, useState } from "react";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import {
  SalesReturnPortalProps,
  InspectedInvoice,
} from "./salesReturnPortalTypes";
import type { useSalesReturnState } from "./useSalesReturnState";
export function useSalesReturnInvoiceLookup(
  ctx: Pick<
    ReturnType<typeof useSalesReturnState> & SalesReturnPortalProps,
    | "utils"
    | "salesInvoiceNo"
    | "setSalesInvoiceNo"
    | "debouncedInvoiceNo"
    | "setSalesCustomerName"
    | "setSalesCustomerPhone"
    | "setSalesCustomerId"
    | "setSalesCart"
    | "setSalesRefundMethod"
    | "setSalesReason"
    | "setInspectedInvoice"
    | "inspectedInvoice"
    | "initialInvoiceNo"
    | "initialMode"
  >,
) {
  const {
    utils,
    salesInvoiceNo,
    setSalesInvoiceNo,
    debouncedInvoiceNo,
    setSalesCustomerName,
    setSalesCustomerPhone,
    setSalesCustomerId,
    setSalesCart,
    setSalesRefundMethod,
    setSalesReason,
    setInspectedInvoice,
    inspectedInvoice,
    initialInvoiceNo,
    initialMode,
  } = ctx;

  const [invoiceLookupLoading, setInvoiceLookupLoading] = useState(false);

  const handleLookupInvoice = async (targetNo?: string, silent = false) => {
    const raw = (targetNo ?? salesInvoiceNo).trim();
    if (!raw) return;
    setInvoiceLookupLoading(true);

    const applyInspected = (inv: InspectedInvoice) => {
      setInspectedInvoice(inv);
      setSalesCustomerName(inv.customerName ?? "عميل نقدي");
      setSalesCustomerId(inv.customerId ?? null);
      setSalesCustomerPhone(inv.customerPhone ?? "");
      setSalesInvoiceNo(inv.invoiceNumber);
      if (Number(inv.paidAmount || 0) <= 0) {
        setSalesRefundMethod("CREDIT_OFFSET");
      }
      if (
        initialMode === "FULL" &&
        !inv.isOtherBranch &&
        !inv.isDead &&
        !inv.isFullyReturned &&
        Number(inv.remainingInvoiceTotal || 0) > 0
      ) {
        const availableItems = inv.items.filter((i) => i.remainingQuantity > 0);
        if (availableItems.length > 0) {
          setSalesCart(
            availableItems.map((item) => ({
              id: `${item.variantId}-${Date.now()}-${Math.random()}`,
              variantId: item.variantId,
              productUnitId: item.productUnitId,
              invoiceItemId: item.invoiceItemId,
              isBundle: item.isBundle,
              productName: item.productName,
              barcode: item.barcode,
              quantity: item.remainingQuantity,
              maxAllowedQuantity: item.remainingQuantity,
              unitPrice: item.effectiveUnitPrice || item.unitPrice,
              originalUnitPrice: item.effectiveUnitPrice || item.unitPrice,
              unit: item.unitName,
              conversionFactor: item.conversionFactor,
            })),
          );
          setSalesReason((prev) => prev.trim() || "إرجاع كامل الفاتورة");
        }
      }
    };

    try {
      // ١) فحص مباشر عبر إجراء حوكمة المرتجعات inspectInvoiceForReturn
      try {
        const inv = await utils.returns.inspectInvoiceForReturn.fetch({
          invoiceNumber: raw,
        });
        if (inv) {
          applyInspected(inv);
          const isFullyRet =
            inv.isDead ||
            inv.isFullyReturned ||
            Number(inv.remainingInvoiceTotal || 0) <= 0;
          if (inv.isOtherBranch) {
            notify.err(
              `الفاتورة #${inv.invoiceNumber} صادرة من فرع آخر (فرع #${inv.originBranchId}) ولا يمكن إرجاعها من هذا الفرع إلا بصلاحية مدير عام`,
            );
          } else if (isFullyRet) {
            notify.warn(
              `الفاتورة #${inv.invoiceNumber} مغلقة أو ملغاة أو مرجعة بالكامل ولا تقبل مرتجعات`,
            );
          } else {
            notify.ok(
              `تم جلب الفاتورة #${inv.invoiceNumber} (المتبقي: ${fmt(inv.remainingInvoiceTotal)} د.ع${
                Number(inv.paidAmount || 0) <= 0
                  ? " — فاتورة آجلة: تم تحديد معادلة الذمم تلقائياً"
                  : Number(inv.maxRefundable || 0) > 0
                    ? ` — سقف نقدي: ${fmt(inv.maxRefundable)} د.ع`
                    : ""
              })`,
            );
          }
          return;
        }
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (("data" in err &&
            (err as { data?: { code?: string } }).data?.code ===
              "PRECONDITION_FAILED") ||
            ("message" in err &&
              typeof (err as { message?: unknown }).message === "string" &&
              (err as { message: string }).message.includes("أمر الشغل")))
        ) {
          if (!silent) notify.err(err);
          return;
        }
        // المتابعة للبحث البديل
      }

      // ٢) تجربة المسح الكوني الذكي لمعرفة ما إذا كان الرمز باركود فاتورة
      try {
        const scanRes = await utils.returns.universalScan.fetch({
          barcode: raw,
        });
        if (
          scanRes.recognized &&
          scanRes.kind === "INVOICE" &&
          scanRes.number
        ) {
          const inspected = await utils.returns.inspectInvoiceForReturn.fetch({
            invoiceNumber: scanRes.number,
          });
          if (inspected) {
            applyInspected(inspected);
            const isFullyRet =
              inspected.isDead ||
              inspected.isFullyReturned ||
              Number(inspected.remainingInvoiceTotal || 0) <= 0;
            if (inspected.isOtherBranch) {
              notify.err(
                `الفاتورة #${inspected.invoiceNumber} صادرة من فرع آخر (فرع #${inspected.originBranchId}) ولا يمكن إرجاعها من هذا الفرع إلا بصلاحية مدير عام`,
              );
            } else if (isFullyRet) {
              notify.warn(
                `الفاتورة #${inspected.invoiceNumber} مغلقة أو ملغاة أو مرجعة بالكامل ولا تقبل مرتجعات`,
              );
            } else {
              notify.ok(`تم التعرف على الفاتورة #${inspected.invoiceNumber}`);
            }
            return;
          }
        }
      } catch {
        // تجاهل والمتابعة
      }

      // ٣) استخراج الرقم والبحث المباشر
      const invId = parseInt(raw.replace(/\D/g, ""), 10);
      if (invId) {
        try {
          const scanById = await utils.returns.universalScan.fetch({
            barcode: String(invId),
          });
          if (
            scanById.recognized &&
            scanById.kind === "INVOICE" &&
            scanById.number
          ) {
            const inspected = await utils.returns.inspectInvoiceForReturn.fetch(
              {
                invoiceNumber: scanById.number,
              },
            );
            if (inspected) {
              applyInspected(inspected);
              const isFullyRet =
                inspected.isDead ||
                inspected.isFullyReturned ||
                Number(inspected.remainingInvoiceTotal || 0) <= 0;
              if (isFullyRet) {
                notify.warn(
                  `الفاتورة #${inspected.invoiceNumber} مغلقة أو ملغاة أو مرجعة بالكامل ولا تقبل مرتجعات`,
                );
              } else {
                notify.ok(`تم التعرف على الفاتورة #${inspected.invoiceNumber}`);
              }
              return;
            }
          }
        } catch {
          // المتابعة للتقصي الذكي
        }
      }

      // ٤) التحري الذكي (forensic trace) بواسطة رقم الهاتف أو باركود الصنف
      try {
        const trace = await utils.returns.forensicTrace.fetch({
          query: raw,
          mode:
            /^\d+$/.test(raw) && raw.length >= 7
              ? "CUSTOMER_PHONE"
              : "ITEM_BARCODE",
          days: 90,
        });
        if (trace?.results && trace.results.length > 0) {
          const first = trace.results[0];
          const inspected = await utils.returns.inspectInvoiceForReturn.fetch({
            invoiceNumber: first.invoiceNumber,
          });
          if (inspected) {
            applyInspected(inspected);
            const isFullyRet =
              inspected.isDead ||
              inspected.isFullyReturned ||
              Number(inspected.remainingInvoiceTotal || 0) <= 0;
            if (inspected.isOtherBranch) {
              notify.err(
                `الفاتورة #${inspected.invoiceNumber} صادرة من فرع آخر (فرع #${inspected.originBranchId}) ولا يمكن إرجاعها من هذا الفرع إلا بصلاحية مدير عام`,
              );
            } else if (isFullyRet) {
              notify.warn(
                `الفاتورة #${inspected.invoiceNumber} مغلقة أو ملغاة أو مرجعة بالكامل ولا تقبل مرتجعات`,
              );
            } else {
              notify.ok(
                `تم العثور على الفاتورة #${inspected.invoiceNumber} عبر التحري الذكي`,
              );
            }
            return;
          }
        }
      } catch {
        // المتابعة
      }

      if (!silent) {
        setInspectedInvoice(null);
        notify.warn(
          "لم يُعثر على فاتورة بهذا الرقم — يمكنك المتابعة بدون فاتورة كمرتجع عابر",
        );
      }
    } catch {
      if (!silent) {
        setInspectedInvoice(null);
        notify.warn("تعذر جلب الفاتورة — يمكنك المتابعة بدونها");
      }
    } finally {
      setInvoiceLookupLoading(false);
    }
  };

  useEffect(() => {
    if (initialInvoiceNo) {
      setSalesInvoiceNo(initialInvoiceNo);
      void handleLookupInvoice(initialInvoiceNo);
    }
  }, [initialInvoiceNo]);

  useEffect(() => {
    if (!debouncedInvoiceNo) {
      setInspectedInvoice(null);
    } else if (
      debouncedInvoiceNo.length >= 3 &&
      debouncedInvoiceNo !== inspectedInvoice?.invoiceNumber
    ) {
      void handleLookupInvoice(debouncedInvoiceNo, true);
    }
  }, [debouncedInvoiceNo, inspectedInvoice?.invoiceNumber]);
  return { invoiceLookupLoading, setInvoiceLookupLoading, handleLookupInvoice };
}
