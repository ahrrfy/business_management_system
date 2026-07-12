-- 0064: بنرات المتجر (storeBanners) — يديرها الموظف من لوحة المتجر (hPanel).
-- idempotent (CREATE IF NOT EXISTS + قيود/فهارس بحارس INFORMATION_SCHEMA) — نمط 0062.

CREATE TABLE IF NOT EXISTS `storeBanners` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `title` VARCHAR(255) NOT NULL,
  `subtitle` VARCHAR(500) DEFAULT NULL,
  `imageUrl` MEDIUMTEXT DEFAULT NULL,
  `ctaLabel` VARCHAR(120) DEFAULT NULL,
  `ctaUrl` VARCHAR(500) DEFAULT NULL,
  `sortOrder` INT NOT NULL DEFAULT 0,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `effectiveFrom` DATE DEFAULT NULL,
  `effectiveTo` DATE DEFAULT NULL,
  `branchId` BIGINT DEFAULT NULL,
  `createdBy` INT DEFAULT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_banner_active_sort` (`isActive`, `sortOrder`),
  KEY `idx_banner_branch` (`branchId`),
  CONSTRAINT `fk_banner_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_banner_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint

-- قيود FK idempotent (db:push على CI قد يُنشئ الجدول بلا FK).
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND CONSTRAINT_NAME = 'fk_banner_branch');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `storeBanners` ADD CONSTRAINT `fk_banner_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND CONSTRAINT_NAME = 'fk_banner_creator');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `storeBanners` ADD CONSTRAINT `fk_banner_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND INDEX_NAME = 'idx_banner_active_sort');
SET @sql := IF(@exists = 0, 'CREATE INDEX `idx_banner_active_sort` ON `storeBanners` (`isActive`, `sortOrder`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeBanners' AND INDEX_NAME = 'idx_banner_branch');
SET @sql := IF(@exists = 0, 'CREATE INDEX `idx_banner_branch` ON `storeBanners` (`branchId`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
