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

/**
 * **محضر تسليم دفعة لجهة توصيل** (٢٢/٨) — المستند الذي يوقّعه مستلم الشركة لحظة تسلّم الطرود.
 *
 * لماذا: كشف الشركة يصل بعد أسبوع، وبلا خطّ أساس موقَّع لأيّ خلاف على «كم طرداً استلمناه»
 * تصير المطابقة كلامَ رجال. البيانات كلّها موجودة (listInTransitConsignments يقبل partyId)،
 * فالفجوة عرضٌ فحسب — نجمع الأسطر في مستندٍ واحدٍ برقم كل إرسالية وCOD المتوقّع منها.
 */
export function printDeliveryManifest(
  party: { name: string; phone?: string | null },
  parcels: Array<{
    consignmentNumber: string | null;
    invoiceNumber: string | null;
    orderNumber?: string | null;
    recipientName?: string | null;
    recipientPhone?: string | null;
    address?: string | null;
    codAmount?: string | null;
    deliveryFee?: string | null;
  }>,
  branchName?: string | null,
) {
  const totalCod = parcels.reduce((s, p) => s + Number(p.codAmount ?? 0), 0);
  const totalFee = parcels.reduce((s, p) => s + Number(p.deliveryFee ?? 0), 0);
  const now = new Date();
  void printDoc({
    kind: "zreport",
    title: "محضر تسليم طرود للتوصيل",
    subtitle: `${party.name} · ${parcels.length} طرداً`,
    meta: [
      branchName ? `الفرع: ${branchName}` : "",
      `التاريخ: ${now.toLocaleDateString("ar-IQ")}  ${now.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" })}`,
      party.phone ? `الجهة: ${party.name} — ${party.phone}` : `الجهة: ${party.name}`,
    ].filter(Boolean),
    // سطر لكل طرد داخل الجدول (يستخدم totals كصفوف مفتاح/قيمة عريضة كي يبقى ضمن قالب zreport العام).
    totals: [
      ...parcels.map((p) => ({
        label: `${p.consignmentNumber ?? "—"} · ${p.recipientName ?? "—"}${p.address ? " · " + p.address : ""}`,
        value: `${fmt(p.codAmount ?? "0")} د.ع`,
      })),
      { label: "مجموع COD المتوقَّع", value: `${fmt(String(totalCod))} د.ع` },
      { label: "مجموع الأجور", value: `${fmt(String(totalFee))} د.ع` },
    ],
    footer:
      "أُقرّ باستلامي الطرود المذكورة أعلاه بعددها ومبالغها للتوصيل والتحصيل.\n"
      + "الاسم: ______________________  التوقيع: ______________________  التاريخ: ______________",
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
