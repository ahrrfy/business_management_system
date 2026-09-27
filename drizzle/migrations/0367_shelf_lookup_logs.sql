-- 0367_shelf_lookup_logs.sql
-- جدول تسجيل عمليات مسح واستعلام أسعار الرفوف بالباركود وحصر أعداد المستفيدين والتحليلات

CREATE TABLE IF NOT EXISTS `shelfLookupLogs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `visitorId` VARCHAR(64) NOT NULL,
  `branchId` BIGINT NULL,
  `barcode` VARCHAR(64) NOT NULL,
  `productId` BIGINT NULL,
  `productName` VARCHAR(255) NULL,
  `found` BOOLEAN NOT NULL DEFAULT FALSE,
  `deviceType` VARCHAR(32) NOT NULL DEFAULT 'unknown',
  `ipHash` VARCHAR(64) NULL,
  `userAgent` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_shelf_lookup_visitor` (`visitorId`),
  KEY `idx_shelf_lookup_branch` (`branchId`),
  KEY `idx_shelf_lookup_product` (`productId`),
  KEY `idx_shelf_lookup_created` (`createdAt`),
  KEY `idx_shelf_lookup_found` (`found`),
  CONSTRAINT `fk_shelf_lookup_branch`
    FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_shelf_lookup_product`
    FOREIGN KEY (`productId`) REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
