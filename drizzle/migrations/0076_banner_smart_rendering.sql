-- 0076: عرض ذكي للبنرات + مؤشرات يومية بلا بيانات شخصية.
-- كل أمر محروس كي يبقى آمناً عند إعادة النشر أو بعد db:push في CI.

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND COLUMN_NAME = 'mobileImageUrl');
SET @s := IF(@c = 0, 'ALTER TABLE `storeBanners` ADD `mobileImageUrl` MEDIUMTEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND COLUMN_NAME = 'renderMode');
SET @s := IF(@c = 0, "ALTER TABLE `storeBanners` ADD `renderMode` enum('SMART_CROP','PRESERVE_FULL','LAYERED') NOT NULL DEFAULT 'PRESERVE_FULL'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND COLUMN_NAME = 'focusX');
SET @s := IF(@c = 0, 'ALTER TABLE `storeBanners` ADD `focusX` INT NOT NULL DEFAULT 50', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND COLUMN_NAME = 'focusY');
SET @s := IF(@c = 0, 'ALTER TABLE `storeBanners` ADD `focusY` INT NOT NULL DEFAULT 50', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `storeBannerDailyMetrics` (
  `bannerId` BIGINT NOT NULL,
  `metricDate` DATE NOT NULL,
  `placement` ENUM('HERO','SIDE','INLINE') NOT NULL,
  `impressions` INT UNSIGNED NOT NULL DEFAULT 0,
  `clicks` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`bannerId`, `metricDate`, `placement`),
  KEY `idx_banner_metric_date` (`metricDate`),
  CONSTRAINT `fk_banner_metric_banner` FOREIGN KEY (`bannerId`) REFERENCES `storeBanners`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBannerDailyMetrics' AND CONSTRAINT_NAME = 'fk_banner_metric_banner');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `storeBannerDailyMetrics` ADD CONSTRAINT `fk_banner_metric_banner` FOREIGN KEY (`bannerId`) REFERENCES `storeBanners`(`id`) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
