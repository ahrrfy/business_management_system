-- 0146: توسعة عربون أمر الشغل (٤/٨، توسعة الاستقبال المالية — WALLET) — يسمح باستقبال محفظة
-- رقمية كطريقة دفع لعربون أمر شغل (مطابقةً لـreceipts.paymentMethod الذي يدعمها أصلاً).
-- ⚠️ الاسم الفعلي للعمود = woPaymentMethod (نمط 0142 — لا paymentMethod الخام).
-- ملاحظة هجرة: وُلِّدت يدوياً (لا db:generate) لأنّ لقطات meta/ لهذا الفرع غير مكتملة (فجوة قديمة
-- بين 0052 و0118) فتُنتج db:generate هجرة ضخمة غير مرتبطة — نمط موثَّق مسبقاً (راجع 0106/transfers).
ALTER TABLE `workOrders`
  MODIFY COLUMN `woPaymentMethod` enum('CASH','CARD','TRANSFER','WALLET') DEFAULT 'CASH';
