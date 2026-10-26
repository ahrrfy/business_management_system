-- Storefront Wave 2: privacy account deletion (1-year accounting retention),
-- customer checkout notes, and guarded customization assets.
-- Strictly additive and idempotent for zero-downtime rollout.
SET @w2_0406_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='deletedAt'), 'SELECT 1', 'ALTER TABLE `customers` ADD COLUMN `deletedAt` timestamp NULL');
--> statement-breakpoint
PREPARE w2_0406_stmt FROM @w2_0406_ddl;
--> statement-breakpoint
EXECUTE w2_0406_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w2_0406_stmt;
--> statement-breakpoint
SET @w2_0406_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='retentionUntil'), 'SELECT 1', 'ALTER TABLE `customers` ADD COLUMN `retentionUntil` timestamp NULL');
--> statement-breakpoint
PREPARE w2_0406_stmt FROM @w2_0406_ddl;
--> statement-breakpoint
EXECUTE w2_0406_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w2_0406_stmt;
--> statement-breakpoint
SET @w2_0406_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='sessionVersion'), 'SELECT 1', 'ALTER TABLE `customers` ADD COLUMN `sessionVersion` int NOT NULL DEFAULT 0');
--> statement-breakpoint
PREPARE w2_0406_stmt FROM @w2_0406_ddl;
--> statement-breakpoint
EXECUTE w2_0406_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w2_0406_stmt;
--> statement-breakpoint
SET @w2_0406_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND INDEX_NAME='idx_customers_deleted_retention'), 'SELECT 1', 'ALTER TABLE `customers` ADD INDEX `idx_customers_deleted_retention` (`deletedAt`,`retentionUntil`)');
--> statement-breakpoint
PREPARE w2_0406_stmt FROM @w2_0406_ddl;
--> statement-breakpoint
EXECUTE w2_0406_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w2_0406_stmt;
--> statement-breakpoint
SET @w2_0406_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='onlineOrders' AND COLUMN_NAME='customerNotes'), 'SELECT 1', 'ALTER TABLE `onlineOrders` ADD COLUMN `customerNotes` text NULL');
--> statement-breakpoint
PREPARE w2_0406_stmt FROM @w2_0406_ddl;
--> statement-breakpoint
EXECUTE w2_0406_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w2_0406_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `storefrontAccountDeletionRequests` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`requestNumber` varchar(40) NOT NULL,
	`phoneHash` varchar(64) NOT NULL,
	`customerId` bigint,
	`reason` varchar(500),
	`status` enum('PENDING_REVIEW','COMPLETED','REJECTED') NOT NULL DEFAULT 'PENDING_REVIEW',
	`retentionUntil` timestamp NOT NULL,
	`requestedIpHash` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `storefrontAccountDeletionRequests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_sf_acct_del_req_num` UNIQUE(`requestNumber`),
	KEY `idx_sf_acct_del_phone_hash` (`phoneHash`,`createdAt`),
	KEY `idx_sf_acct_del_status` (`status`,`createdAt`),
	KEY `idx_sf_acct_del_customer` (`customerId`),
	CONSTRAINT `fk_sf_acct_del_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `storefrontCustomizationAssets` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`assetKey` varchar(255) NOT NULL,
	`sha256` char(64) NOT NULL,
	`mimeType` enum('image/png','image/jpeg','image/webp') NOT NULL,
	`byteLength` int NOT NULL,
	`kind` enum('LOGO','PREVIEW') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NULL,
	CONSTRAINT `storefrontCustomizationAssets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_sf_custom_asset_key` UNIQUE(`assetKey`),
	KEY `idx_sf_custom_asset_sha_kind` (`sha256`,`kind`),
	KEY `idx_sf_custom_asset_expires` (`expiresAt`)
);
