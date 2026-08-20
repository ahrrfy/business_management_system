-- ش٤ من المرحلة ٢ (١٩/٨): إلغاءٌ صادق — سببٌ ووقتٌ وفاعل.
--
-- ثلاثةُ أعمدةٍ نظيرُها موجودٌ في جدولين آخرين وغائبٌ عن `workOrders` وحده:
--   · `receptionDrafts.cancelReason`  · `onlineOrders.cancelReason`
-- فيذوب «لم يحضر العميل» في إلغاءٍ مجهول السبب، ولا يستطيع المالك قراءةَ رقمه.
--
-- ⛔ ولا عمودَ **رمزٍ** ثانٍ للسبب: تقرير «لم يحضر أصحابها» يُشتقّ بلا رمزٍ من عمر الجاهزية
-- (`readyAt = workStartedAt + INTERVAL workSeconds SECOND` — صحيحٌ لأنّ `markWorkOrderReady`
-- هو الكاتبُ الوحيد لـ`workSeconds`). فالعمود للمساءلة، والتقرير اشتقاق.
--
-- وسجلُّ التدقيق **ليس بديلاً**: `logAudit` بذلٌ أفضل (best-effort) ومُعقَّم ومسقوف، وليس سطحَ
-- قراءةٍ للأعمال — والفلترةُ عليه بحثٌ في JSON.
--
-- idempotent محروسٌ بـinformation_schema.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'cancelReason'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `cancelReason` varchar(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'cancelledAt'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `cancelledAt` timestamp NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'cancelledBy'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `cancelledBy` int NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders'
    AND CONSTRAINT_NAME = 'fk_wo_cancelled_by' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `workOrders` ADD CONSTRAINT `fk_wo_cancelled_by` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
