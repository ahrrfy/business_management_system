-- price-wave revert (٢٠/٨/٢٦): «التراجع عن موجة تسعير».
--
-- الجذر: شاشة موجات الأسعار كانت تقول للمدير «لا تراجع تلقائي — أنشئ موجة عكسية لاحقاً»، وهي
-- نصيحةٌ **غير صحيحة رياضياً**: عكسُ رفعٍ ‎10٪ ليس تخفيضاً ‎10٪ (‎100 → ‎110 → ‎99). والاستعادة
-- الصحيحة الوحيدة هي القيمة المحفوظة نفسها — وهي موجودة كاملةً منذ ٧/٧ في `priceChangeLog.oldPrice`
-- لكل صفٍّ مربوطٍ بـ`waveId`. أي أنّ التراجع كان **مبنياً في البيانات وغير مُتاحٍ في المنتَج**.
--
-- ما تضيفه هذه الهجرة ثلاثة أشياء فقط:
--   ١) قيمة `REVERT` في enum نوع التغيير — موجةُ التراجع حدثٌ موثَّق برأسه وسجلّه، لا محوٌ للتاريخ.
--   ٢) عمود `revertsWaveId` + فهرسٌ **فريد** عليه ⇒ لا يُتراجَع عن موجةٍ مرّتين، و«مُتراجَعٌ عنها»
--      تصير قابلةً للاستعلام بضمّةٍ واحدة. (بلا FK عمداً: drizzle-kit يُسقط UNIQUE إذا اجتمع مع FK.)
--   ٣) توسيع قيدَي CHECK: كلاهما كان يرفض `REVERT` (قيمته صفر ولا ينتمي لأيّ مجموعة نِسَب).
--
-- ⚠️ `db:push` لا يوسّع enum ⇒ قواعد الاختبار المحلّية تحتاج `pnpm test:db:init` بعد هذه الهجرة.
-- كل عبارةٍ محروسة بـinformation_schema ⇒ إعادة التطبيق على قاعدةٍ مطبَّقة لا تُسقِط النشر.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'priceUpdateWaves' AND COLUMN_NAME = 'revertsWaveId'
);--> statement-breakpoint
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE `priceUpdateWaves` ADD COLUMN `revertsWaveId` bigint NULL',
  'DO 0');--> statement-breakpoint
PREPARE s FROM @stmt;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'priceUpdateWaves' AND INDEX_NAME = 'uq_wave_reverts'
);--> statement-breakpoint
SET @stmt := IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX `uq_wave_reverts` ON `priceUpdateWaves` (`revertsWaveId`)',
  'DO 0');--> statement-breakpoint
PREPARE s FROM @stmt;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint

-- توسيع enum نوع التغيير بـREVERT (MODIFY صريح — `db:push` لا يفعلها).
ALTER TABLE `priceUpdateWaves` MODIFY COLUMN `priceChangeType`
  enum('INCREASE_PERCENT','DECREASE_PERCENT','INCREASE_AMOUNT','DECREASE_AMOUNT','SET_MARGIN','REVERT') NOT NULL;--> statement-breakpoint

-- chk_wave_value_positive: كان `changeValue > 0` مطلقاً ⇒ يرفض صفر موجة التراجع.
SET @chk1 := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'priceUpdateWaves' AND CONSTRAINT_NAME = 'chk_wave_value_positive'
);--> statement-breakpoint
SET @stmt := IF(@chk1 > 0,
  'ALTER TABLE `priceUpdateWaves` DROP CHECK `chk_wave_value_positive`',
  'DO 0');--> statement-breakpoint
PREPARE s FROM @stmt;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
ALTER TABLE `priceUpdateWaves` ADD CONSTRAINT `chk_wave_value_positive`
  CHECK (`priceChangeType` = 'REVERT' OR `changeValue` > 0);--> statement-breakpoint

-- chk_wave_pct_bounds: كان يشترط انتماء النوع لإحدى المجموعتين ⇒ REVERT يسقط في FALSE.
SET @chk2 := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'priceUpdateWaves' AND CONSTRAINT_NAME = 'chk_wave_pct_bounds'
);--> statement-breakpoint
SET @stmt := IF(@chk2 > 0,
  'ALTER TABLE `priceUpdateWaves` DROP CHECK `chk_wave_pct_bounds`',
  'DO 0');--> statement-breakpoint
PREPARE s FROM @stmt;--> statement-breakpoint
EXECUTE s;--> statement-breakpoint
DEALLOCATE PREPARE s;--> statement-breakpoint
ALTER TABLE `priceUpdateWaves` ADD CONSTRAINT `chk_wave_pct_bounds` CHECK (
  `priceChangeType` IN ('INCREASE_AMOUNT','DECREASE_AMOUNT','REVERT')
  OR `changeValue` <= 1000
);
