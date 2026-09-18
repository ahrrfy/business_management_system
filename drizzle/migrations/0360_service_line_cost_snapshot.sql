-- 0360 — لقطة كلفة السطر ومواد الخدمة.
--
-- `unitCost` ذو منزلتين مناسب للعرض، لكنه ليس مصدراً آمناً لإعادة بناء مجموع السطر
-- (1 ÷ 3 = 0.33 ثم 0.33 × 3 = 0.99). نحفظ المجموع المستندي كما قُيّد، ونحفظ مواد
-- الخدمة نفسها كي لا يعتمد التصحيح/الإلغاء على وصفة حيّة أو نص notes حر.

SET @db := DATABASE();
--> statement-breakpoint

SET @has_line_cost := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'invoiceItems'
    AND COLUMN_NAME = 'lineCost'
);
--> statement-breakpoint
SET @sql := IF(
  @has_line_cost = 0,
  'ALTER TABLE `invoiceItems` ADD COLUMN `lineCost` DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER `unitCost`',
  'SELECT ''invoiceItems.lineCost already present'''
);
--> statement-breakpoint
PREPARE stmt FROM @sql;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_service_snapshot_flag := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'invoiceItems'
    AND COLUMN_NAME = 'serviceMaterialsSnapshotted'
);
--> statement-breakpoint
SET @sql := IF(
  @has_service_snapshot_flag = 0,
  'ALTER TABLE `invoiceItems` ADD COLUMN `serviceMaterialsSnapshotted` BOOLEAN NOT NULL DEFAULT FALSE AFTER `lineCost`',
  'SELECT ''invoiceItems.serviceMaterialsSnapshotted already present'''
);
--> statement-breakpoint
PREPARE stmt FROM @sql;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- يحفظ هذا بالضبط السلوك المالي التاريخي: الكلفة التي كان النظام يعيد إنتاجها من unitCost.
-- لا ندّعي إعادة بناء مواد خدمة تاريخية؛ العلم يبقى FALSE فتفشل عمليات العكس الحساسة مغلقة.
UPDATE `invoiceItems`
SET `lineCost` = ROUND(`unitCost` * `baseQuantity`, 2)
WHERE `serviceMaterialsSnapshotted` = FALSE
  AND `lineCost` = 0;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `invoiceItemServiceMaterials` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `invoiceItemId` BIGINT NOT NULL,
  `materialVariantId` BIGINT NOT NULL,
  `baseQuantity` INT NOT NULL,
  `unitCost` DECIMAL(15,2) NOT NULL,
  `lineCost` DECIMAL(15,2) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iism_item_material` (`invoiceItemId`, `materialVariantId`),
  KEY `idx_iism_item` (`invoiceItemId`),
  KEY `idx_iism_material` (`materialVariantId`),
  CONSTRAINT `fk_iism_item`
    FOREIGN KEY (`invoiceItemId`) REFERENCES `invoiceItems` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_iism_material`
    FOREIGN KEY (`materialVariantId`) REFERENCES `productVariants` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_iism_quantity_positive` CHECK (`baseQuantity` > 0),
  CONSTRAINT `chk_iism_cost_nonnegative` CHECK (`unitCost` >= 0 AND `lineCost` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
