// خدمة الكتالوج (المنتجات/المتغيّرات/الوحدات/الأسعار) — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ١٠١٣ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/catalog/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (catalogRouter/printPosRouter/seed.ts والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات:
//   search         — بحث ذكي مشترك (POS/الشراء/الإدارة) + شروط الرؤية — غير مُصدَّرة (داخلية فقط).
//   pos            — مطابقة الباركود وقائمة البيع (الكاشير).
//   printServices  — خدمات الطباعة (نقطة بيع الخدمات).
//   purchase       — قراءات شاشة الشراء.
//   adminList      — قائمة إدارة المنتجات + تفعيل/تعطيل.
//   productCreate  — إنشاء منتج جديد (تحقّق التفرّد + الإنشاء الذرّي الكامل).
//   productUpdate  — تحديث منتج قائم.
//   productEdit    — قراءة منتج كاملاً لشاشة التعديل.
//   productExtras  — مواد وصفة خدمة الطباعة + صور المنتج.
//   barcode        — إسناد/تحديث باركود وحدة.

export * from "./catalog/pos";
export * from "./catalog/printServices";
export * from "./catalog/purchase";
export * from "./catalog/adminList";
export * from "./catalog/productCreate";
export * from "./catalog/productUpdate";
export * from "./catalog/productEdit";
export * from "./catalog/productExtras";
export * from "./catalog/barcode";
