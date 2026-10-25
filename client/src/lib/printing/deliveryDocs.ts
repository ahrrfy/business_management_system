import type { DeliverySourceReference } from "@shared/deliverySource";
// أوراق تسليم/توصيل مشتركة — مُستخرَجة من DeliveryHub.tsx (مراجعة عدائية ٤/٨): كانت مُصدَّرة من
// ملف صفحة (DeliveryHub.tsx) فيَجرّ استيرادها من ReceptionOrderQueue.tsx حزمة DeliveryHub كاملةً
// (~8ك مضغوطة) لشاشة استقبال عالية التردّد رغم استعمالها دالتين فقط. هنا: مكتبة طباعة صرفة، بلا React.
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { printDoc, type PrintDoc } from "@/lib/printing/print";
import { printShippingLabel } from "@/lib/printing/shippingLabel";
import {
  printDeliveryDispatchSlipAsync,
  type DispatchSlipData,
} from "@/lib/printing/printDeliveryDispatchSlip";
import {
  createDeliveryDocumentSnapshot,
  deliveryDocumentAuditLines,
  type DeliveryDocumentAudit,
} from "@/lib/printing/deliveryDocumentSnapshot";

/**
 * شكلٌ بنيويٌّ أدنى لطباعة الملصق/البوليصة — فقط الحقول التي تقرأها الدالتان أدناه فعلياً.
 * `delivery.readyForDispatch` (DeliveryHub) وصفّ `workOrders.list` (ReceptionOrderQueue) كلاهما
 * يحقّقه بنيوياً بلا تحويل، فتُستعمَل نفس دالتَي الطباعة من الشاشتين دون تكرار منطق.
 */
export interface LabelPrintableOrder {
  orderNumber: string;
  title: string;
  quantity: number;
  salePrice: string;
  deposit: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  /** Slice F (٢٩/٨/٢٦): بلاغ المالك «يعرف الزبون الكلي شاملاً التوصيل» — الملصقُ الذي يرافق
   *  الطرد يجب أن يعرض الإجماليّ الذي سيدفعه الزبون للمندوب: COD + الأجرة (COURIER) أو COD وحده. */
  deliveryCost?: string | null;
  deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  qrUrl?: string | null;
  items?: Array<{
    name?: string;
    productName?: string;
    title?: string;
    quantity?: number | string;
    price?: number | string;
    unitPrice?: number | string;
    total?: number | string;
  }> | null;
}

/** بوليصة توصيل حرارية (جسر/WebUSB/متصفح) عند الإرسال. */
export function printDeliverySlip(
  order: LabelPrintableOrder,
  party: { name: string } | undefined,
  r: DeliverySourceReference & {
    consignmentNumber: string;
    invoiceNumber?: string | null;
    codAmount: string;
    deliveryFee: string;
    feeCollection?: string | null;
    externalTrackingRef?: string | null;
    dispatchedAt?: Date | string | null;
  },
) {
  const orderKind: DispatchSlipData["orderKind"] =
    r.sourceType === "AFTERCARE_EXECUTION"
      ? "aftercare"
      : r.sourceType === "WORK_ORDER"
        ? "workOrder"
        : r.sourceType === "ONLINE_ORDER"
          ? "onlineOrder"
          : r.sourceType === "FULFILLMENT_REQUEST"
            ? "fulfillmentRequest"
            : "invoice";
  void printDeliveryDispatchSlipAsync({
    ...r,
    orderNumber: r.invoiceNumber ?? order.orderNumber,
    orderKind,
    partyName: party?.name ?? "",
    recipientName: order.customerName ?? "",
    recipientPhone: order.customerPhone ?? "",
    deliveryAddress: order.deliveryAddress ?? "",
    salePrice: order.salePrice,
    deposit: order.deposit,
    title: order.title,
    items: order.items,
    feeCollection: (r.feeCollection ?? undefined) as DispatchSlipData["feeCollection"],
    qrUrl: order.qrUrl,
    notes: r.externalTrackingRef
      ? `مرجع شركة التوصيل: ${r.externalTrackingRef}`
      : undefined,
  }).then((result) => {
    if (!result.ok) notify.err("تم الإسناد؛ الطباعة محجوبة، أعد الطباعة");
  }).catch((error) => {
    console.warn("[delivery-slip] فشلت الطباعة بعد نجاح الإسناد:", error);
    notify.err("تم الإسناد؛ تعذرت الطباعة فقط، أعد الطباعة");
  });
}

/**
 * **محضر تسليم دفعة لجهة توصيل** (٢٢/٨) — المستند الذي يوقّعه مستلم الشركة لحظة تسلّم الطرود.
 *
 * لماذا: كشف الشركة يصل بعد أسبوع، وبلا خطّ أساس موقَّع لأيّ خلاف على «كم طرداً استلمناه»
 * تصير المطابقة كلامَ رجال. البيانات كلّها موجودة (listInTransitConsignments يقبل partyId)،
 * فالفجوة عرضٌ فحسب — نجمع الأسطر في مستندٍ واحدٍ برقم كل إرسالية وCOD المتوقّع منها.
 */
export interface DeliveryManifestParcel {
  consignmentNumber: string | null;
  invoiceNumber: string | null;
  orderNumber?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  address?: string | null;
  codAmount?: string | null;
  deliveryFee?: string | null;
}

export interface DeliveryManifestContext extends DeliveryDocumentAudit {
  branchName?: string | null;
  shiftId?: number | string | null;
  cashierName?: string | null;
  manifestNumber?: string | null;
}

export function buildDeliveryManifestDoc(
  party: { name: string; phone?: string | null },
  parcels: readonly DeliveryManifestParcel[],
  context: DeliveryManifestContext = {},
  now = new Date(),
): PrintDoc {
  const totalCod = parcels.reduce((s, p) => s + Number(p.codAmount ?? 0), 0);
  const totalFee = parcels.reduce((s, p) => s + Number(p.deliveryFee ?? 0), 0);
  const snapshot = createDeliveryDocumentSnapshot({
    documentType: "HANDOVER_MANIFEST",
    payload: { party, parcels: [...parcels], ...context },
    audit: context,
    now,
  });
  return {
    kind: "zreport",
    title: "محضر تسليم طرود للتوصيل",
    subtitle: context.manifestNumber
      ? `${context.manifestNumber} · ${party.name} · ${parcels.length} طرداً`
      : `${party.name} · ${parcels.length} طرداً`,
    meta: [
      context.branchName ? `الفرع: ${context.branchName}` : "",
      context.shiftId != null ? `الوردية: ${context.shiftId}` : "",
      context.cashierName ? `الموظف المسلم: ${context.cashierName}` : "",
      party.phone ? `الجهة: ${party.name} — ${party.phone}` : `الجهة: ${party.name}`,
      ...deliveryDocumentAuditLines("وقت التسليم للجهة", snapshot),
    ].filter(Boolean),
    columns: ["الطرد / المصدر / المستلم", "المبالغ"],
    itemBlocks: parcels.map((p) => ({
      name: [
        p.consignmentNumber ?? "إرسالية بلا رقم",
        p.invoiceNumber
          ? `فاتورة ${p.invoiceNumber}`
          : p.orderNumber
            ? `طلب ${p.orderNumber}`
            : null,
        p.recipientName || null,
      ].filter(Boolean).join(" · "),
      quantityPrice: [
        p.recipientPhone ? `هاتف ${p.recipientPhone}` : null,
        p.address ? `عنوان ${p.address}` : null,
      ].filter(Boolean).join(" · ") || "بيانات الاتصال غير متاحة",
      total: `COD ${fmt(p.codAmount ?? "0")} · أجرة ${fmt(p.deliveryFee ?? "0")}`,
    })),
    totals: [
      { label: "مجموع COD المتوقَّع", value: `${fmt(String(totalCod))} د.ع` },
      { label: "مجموع الأجور", value: `${fmt(String(totalFee))} د.ع` },
    ],
    footer:
      "أُقرّ باستلامي الطرود المذكورة أعلاه بعددها ومبالغها للتوصيل والتحصيل.\n"
      + "الاسم: ______________________  التوقيع: ______________________  التاريخ: ______________",
  };
}

export function printDeliveryManifest(
  party: { name: string; phone?: string | null },
  parcels: readonly DeliveryManifestParcel[],
  branchName?: string | null,
  context: Omit<DeliveryManifestContext, "branchName"> = {},
) {
  void printDoc(buildDeliveryManifestDoc(party, parcels, { ...context, branchName })).catch(
    (error) => {
      console.warn("[delivery-manifest] تعذرت الطباعة:", error);
      notify.err("تعذر طباعة المحضر؛ لم تتغير حالة الطرود");
    },
  );
}

/** ملصق شحن للطرد (بالقياس المحفوظ — الافتراضي ٨٠×١٢٠مم): قبل الإرسال برقم الأمر، وبعده
 *  برقم الإرسالية واسم الجهة (نفس ملصق طلبات المتجر — تكامل وظيفي واحد). */
export async function printReadyOrderLabel(
  order: LabelPrintableOrder,
  opts?: {
    partyName?: string | null;
    trackingNumber?: string;
    cod?: string;
    externalTrackingRef?: string | null;
    eventAt?: Date | string | null;
    isReprint?: boolean;
    into?: Window | null;
  },
) {
  const cod = opts?.cod ?? String(Math.max(0, Number(order.salePrice) - Number(order.deposit ?? 0)));
  // Slice F (٢٩/٨/٢٦): «الكلي للعميل» على الملصق — COURIER يقبض COD + الأجرة، الآخران COD وحده.
  // الملصق مصدرُ الحقيقة البصريّ للمندوب عند التسليم؛ رقمٌ مختلفٌ عمّا في يد الزبون = خلاف.
  const feeCollection = order.deliveryFeeCollection ?? "COURIER";
  const feeD = Number(order.deliveryCost ?? 0);
  const totalDue = feeCollection === "COURIER" && feeD > 0
    ? String(Number(cod) + feeD)
    : cod;
  const res = await printShippingLabel(
    {
      orderNumber: opts?.trackingNumber ?? order.orderNumber,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      governorate: null,
      addressText: order.deliveryAddress,
      total: totalDue,
      deliveryPartyName: opts?.partyName ?? null,
      externalTrackingRef: opts?.externalTrackingRef ?? null,
      qrUrl: order.qrUrl ?? null,
      createdAt: opts?.eventAt ?? new Date(),
      printedAt: new Date(),
      isReprint: opts?.isReprint,
      items: [{ productName: order.title, unitName: "", quantity: String(order.quantity ?? 1) }],
    },
    opts && "into" in opts ? { into: opts.into } : undefined,
  );
  if (!res.ok) notify.err("افسح مانع النوافذ المنبثقة لطباعة ملصق الشحن");
}
