-- 0264_adjustment_reason_and_attachment: reason enum + attachmentUrl on stockAdjustmentRequests
--
-- الغرض (P2-#3، تقرير المراجعة ٢٥/٨): «الحركة اليدويّة» في المنظومة تعيش على
-- `stockAdjustmentRequests` (المسار الوحيد المفتوح؛ `createManualMovement` مغلقٌ بنيوياً).
-- كان الطلب يحمل `notes` نصّية فقط ⇒ لا سببٌ مُهيكَل ولا إثبات صورةٍ للتالف/الفقد/السرقة.
-- التحقيقُ التشغيليّ يعتمد على النصّ وحده، والمُعتمِد يوقّع على الثقة لا على دليل.
--
-- الحلّ:
-- 1) `adjustmentReason` (mysqlEnum) — يوثّق السبب بمفرداتٍ محدَّدة (STOCK_TAKE/DAMAGE/LOSS/THEFT/…).
--    NULL مسموحٌ للتوافق مع الصفوف القائمة قبل هذه الهجرة (تُعامَل «غير محدَّد»). العقدُ الجديد على
--    الراوتر يُلزمه لكلّ طلبٍ جديد.
-- 2) `attachmentUrl` (mediumtext) — data URL لصورةٍ مضغوطة (نظير `receipts.attachmentUrl`).
--    الأسبابُ الحسّاسة (DAMAGE/LOSS/THEFT) تُلزمه على مستوى الخدمة؛ اختياريٌّ لغيرها.
--
-- ⚠️ **لا FK** هنا؛ لا حاجة statement-breakpoint خاصّ بين ALTER وUPDATE (كلاهما DDL/DML مستقل).
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+). قد تُعاد عبر ci-apply-extra-migrations
-- أو migration-dry-run.

SET @reason_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'stockAdjustmentRequests'
    AND COLUMN_NAME = 'reason'
);

SET @reason_ddl := IF(
  @reason_exists = 0,
  'ALTER TABLE `stockAdjustmentRequests` ADD COLUMN `reason` ENUM(''STOCK_TAKE'',''DAMAGE'',''LOSS'',''THEFT'',''SAMPLE'',''INTERNAL_USE'',''GIFT'',''CORRECTION'',''OTHER'') NULL AFTER `notes`',
  'SELECT 1'
);

PREPARE stmt FROM @reason_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @att_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'stockAdjustmentRequests'
    AND COLUMN_NAME = 'attachmentUrl'
);

SET @att_ddl := IF(
  @att_exists = 0,
  'ALTER TABLE `stockAdjustmentRequests` ADD COLUMN `attachmentUrl` MEDIUMTEXT NULL AFTER `reason`',
  'SELECT 1'
);

PREPARE stmt FROM @att_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
