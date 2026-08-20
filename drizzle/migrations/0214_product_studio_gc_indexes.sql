-- 0214 — فهارس مفاتيح المخزن: شرطُ جدوى كنس المخزن.
--
-- قبل حذف أيّ كائن يسأل الكنس «هل ما زال لهذا المفتاح مرجع؟» فيفحص أربعة أعمدة:
-- `productImageJobs.originalObjectKey/processedObjectKey` و`productImages.objectKey/originalKey`.
-- ولا فهرس على أيٍّ منها ⇒ كلّ سؤالٍ مسحٌ كاملٌ للجدول، وهي تُسأل **تحت قفل صفٍّ**
-- ولكل مرشّحٍ على حدة. مع رفع دفعة المسح إلى ١٠٠ صار ذلك مئتَي مسحٍ كامل في الساعة.
--
-- الفهارس هنا شرطُ تشغيل الكنس فعلياً لا تحسينٌ اختياريّ: بدونها يُحمّل تفعيلُ الحذف
-- القاعدةَ بما يفوق ما يوفّره من تخزين.
--
-- إضافةٌ محروسة فقط: لا مسّ لأيّ صفٍّ ولا لأيّ عمود.
SET NAMES utf8mb4;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImageJobs' AND INDEX_NAME = 'idx_pijob_original_key'),
    'SELECT 1',
    'CREATE INDEX `idx_pijob_original_key` ON `productImageJobs` (`originalObjectKey`)'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImageJobs' AND INDEX_NAME = 'idx_pijob_processed_key'),
    'SELECT 1',
    'CREATE INDEX `idx_pijob_processed_key` ON `productImageJobs` (`processedObjectKey`)'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImages' AND INDEX_NAME = 'idx_pimg_object_key'),
    'SELECT 1',
    'CREATE INDEX `idx_pimg_object_key` ON `productImages` (`objectKey`)'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImages' AND INDEX_NAME = 'idx_pimg_original_key'),
    'SELECT 1',
    'CREATE INDEX `idx_pimg_original_key` ON `productImages` (`originalKey`)'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
