-- 0062: باركودات بديلة (aliases) لوحدة المنتج
--
-- الفكرة: منتج واحد بتكلفة وسعر ومخزن موحّد قد يحمل عدّة باركودات في السوق
-- (نفس السلعة بأشكال خارجية مختلفة، أو دفعات استيراد بترميز مختلف). بدل تكرار
-- المتغيّر/الوحدة (مما يُفرّغ التقارير المخزنيّة والماليّة)، نُخزّن الباركودات البديلة
-- في جدول جانبيّ يشير كلٌّ منها إلى `productUnitId` الأصليّ.
--
-- التفرّد العالميّ: `barcode` UNIQUE على مستوى العمود. الحدس المطلوب: باركود واحد لا
-- يخصّ سلعتَين مختلفتَين — يُنفَّذ تطبيقياً عبر `checkBarcodesTakenAcrossBoth`.
--
-- **idempotent** للتطبيق من `ci-apply-extra-migrations.mjs`: يفحص INFORMATION_SCHEMA
-- قبل إضافة قيود FK. سبب الحاجة: `db:push` قد يُنشئ الجدول بلا قيد FK — وحينها CREATE
-- TABLE IF NOT EXISTS يتخطّى الكتلة صامتاً فيبقى الحذف بلا cascade (فَشِل A3 على CI ٨/٧/٢٦).

CREATE TABLE IF NOT EXISTS `productUnitBarcodes` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `productUnitId` BIGINT NOT NULL,
  `barcode` VARCHAR(64) NOT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `createdBy` INT DEFAULT NULL,
  `createdAt` TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE KEY `uq_unit_barcode_alias` (`barcode`),
  KEY `idx_alias_unit` (`productUnitId`),
  CONSTRAINT `fk_alias_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_alias_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint

-- قيد الأب FK بـcascade — نضيفه idempotently إن كان مفقوداً (سبب فشل CI الأصليّ).
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productUnitBarcodes' AND CONSTRAINT_NAME = 'fk_alias_unit');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `productUnitBarcodes` ADD CONSTRAINT `fk_alias_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- قيد المُنشئ FK بـset null — يتيح إبقاء البدائل عند حذف المستخدم.
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productUnitBarcodes' AND CONSTRAINT_NAME = 'fk_alias_creator');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `productUnitBarcodes` ADD CONSTRAINT `fk_alias_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- الفهارس (`uq_unit_barcode_alias` و `idx_alias_unit`): يُنشئها CREATE TABLE للجدول الجديد،
-- ولجدولٍ قائمٍ بلا فهرس نضيفها idempotently عبر INFORMATION_SCHEMA (لتفادي DUPLICATE KEY error).
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productUnitBarcodes' AND INDEX_NAME = 'uq_unit_barcode_alias');
SET @sql := IF(@exists = 0,
  'CREATE UNIQUE INDEX `uq_unit_barcode_alias` ON `productUnitBarcodes` (`barcode`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productUnitBarcodes' AND INDEX_NAME = 'idx_alias_unit');
SET @sql := IF(@exists = 0,
  'CREATE INDEX `idx_alias_unit` ON `productUnitBarcodes` (`productUnitId`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
