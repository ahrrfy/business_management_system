import type { RouterOutputs } from "@/lib/trpc";
import type { OrderDeliveryValue } from "@/components/reception/ReceptionTypes";
import {
  allocateOfflineReceiptNumber,
  assertCanCapture,
  enqueueOfflineItem,
  isOfflineSaleEnabled,
  type OfflineReceptionPayload,
} from "@/lib/offline/outbox";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/date";
import {
  effectivePrice,
  isCustomKind,
  lineTotal,
  PAY_METHOD_LABEL,
  type CartLine,
  type PayMethod,
  type Tier,
} from "@/components/reception/cartMath";
import { type ReceiptBrowserData } from "@/lib/printing/print";

export interface ReceptionOfflineCaptureInput {
  canActionRef: React.RefObject<(path: string) => boolean>;
  shift: RouterOutputs["shifts"]["current"];
  cart: import("@/components/reception/cartMath").CartLine[];
  me: { data: RouterOutputs["auth"]["me"] | undefined };
  activeDraftRef: React.RefObject<{ id: number; version: number } | null>;
  method: import("@/components/reception/cartMath").PayMethod;
  couponCode: string | null;
  heldDelivery: number;
  orderDelivery:
    | import("@/components/reception/ReceptionTypes").OrderDeliveryValue
    | null;
  payInput: string;
  grandTotalD: import("decimal.js").Decimal;
  branchId: number;
  customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer;
  effectiveTier: import("@/components/reception/cartMath").Tier;
  invoiceDiscountAmountD: import("decimal.js").Decimal;
  reqIdRef: React.RefObject<string>;
  printAuthorizedReceiptData: (
    rec: import("@/lib/printing/printTemplates").ReceiptBrowserData,
    reprint?: boolean,
  ) => Promise<
    | { via: "browser" | "server" | "thermal"; ok: true }
    | { via: "browser"; ok: false; reason: "popup-blocked" }
    | { ok: false; via: "browser" }
  >;
  sumDirectD: import("decimal.js").Decimal;
  sumCustomD: import("decimal.js").Decimal;
  resetAfterCommittedWorkspace: () => boolean;
}
export async function ReceptionOfflineCapture(
  {
    canActionRef,
    shift,
    cart,
    me,
    activeDraftRef,
    method,
    couponCode,
    heldDelivery,
    orderDelivery,
    payInput,
    grandTotalD,
    branchId,
    customer,
    effectiveTier,
    invoiceDiscountAmountD,
    reqIdRef,
    printAuthorizedReceiptData,
    sumDirectD,
    sumCustomD,
    resetAfterCommittedWorkspace,
  }: ReceptionOfflineCaptureInput,
  hadActiveDraft = false,
): Promise<boolean> {
  if (!canActionRef.current("offline.replayReception")) {
    notify.err("التقاط طلب استقبال دون اتصال غير مفوض لحسابك");
    return false;
  }
  if (!shift || cart.length === 0) return false;
  if (cart.some((line) => line.digital)) {
    notify.errBig(
      "الكروت الرقمية تحتاج اتصالاً",
      "لا يمكن إصدار الكرت أو حجز رصيد المزوّد دون اتصال. أعد الاتصال ثم أتمم العملية من السلة نفسها.",
    );
    return false;
  }
  const capturedByUserId = me.data?.id;
  if (!Number.isInteger(capturedByUserId) || Number(capturedByUserId) <= 0) {
    notify.errBig(
      "تعذّر تثبيت هوية الموظف — أعد تسجيل الدخول قبل قبض نقد دون اتصال",
    );
    return false;
  }
  // مراجعة عدائية (٥/٨) — **حاصرة**: طلبٌ محفوظ (مسوّدة) لا يُلتقَط أوفلاينياً أبداً.
  // التثبيت يلتزم خادمياً بمفتاح المسوّدة (commitRequestId) بينما الالتقاط كان سيرحّل
  // بمفتاح الواجهة (reqIdRef) المختلف ⇒ uq_invoice_source عاجزٌ عن صدّ فاتورةٍ ثانية
  // إذا كان الالتزام وصل قبل انقطاع الردّ. المسوّدة الخادمية **هي** الأثر الناجي.
  if (hadActiveDraft || activeDraftRef.current) {
    notify.errBig(
      "طلبك محفوظٌ على الخادم — لا يُلتقَط دون اتصال",
      "عند عودة الاتصال افتح الطلب من «طلبات محفوظة» واضغط التثبيت — لن يتكرّر ولن يضيع.",
    );
    return false;
  }
  const directLines = cart.filter((c) => !isCustomKind(c));
  const regularLines = directLines.filter(
    (c) => !c.digital && !c.row.isPrintService,
  );
  const printLines = directLines.filter(
    (c) => !c.digital && c.row.isPrintService,
  );
  const customItems = cart.filter(isCustomKind);
  if (customItems.length > 0) {
    notify.errBig(
      "أوامر الشغل تحتاج اتصالاً",
      "ترقيم أمر الشغل وإسناده ورفع صوره تتمّ على الخادم. أزل بنود التخصيص من السلّة لإتمام البيع نقداً الآن، أو انتظر عودة الاتصال.",
    );
    return false;
  }
  if (!(await isOfflineSaleEnabled())) {
    notify.errBig(
      "البيع دون اتصال مُعطَّل على هذا الجهاز",
      "عُطِّل يدوياً من «إعدادات الجهاز» في شارة المزامنة أسفل الشاشة — الافتراضي مفعَّل، فأعِد تفعيله ليقبل النقد أثناء الانقطاع.",
    );
    return false;
  }
  if (method !== "CASH") {
    notify.errBig(
      "أثناء انقطاع الاتصال: النقد فقط — البطاقة والتحويل يتطلبان الخادم للتحقّق من المرجع.",
    );
    return false;
  }
  if (couponCode) {
    notify.errBig("الكوبونات غير متاحة دون اتصال — أزل الكوبون أولاً.");
    return false;
  }
  if (heldDelivery > 0) {
    notify.errBig(
      "أجرة التوصيل أمانةً تحتاج اتصالاً",
      "إسناد المندوب وصرف الأجرة عمليّتان خادميّتان — أتمّ الطلب بلا توصيل الآن.",
    );
    return false;
  }
  // مراجعة PR #495: بعد أن صار الإسناد **داخل** معاملة التثبيت، التقاطٌ أوفلاينيّ لطلبٍ مُسنَدٍ
  // لمندوب كان سيُرحّل فاتورةً بلا إرسالية — إسنادٌ يسقط صامتاً (والحارس القديم يمسك أجرة
  // COUNTER وحدها). الرفض صريحٌ الآن: الترقيم والعهدة والأقفال كلّها خادميّة.
  if (orderDelivery) {
    notify.errBig(
      "إسناد التوصيل يحتاج اتصالاً",
      "ترقيم الإرسالية وعهدة المندوب يُكتبان مع الفاتورة في معاملةٍ واحدة على الخادم — أزل التوصيل لإتمام البيع نقداً الآن، أو انتظر عودة الاتصال.",
    );
    return false;
  }
  // الدفع الكامل شرطٌ: الأوفلاين لا يُقيّم ذمّة عميل ولا سقف ائتمانه من نسخةٍ محليّة.
  const paidNowD = round2(D(payInput || 0));
  const fullyPaid = paidNowD.gte(grandTotalD);
  if (!fullyPaid) {
    notify.errBig(
      "دون اتصال: الدفع الكامل فقط",
      `المطلوب ${fmt(grandTotalD.toFixed(2))} د.ع — الآجل والعربون الجزئيّ يتطلبان اتصالاً.`,
    );
    return false;
  }
  const gate = await assertCanCapture(grandTotalD.toNumber());
  if (!gate.ok) {
    notify.errBig(gate.reason);
    return false;
  }

  const receiptNumber = await allocateOfflineReceiptNumber(branchId);
  const payload: OfflineReceptionPayload = {
    branchId,
    shiftId: shift.id,
    ...(customer.customerId ? { customerId: customer.customerId } : {}),
    ...(customer.name.trim() ? { contactName: customer.name.trim() } : {}),
    ...(customer.phone?.trim() ? { contactPhone: customer.phone.trim() } : {}),
    priceTier: effectiveTier,
    paymentMethod: "CASH",
    paidAmount: round2(grandTotalD).toFixed(2),
    regularSale:
      regularLines.length > 0
        ? {
            // السعر الملتقَط إلزاميّ: النقد قُبض بالسعر المطبوع — لا إعادة تسعيرٍ صامتة عند الترحيل.
            lines: regularLines.map((c) => ({
              variantId: c.row.variantId,
              productUnitId: c.row.productUnitId,
              quantity: String(c.qty),
              unitPriceOverride: round2(D(effectivePrice(c))).toFixed(2),
            })),
            // ٢٣/٨ — الصافي = الأسطر الخام − خصمُ رأس الفاتورة الملتقَط. الخادم يعيد الحساب بنفس المدخلات
            // عند الترحيل (replayOfflineReception → checkoutReception → createSaleInTx) فينتج نفس الرقم.
            amount: round2(
              regularLines
                .reduce((sum, c) => sum.plus(D(lineTotal(c))), D(0))
                .minus(invoiceDiscountAmountD),
            ).toFixed(2),
            ...(invoiceDiscountAmountD.gt(0)
              ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) }
              : {}),
          }
        : null,
    printSale:
      printLines.length > 0
        ? {
            lines: printLines.map((c) => ({
              variantId: c.row.variantId,
              productUnitId: c.row.productUnitId,
              quantity: String(c.qty),
              unitPriceOverride: round2(D(effectivePrice(c))).toFixed(2),
            })),
            amount: round2(
              printLines.reduce((sum, c) => sum.plus(D(lineTotal(c))), D(0)),
            ).toFixed(2),
          }
        : null,
    clientRequestId: reqIdRef.current,
  };
  const stored = await enqueueOfflineItem({
    kind: "RECEPTION",
    payload,
    offlineReceiptNumber: receiptNumber,
    total: round2(grandTotalD).toFixed(2),
    capturedByUserId: Number(capturedByUserId),
  });
  if (!stored) {
    notify.errBig(
      "تعذّر حفظ العملية محلياً (مساحة المتصفح؟) — لا تُسلّم البضاعة قبل عودة الاتصال.",
    );
    return false;
  }

  // إيصالٌ مؤقّت بنفس تصميم الإيصال الرسميّ — الزبون يخرج بورقةٍ قابلة للبحث برقمها.
  const now = new Date();
  const cashierName = me.data?.name ?? "موظف الخدمة";
  const contact = customer.name.trim() || (customer.phone?.trim() ?? "");
  void printAuthorizedReceiptData({
    receiptNumber,
    date: fmtDate(now),
    time: fmtTime(now),
    cashierName,
    customerName: contact || null,
    items: [...regularLines, ...printLines].map((c) => ({
      name: `${c.row.productName} (${c.row.unitName})${c.disc ? ` −${c.disc}%` : ""}`,
      quantity: c.qty,
      price: round2(D(effectivePrice(c))).toFixed(2),
      total: round2(D(lineTotal(c))).toFixed(2),
    })),
    // ٢٣/٨ — Codex P1: subtotal يعرض الخام (`sumDirect + sumCustom`) وdiscount يعلن الخصم
    // صراحةً على الإيصال المؤقّت — لولا هذا يظهر إجماليٌّ أقلّ من مجموع الأسطر بلا سبب.
    subtotal: round2(sumDirectD.plus(sumCustomD)).toFixed(2),
    discount: invoiceDiscountAmountD.gt(0)
      ? invoiceDiscountAmountD.toFixed(2)
      : null,
    total: round2(grandTotalD).toFixed(2),
    paid: round2(paidNowD).toFixed(2),
    change: paidNowD.gt(grandTotalD)
      ? round2(paidNowD.minus(grandTotalD)).toFixed(2)
      : null,
    paymentMethod: PAY_METHOD_LABEL.CASH,
  })
    .then((printed) => {
      if (!printed.ok)
        notify.err(
          "تعذّرت طباعة الإيصال المؤقت",
          "حجب المتصفح نافذة الطباعة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة",
        );
    })
    .catch(() => {
      /* فشل الطابعة لا يُلغي التقاطاً التزم محلياً */
    });

  notify.ok(
    `بيع دون اتصال — إيصال مؤقّت ${receiptNumber}`,
    "الرقم الرسميّ يصدر تلقائياً عند عودة الاتصال (شارة المزامنة أسفل الشاشة)",
  );
  resetAfterCommittedWorkspace();
  return true;
}
