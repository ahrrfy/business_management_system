-- 0250: product-content governance — حقول محتوى دائمة، مسودات AI، وسجل قرارات الاعتماد.
-- Idempotent: يمكن تشغيلها أكثر من مرة دون فشل، وتبقي name/description القديمين للتوافق.

SET @c1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'internalName');
SET @s1 := IF(@c1 = 0,
  'ALTER TABLE `products` ADD `internalName` varchar(255) NULL AFTER `description`',
  'SELECT 1');
PREPARE st1 FROM @s1; EXECUTE st1; DEALLOCATE PREPARE st1;

SET @c2 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'storeTitle');
SET @s2 := IF(@c2 = 0,
  'ALTER TABLE `products` ADD `storeTitle` varchar(255) NULL AFTER `internalName`',
  'SELECT 1');
PREPARE st2 FROM @s2; EXECUTE st2; DEALLOCATE PREPARE st2;

SET @c3 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'seoTitle');
SET @s3 := IF(@c3 = 0,
  'ALTER TABLE `products` ADD `seoTitle` varchar(255) NULL AFTER `storeTitle`',
  'SELECT 1');
PREPARE st3 FROM @s3; EXECUTE st3; DEALLOCATE PREPARE st3;

SET @c4 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'shortTitle');
SET @s4 := IF(@c4 = 0,
  'ALTER TABLE `products` ADD `shortTitle` varchar(160) NULL AFTER `seoTitle`',
  'SELECT 1');
PREPARE st4 FROM @s4; EXECUTE st4; DEALLOCATE PREPARE st4;

SET @c5 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'posLabel');
SET @s5 := IF(@c5 = 0,
  'ALTER TABLE `products` ADD `posLabel` varchar(120) NULL AFTER `shortTitle`',
  'SELECT 1');
PREPARE st5 FROM @s5; EXECUTE st5; DEALLOCATE PREPARE st5;

SET @c6 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'invoiceLabel');
SET @s6 := IF(@c6 = 0,
  'ALTER TABLE `products` ADD `invoiceLabel` varchar(255) NULL AFTER `posLabel`',
  'SELECT 1');
PREPARE st6 FROM @s6; EXECUTE st6; DEALLOCATE PREPARE st6;

SET @c7 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'marketingCopy');
SET @s7 := IF(@c7 = 0,
  'ALTER TABLE `products` ADD `marketingCopy` text NULL AFTER `invoiceLabel`',
  'SELECT 1');
PREPARE st7 FROM @s7; EXECUTE st7; DEALLOCATE PREPARE st7;

SET @i1 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_product_internal_name');
SET @q1 := IF(@i1 = 0,
  'ALTER TABLE `products` ADD INDEX `idx_product_internal_name` (`internalName`)',
  'SELECT 1');
PREPARE si1 FROM @q1; EXECUTE si1; DEALLOCATE PREPARE si1;

SET @i2 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_product_store_title');
SET @q2 := IF(@i2 = 0,
  'ALTER TABLE `products` ADD INDEX `idx_product_store_title` (`storeTitle`)',
  'SELECT 1');
PREPARE si2 FROM @q2; EXECUTE si2; DEALLOCATE PREPARE si2;

CREATE TABLE IF NOT EXISTS `productContentDrafts` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `productId` bigint NULL,
  `sourceFacts` json NOT NULL,
  `sourceFactsHash` varchar(64) NOT NULL,
  `content` json NOT NULL,
  `validation` json NOT NULL,
  `status` enum('DRAFT','APPROVED','REJECTED','APPLIED','SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
  `promptVersion` varchar(40) NOT NULL,
  `model` varchar(120) NOT NULL,
  `createdBy` int NULL,
  `reviewedBy` int NULL,
  `reviewedAt` timestamp NULL,
  `appliedAt` timestamp NULL,
  `decisionNote` text NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pcd_product_status` (`productId`,`status`,`createdAt`),
  KEY `idx_pcd_facts_hash` (`sourceFactsHash`),
  KEY `idx_pcd_created_by` (`createdBy`,`createdAt`),
  CONSTRAINT `fk_pcd_product` FOREIGN KEY (`productId`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pcd_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pcd_reviewed_by` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `productContentApprovalEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `draftId` bigint NULL,
  `productId` bigint NULL,
  `action` enum('SUBMITTED','APPROVED','REJECTED','APPLIED','SUPERSEDED') NOT NULL,
  `actorUserId` int NULL,
  `branchId` bigint NULL,
  `sourceFactsHash` varchar(64) NULL,
  `beforeContent` json NULL,
  `afterContent` json NULL,
  `note` text NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pcae_draft` (`draftId`,`createdAt`),
  KEY `idx_pcae_product` (`productId`,`createdAt`),
  KEY `idx_pcae_actor` (`actorUserId`,`createdAt`),
  KEY `idx_pcae_branch` (`branchId`,`createdAt`),
  CONSTRAINT `fk_pcae_draft` FOREIGN KEY (`draftId`) REFERENCES `productContentDrafts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pcae_product` FOREIGN KEY (`productId`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pcae_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pcae_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

--> statement-breakpoint

-- Legacy products remain readable. These backfills are deliberately conservative:
-- no marketing claims are invented, and values can be regenerated/reviewed later.
UPDATE `products`
SET `internalName` = `name`
WHERE (`internalName` IS NULL OR TRIM(`internalName`) = '') AND `name` IS NOT NULL;

UPDATE `products`
SET `storeTitle` = `name`
WHERE (`storeTitle` IS NULL OR TRIM(`storeTitle`) = '') AND `name` IS NOT NULL;

UPDATE `products`
SET `posLabel` = LEFT(`name`, 120)
WHERE (`posLabel` IS NULL OR TRIM(`posLabel`) = '') AND `name` IS NOT NULL;

UPDATE `products`
SET `invoiceLabel` = LEFT(`name`, 255)
WHERE (`invoiceLabel` IS NULL OR TRIM(`invoiceLabel`) = '') AND `name` IS NOT NULL;

UPDATE `products`
SET `seoTitle` = LEFT(`name`, 255)
WHERE (`seoTitle` IS NULL OR TRIM(`seoTitle`) = '') AND `name` IS NOT NULL;

UPDATE `products`
SET `marketingCopy` = NULL
WHERE `marketingCopy` IS NULL;

--> statement-breakpoint

-- Optional foreign keys are intentionally not added to auditLogs: its historical rows must survive
-- deletion of a product/user, while productContentApprovalEvents retains a typed domain trail.
