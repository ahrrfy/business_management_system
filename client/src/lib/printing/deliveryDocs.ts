// أوراق تسليم/توصيل مشتركة — مُستخرَجة من DeliveryHub.tsx (مراجعة عدائية ٤/٨): كانت مُصدَّرة من
// ملف صفحة (DeliveryHub.tsx) فيَجرّ استيرادها من ReceptionOrderQueue.tsx حزمة DeliveryHub كاملةً
// (~8ك مضغوطة) لشاشة استقبال عالية التردّد رغم استعمالها دالتين فقط. هنا: مكتبة طباعة صرفة، بلا React.
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { printDoc } from "@/lib/printing/print";
import { printShippingLabel } from "@/lib/printing/shippingLabel";

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
}

/** بوليصة توصيل حرارية (جسر/WebUSB/متصفح) عند الإرسال. */
export function printDeliverySlip(
  order: LabelPrintableOrder,
  party: { name: string } | undefined,
  r: { consignmentNumber: string; invoiceNumber: string; codAmount: string; deliveryFee: string },
) {
  void printDoc({
    kind: "receipt",
    title: "بوليصة توصيل",
    subtitle: r.consignmentNumber,
    meta: [
      `الطلب: ${order.orderNumber}`,
      `الجهة: ${party?.name ?? ""}`,
      `المستلم: ${order.customerName ?? "—"}`,
      order.deliveryAddress ? `العنوان: ${order.deliveryAddress}` : "",
      `الفاتورة: ${r.invoiceNumber}`,
    ].filter(Boolean),
    totals: [
      { label: "مبلغ التحصيل (COD)", value: `${fmt(r.codAmount)} د.ع` },
      { label: "أجرة التوصيل", value: `${fmt(r.deliveryFee)} د.ع` },
    ],
    footer: "يُسلَّم المبلغ للمكتبة عند التوريد",
    barcodeSet: { barcode128: r.consignmentNumber, qrPayload: r.consignmentNumber, displayLabel: r.consignmentNumber },
  });
}

/** ملصق شحن للطرد (بالقياس المحفوظ — الافتراضي ٨٠×١٢٠مم): قبل الإرسال برقم الأمر، وبعده
 *  برقم الإرسالية واسم الجهة (نفس ملصق طلبات المتجر — تكامل وظيفي واحد). */
export async function printReadyOrderLabel(
  order: LabelPrintableOrder,
  opts?: { partyName?: string | null; trackingNumber?: string; cod?: string; into?: Window | null },
) {
  const cod = opts?.cod ?? String(Math.max(0, Number(order.salePrice) - Number(order.deposit ?? 0)));
  const res = await printShippingLabel(
    {
      orderNumber: opts?.trackingNumber ?? order.orderNumber,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      governorate: null,
      addressText: order.deliveryAddress,
      total: cod,
      deliveryPartyName: opts?.partyName ?? null,
      createdAt: new Date(),
      items: [{ productName: order.title, unitName: "", quantity: String(order.quantity ?? 1) }],
    },
    opts && "into" in opts ? { into: opts.into } : undefined,
  );
  if (!res.ok) notify.err("افسح مانع النوافذ المنبثقة لطباعة ملصق الشحن");
}
