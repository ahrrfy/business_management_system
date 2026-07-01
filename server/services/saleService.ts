// خدمة البيع الأساسية (POS/عبر القنوات) — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ٥٥٢ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/sale/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (٢٠ مستورداً عبر الراوترات والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات (محافِظة عمداً — دالّتان ذرّيتان ضخمتان لا تُفكَّكان داخلياً):
//   types    — عقد البيع (SaleLineInput/CreateSaleInput/CreateSaleResult/ProcessPaymentInput).
//   create   — createSale: إنشاء فاتورة بيع ذرّياً بكامل خطواتها.
//   payment  — processPayment: تسجيل دفعة لاحقة على فاتورة آجلة.
export type { SaleLineInput, CreateSaleInput, CreateSaleResult } from "./sale/types";
export { createSale } from "./sale/create";
export type { ProcessPaymentInput } from "./sale/payment";
export { processPayment } from "./sale/payment";
