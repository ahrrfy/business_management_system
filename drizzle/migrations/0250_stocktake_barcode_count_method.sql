-- **الجرد بالباركود — أسلوب العدّ + إثبات المصدر + طابور الباركود المجهول** (وثيقة ٢٢/٨، م١).
--
-- ثلاث إضافاتٍ لا تمسّ أي عمودٍ أو قيمةِ enum قائمة (فلا حارسَ يُعمى، ولا سلوكَ جلسةٍ قائمة يتغيّر):
--   ١) `stocktakeSessions.countMethod` = أسلوب الجلسة (SCAN_REQUIRED | FREE). الافتراض في
--      القاعدة FREE عمداً كي لا تنقلب جلسةٌ جاريةٌ (COUNTING) إلى «مسحٍ إلزامي» فيعجز عمّالها؛
--      والجلسة الجديدة تُنشأ SCAN_REQUIRED من create.ts (قرار المالك).
--   ٢) `entryMethod` + `scannedBarcode` على سجلّ العدّات وسجلّ العمليات = نسبُ كل عدّةٍ إلى
--      مصدرها. الإثبات (إعادة حلّ الباركود ومطابقته بالمتغيّر) خادميّ في submit؛ العمودان أثرٌ.
--   ٣) جدول `stocktakeUnknownScans` = باركودٌ مُسح ولم يُحلّ داخل الجلسة (بضاعةٌ لا يعرفها النظام
--      أو خارج النطاق) — append-only يعالجه المشرف.
--
-- ⚠️ اسم عمود الحالة `unknownScanStatus` (المعامل الأول لـ mysqlEnum = اسم العمود، لا `status`).
-- idempotent محروسٌ بـ information_schema — يُطبَّق بأمانٍ ولو جزئياً على قاعدةٍ سبق أن مسّته.

SET NAMES utf8mb4;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeSessions'
    AND COLUMN_NAME = 'countMethod'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `stocktakeSessions` ADD COLUMN `countMethod` enum(''SCAN_REQUIRED'',''FREE'') NOT NULL DEFAULT ''FREE''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeCounts'
    AND COLUMN_NAME = 'entryMethod'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `stocktakeCounts` ADD COLUMN `entryMethod` enum(''SCAN_HID'',''SCAN_CAMERA'',''MANUAL_AUTHORIZED'',''SEARCH_PICK'') NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeCounts'
    AND COLUMN_NAME = 'scannedBarcode'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `stocktakeCounts` ADD COLUMN `scannedBarcode` varchar(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeCountOperations'
    AND COLUMN_NAME = 'entryMethod'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `stocktakeCountOperations` ADD COLUMN `entryMethod` enum(''SCAN_HID'',''SCAN_CAMERA'',''MANUAL_AUTHORIZED'',''SEARCH_PICK'') NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeCountOperations'
    AND COLUMN_NAME = 'scannedBarcode'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `stocktakeCountOperations` ADD COLUMN `scannedBarcode` varchar(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `stocktakeUnknownScans` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`sessionId` bigint NOT NULL,
	`assignmentId` bigint NOT NULL,
	`barcode` varchar(64) NOT NULL,
	`scannedByName` varchar(120) NOT NULL,
	`scannedByUserId` int,
	`unknownScanStatus` enum('PENDING','RESOLVED','DISMISSED') NOT NULL DEFAULT 'PENDING',
	`resolvedVariantId` bigint,
	`resolvedBy` int,
	`resolvedAt` timestamp NULL,
	`resolutionNote` varchar(255),
	`clientRequestId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stocktakeUnknownScans_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stkunknown_request` UNIQUE(`sessionId`,`clientRequestId`)
);
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeUnknownScans'
    AND CONSTRAINT_NAME = 'fk_stkunknown_session' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `stocktakeUnknownScans` ADD CONSTRAINT `fk_stkunknown_session` FOREIGN KEY (`sessionId`) REFERENCES `stocktakeSessions`(`id`) ON DELETE cascade',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeUnknownScans'
    AND CONSTRAINT_NAME = 'fk_stkunknown_assignment' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `stocktakeUnknownScans` ADD CONSTRAINT `fk_stkunknown_assignment` FOREIGN KEY (`assignmentId`) REFERENCES `stocktakeAssignments`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeUnknownScans'
    AND CONSTRAINT_NAME = 'fk_stkunknown_scannedby' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `stocktakeUnknownScans` ADD CONSTRAINT `fk_stkunknown_scannedby` FOREIGN KEY (`scannedByUserId`) REFERENCES `users`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeUnknownScans'
    AND CONSTRAINT_NAME = 'fk_stkunknown_resolved_variant' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `stocktakeUnknownScans` ADD CONSTRAINT `fk_stkunknown_resolved_variant` FOREIGN KEY (`resolvedVariantId`) REFERENCES `productVariants`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeUnknownScans'
    AND CONSTRAINT_NAME = 'fk_stkunknown_resolvedby' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `stocktakeUnknownScans` ADD CONSTRAINT `fk_stkunknown_resolvedby` FOREIGN KEY (`resolvedBy`) REFERENCES `users`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeUnknownScans'
    AND INDEX_NAME = 'idx_stkunknown_session_status'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `idx_stkunknown_session_status` ON `stocktakeUnknownScans` (`sessionId`,`unknownScanStatus`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
