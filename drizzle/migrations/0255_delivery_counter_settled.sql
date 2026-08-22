-- **سداد الكاونتر بعد ثبوت التسليم** (حملة حياة الطلب ٢٢/٨ — فكّ فخّ التحصيل الجزئيّ).
--
-- كشفُ الشركة يجيز تحصيلاً جزئياً («حُصِّل ١٢٬٠٠٠ من ٢٠٬٠٠٠») والمتبقّي يبقى ذمّةً حيّةً
-- على العميل. لكنّ حارس الكاونتر كان يحجب أيّ قبضٍ على الفاتورة ما دامت الإرسالية
-- DISPATCHED/PARTIAL — فالزبون الذي جاء للمحل ليسدّد الباقي يُرفَض نقدُه إلى الأبد،
-- والمخرجُ الوحيد شطبٌ يزوّر خسارةً عن دَينٍ حيّ.
--
-- الفكّ: بعد `parcelStatus = DELIVERED` لم يعد الطردُ بيد المندوب، فالقبض الكاونتريّ مشروع.
-- هذا العمود يسجّل ما سُدّد بالكاونتر كي:
--   · يُنقَص المتبقّي المتوقَّع من الجهة (لا يُورَّد لاحقاً مبلغٌ سدّده الزبون بالمحل)،
--   · **بلا** رفع عهدة الجهة (النقد لم يمرّ بيدها — يدخل الدرج بإيصاله المعتاد).
-- المتبقّي الحيّ = codAmount − collectedAmount − counterSettledAmount.
--
-- idempotent محروسٌ بـinformation_schema.

SET NAMES utf8mb4;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments'
    AND COLUMN_NAME = 'counterSettledAmount'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `counterSettledAmount` decimal(15,2) NOT NULL DEFAULT ''0.00''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
