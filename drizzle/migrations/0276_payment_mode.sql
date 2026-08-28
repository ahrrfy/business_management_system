-- 0276_payment_mode: paymentMode enum على invoices و workOrders (PREPAID/COD/CREDIT)
--
-- الغرض (Slice 3، ٢٨/٨): معالجةُ بلاغ المالك «النظام يمنع إنشاء طلبٍ لعميلٍ لا نعرفه» —
-- كان النظام يعامل كلَّ فاتورة غير مدفوعة كـ«ائتمان»، بينما COD مالٌ حقيقيٌّ متأخّرٌ ساعات
-- (يأتي مع المندوب لا يُترك ديناً على العميل). paymentMode يفصل النمطَين ماليّاً بحيث:
--   • PREPAID — دُفعت لحظة الإنشاء (السلوك السابق الافتراضيّ لأيّ فاتورة مدفوعة كاملاً).
--   • COD     — تُحصَّل عند التسليم (يُتجاوز فحصُ حدّ الائتمان في workOrder.deliver).
--   • CREDIT  — دينٌ فعليّ (يخضع لسقف الائتمان).
--
-- Backfill: كلّ الصفوف القائمة `PREPAID` بحكم التصميم — النظام السابق لم يكن يحمل مفهوم COD
--          صراحةً، وأيّ فاتورةٍ آجلة صارت `paidAmount < total` كانت تعمل بمنطق CREDIT فعلياً؛
--          نُبقيها PREPAID كي لا نُعيد فتح حالاتٍ مالية مغلقة (السلوك الجديد يبدأ من الآن).
-- Idempotent: يستعمل INFORMATION_SCHEMA للتحقّق قبل ALTER (نمط 0179).
--
-- المستهلكون:
--   • server/lib/credit.ts — يقبل optional paymentMode ⇒ يُتجاوز فحص السقف حين COD.
--   • server/services/sale/create.ts — يقبل paymentMode في المدخلات، يمرّره لـassertCreditLimit.
--   • server/services/workOrder/create.ts — يقبل paymentMode، يخزّنه على workOrder.
--   • server/services/workOrder/deliver.ts — يقرأ paymentMode من workOrder، يمرّره لـassertCreditLimit.

-- ══ invoices.paymentMode ═══════════════════════════════════════════════════════════════

SET @db := DATABASE();
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='invoices' AND COLUMN_NAME='paymentMode');
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `invoices` ADD COLUMN `paymentMode` ENUM(''PREPAID'',''COD'',''CREDIT'') NOT NULL DEFAULT ''PREPAID''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ══ workOrders.paymentMode ═════════════════════════════════════════════════════════════

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='workOrders' AND COLUMN_NAME='paymentMode');
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `paymentMode` ENUM(''PREPAID'',''COD'',''CREDIT'') NOT NULL DEFAULT ''PREPAID''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
