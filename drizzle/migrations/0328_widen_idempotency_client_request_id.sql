-- ═══ توسعة idempotencyKeys.clientRequestId من 64 إلى 120 (بلاغ الإنتاج ٣/٩/٢٦) ═══
--
-- الأعراض: اعتمادُ فاتورة الشراء (ورفضُها) من شاشة الاعتمادات يسقط بـ
-- «قيمة أطول من المسموح في الحقل clientRequestId» — ER_DATA_TOO_LONG.
--
-- الجذر: مفتاحُ القرار تولّده الشاشة بصيغة
--   purchase-decision-PURCHASE_ORDER-<id>-approve-<uuid>   (~٨٠ محرفاً)
-- ويقبله الراوتر (`.max(120)`) والخدمة (`validateKey` ≤ 120) وتقبله أعمدةُ الأبناء
-- (goodsReceipts/supplierInvoices/purchaseCharges = 120)، ثم يسقط عند تسجيل مفتاح الـidempotency
-- في `idempotencyKeys.clientRequestId` وهو **الوحيد** الذي بقي 64. كلُّ الاختبارات مرّت لأنها
-- تستعمل مفاتيح قصيرة («purchase-auto-approve»).
--
-- الفهرس الفريد (operation 40 + clientRequestId 120) × utf8mb4 = 640 بايت < 3072 ⇒ آمن.
-- توسعة varchar داخل نفس فئة بادئة الطول (2 بايت) ⇒ ALTER فوريّ/in-place بلا نسخ الجدول.
-- الهجرة idempotent: تفحص INFORMATION_SCHEMA قبل التعديل فتُعاد بلا ضرر.

SET @needs_widen := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'idempotencyKeys'
    AND column_name = 'clientRequestId'
    AND character_maximum_length < 120
);
SET @sql := IF(@needs_widen = 1,
  'ALTER TABLE `idempotencyKeys` MODIFY COLUMN `clientRequestId` varchar(120) NOT NULL',
  'SELECT ''idempotencyKeys.clientRequestId already >= 120'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
