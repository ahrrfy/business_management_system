// خدمة الشراء (أوامر الشراء/الاستلام/تسديد فواتير الدولار) — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ٨٥٥ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/purchase/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (الراوتر وطلبات إعادة الشراء التلقائي والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات:
//   types         — عقد الشراء (PurchaseLineInput/CreatePurchaseOrderInput/SettlePurchaseUsdDirectInput/
//                    ReceiveLineInput/ReceivePurchaseInput).
//   internal      — أدوات مشتركة خاصة (حارس عزل الفرع assertPurchaseBranch) — غير مُصدَّرة من هذا البرميل.
//   order         — createPurchaseOrder + updatePurchaseOrder + cancelPurchaseOrder: دورة حياة أمر
//                    الشراء قبل الاستلام (الحساب مشترك في computePurchaseDocument فلا ينجرف مسارٌ عن آخر).
//   receive       — receivePurchase + assertUniqueReceiveLines + cumulativePurchaseTax: الاستلام
//                    الجزئي/الكامل بتكلفة WAVG المُرسمَلة (landed cost: الشحن/الكمرك) وقيد AP.
//   usdSettlement — settlePurchaseUsdDirect: تسديد فاتورة مورد دولارية مباشرةً (بطاقة/تحويل/محفظة).
export type {
  PurchaseLineInput,
  PurchaseDocumentInput,
  CreatePurchaseOrderInput,
  UpdatePurchaseOrderInput,
  SettlePurchaseUsdDirectInput,
  ReceiveLineInput,
  ReceivePurchaseInput,
} from "./purchase/types";
export { createPurchaseOrder, updatePurchaseOrder, cancelPurchaseOrder } from "./purchase/order";
export { assertUniqueReceiveLines, cumulativePurchaseTax, receivePurchase } from "./purchase/receive";
export { settlePurchaseUsdDirect } from "./purchase/usdSettlement";
