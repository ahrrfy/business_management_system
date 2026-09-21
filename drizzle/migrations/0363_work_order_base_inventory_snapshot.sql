-- 0363 — لقطة وحدة وكمية الصنف الأساس في أمر الشغل.
--
-- الصف التاريخي ذو baseVariantId مع لقطة NULL يبقى قابلاً للقراءة، لكنه لا يُسلَّم ولا
-- يبدأ تلقائياً: لا يمكن إثبات أي وحدة اختارها العميل أو كم وحدة أساس كان يجب استهلاكها.
-- الأوامر الجديدة تحفظ اللقطة كاملة، وتوسم سطر المادة الأساسية المادية بحيث لا يضيع بين
-- المواد اليدوية. العمود المولد + UNIQUE يفرضان سطر أساس واحداً كحد أقصى لكل أمر.

SET @db := DATABASE();
--> statement-breakpoint

SET @has_base_product_unit := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'baseProductUnitId'
);
SET @sql := IF(
  @has_base_product_unit = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `baseProductUnitId` BIGINT NULL AFTER `baseVariantId`',
  'SELECT ''workOrders.baseProductUnitId already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_base_base_quantity := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'baseBaseQuantity'
);
SET @sql := IF(
  @has_base_base_quantity = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `baseBaseQuantity` INT NULL AFTER `baseProductUnitId`',
  'SELECT ''workOrders.baseBaseQuantity already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_base_consumes_inventory := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'baseConsumesInventory'
);
SET @sql := IF(
  @has_base_consumes_inventory = 0,
  'ALTER TABLE `workOrders` ADD COLUMN `baseConsumesInventory` BOOLEAN NULL AFTER `baseBaseQuantity`',
  'SELECT ''workOrders.baseConsumesInventory already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_base_material_flag := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workOrderMaterials' AND COLUMN_NAME = 'isBaseMaterial'
);
SET @sql := IF(
  @has_base_material_flag = 0,
  'ALTER TABLE `workOrderMaterials` ADD COLUMN `isBaseMaterial` BOOLEAN NOT NULL DEFAULT FALSE AFTER `baseQuantity`',
  'SELECT ''workOrderMaterials.isBaseMaterial already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_base_material_slot := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workOrderMaterials' AND COLUMN_NAME = 'baseMaterialSlot'
);
SET @sql := IF(
  @has_base_material_slot = 0,
  'ALTER TABLE `workOrderMaterials` ADD COLUMN `baseMaterialSlot` TINYINT GENERATED ALWAYS AS (CASE WHEN `isBaseMaterial` = 1 THEN 1 ELSE NULL END) VIRTUAL AFTER `isBaseMaterial`',
  'SELECT ''workOrderMaterials.baseMaterialSlot already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_base_unit_fk := (
  SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db
    AND TABLE_NAME = 'workOrders'
    AND CONSTRAINT_NAME = 'workOrders_baseProductUnitId_productUnits_id_fk'
);
SET @sql := IF(
  @has_base_unit_fk = 0,
  'ALTER TABLE `workOrders` ADD CONSTRAINT `workOrders_baseProductUnitId_productUnits_id_fk` FOREIGN KEY (`baseProductUnitId`) REFERENCES `productUnits` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION',
  'SELECT ''workOrders base unit FK already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_base_unit_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workOrders' AND INDEX_NAME = 'idx_wo_base_unit'
);
SET @sql := IF(
  @has_base_unit_idx = 0,
  'ALTER TABLE `workOrders` ADD INDEX `idx_wo_base_unit` (`baseProductUnitId`)',
  'SELECT ''idx_wo_base_unit already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_one_base_uq := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'workOrderMaterials' AND INDEX_NAME = 'uq_wom_one_base_material'
);
SET @sql := IF(
  @has_one_base_uq = 0,
  'ALTER TABLE `workOrderMaterials` ADD UNIQUE INDEX `uq_wom_one_base_material` (`workOrderId`, `baseMaterialSlot`)',
  'SELECT ''uq_wom_one_base_material already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_qty_check := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'workOrders'
    AND CONSTRAINT_NAME = 'chk_wo_base_snapshot_qty_positive' AND CONSTRAINT_TYPE = 'CHECK'
);
SET @sql := IF(
  @has_qty_check = 0,
  'ALTER TABLE `workOrders` ADD CONSTRAINT `chk_wo_base_snapshot_qty_positive` CHECK (`baseBaseQuantity` IS NULL OR `baseBaseQuantity` > 0)',
  'SELECT ''chk_wo_base_snapshot_qty_positive already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_shape_check := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db AND TABLE_NAME = 'workOrders'
    AND CONSTRAINT_NAME = 'chk_wo_base_snapshot_shape' AND CONSTRAINT_TYPE = 'CHECK'
);
SET @sql := IF(
  @has_shape_check = 0,
  'ALTER TABLE `workOrders` ADD CONSTRAINT `chk_wo_base_snapshot_shape` CHECK (((`baseVariantId` IS NULL AND `baseProductUnitId` IS NULL AND `baseBaseQuantity` IS NULL AND `baseConsumesInventory` IS NULL) OR (`baseVariantId` IS NOT NULL AND (((`baseProductUnitId` IS NULL AND `baseBaseQuantity` IS NULL AND `baseConsumesInventory` IS NULL)) OR (`baseProductUnitId` IS NOT NULL AND `baseBaseQuantity` IS NOT NULL AND `baseConsumesInventory` IS NOT NULL)))))',
  'SELECT ''chk_wo_base_snapshot_shape already present'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
