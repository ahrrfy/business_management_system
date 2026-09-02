// خدمة الشراء (فواتير الشراء/الترحيل الآلي/تسديد فواتير الدولار) — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ٨٥٥ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/purchase/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (الراوتر وطلبات إعادة الشراء التلقائي والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات:
//   types         — عقد الشراء (PurchaseLineInput/CreatePurchaseOrderInput/SettlePurchaseUsdDirectInput/
//                    ReceiveLineInput/ReceivePurchaseInput).
//   internal      — أدوات مشتركة خاصة (حارس عزل الفرع assertPurchaseBranch) — غير مُصدَّرة من هذا البرميل.
//   order         — createPurchaseInvoice هو مسار التطبيق الذري؛ createPurchaseOrder منخفض المستوى
//                    لمسودات إعادة الطلب والتوافق الداخلي، مع التعديل/الاعتماد/الإلغاء.
//   receive       — نواة ترحيل المخزون وWAVG والدفتر. ليست إجراءً أو شاشة مستقلة.
//   usdSettlement — settlePurchaseUsdDirect: تسديد فاتورة مورد دولارية مباشرةً (بطاقة/تحويل/محفظة).
export type {
  PurchaseLineInput,
  PurchaseDocumentInput,
  CreatePurchaseOrderInput,
  UpdatePurchaseOrderInput,
  SettlePurchaseUsdDirectInput,
  ReceiveLineInput,
  ReceivePurchaseInput,
  PurchaseSettlementType,
} from "./purchase/types";
export { createPurchaseInvoice, createPurchaseOrder, updatePurchaseOrder, confirmPurchaseOrder, cancelPurchaseOrder } from "./purchase/order";
export { assertUniqueReceiveLines, cumulativePurchaseTax, receivePurchase } from "./purchase/receive";
export { settlePurchaseUsdDirect } from "./purchase/usdSettlement";
