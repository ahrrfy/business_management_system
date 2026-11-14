-- 0429: Redesign Promotions & Discounts Subsystem
-- Expanding promotions to 6 types, channel enum, allowBelowCost, applyToBaseUnitOnly,
-- activeDays scheduling, productUnitId targeting grain, child table promotionTiers,
-- and updated CHECK constraints chk_promo_shape and chk_promo_target_grain.
SET @promo_drop_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotions'
      AND CONSTRAINT_NAME = 'chk_promo_shape'
  ),
  'ALTER TABLE `promotions` DROP CHECK `chk_promo_shape`',
  'SELECT 1'
);
PREPARE promo_drop_stmt FROM @promo_drop_chk;
EXECUTE promo_drop_stmt;
DEALLOCATE PREPARE promo_drop_stmt;
--> statement-breakpoint
SET @target_drop_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotionTargets'
      AND CONSTRAINT_NAME = 'chk_promo_target_grain'
  ),
  'ALTER TABLE `promotionTargets` DROP CHECK `chk_promo_target_grain`',
  'SELECT 1'
);
PREPARE target_drop_stmt FROM @target_drop_chk;
EXECUTE target_drop_stmt;
DEALLOCATE PREPARE target_drop_stmt;
--> statement-breakpoint
ALTER TABLE `promotions` MODIFY COLUMN `promotionType` enum(
  'PERCENT',
  'AMOUNT',
  'FIXED_PRICE',
  'BUNDLE_PRICE',
  'BOGO',
  'TIERED_QTY',
  'FREE_SHIPPING'
) NOT NULL;
--> statement-breakpoint
SET @promo_add_channel = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'promotionChannel'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `promotionChannel` enum(''ALL'',''POS_ONLY'',''STORE_ONLY'') NOT NULL DEFAULT ''ALL'''
);
PREPARE promo_add_channel_stmt FROM @promo_add_channel;
EXECUTE promo_add_channel_stmt;
DEALLOCATE PREPARE promo_add_channel_stmt;
--> statement-breakpoint
UPDATE `promotions`
SET `promotionChannel` = 'STORE_ONLY'
WHERE `isStoreManaged` = 1 AND `promotionChannel` = 'ALL';
--> statement-breakpoint
SET @promo_add_allow_below_cost = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'allowBelowCost'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `allowBelowCost` tinyint(1) NOT NULL DEFAULT 0'
);
PREPARE promo_add_allow_below_cost_stmt FROM @promo_add_allow_below_cost;
EXECUTE promo_add_allow_below_cost_stmt;
DEALLOCATE PREPARE promo_add_allow_below_cost_stmt;
--> statement-breakpoint
SET @promo_add_apply_base_unit = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'applyToBaseUnitOnly'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `applyToBaseUnitOnly` tinyint(1) NOT NULL DEFAULT 1'
);
PREPARE promo_add_apply_base_unit_stmt FROM @promo_add_apply_base_unit;
EXECUTE promo_add_apply_base_unit_stmt;
DEALLOCATE PREPARE promo_add_apply_base_unit_stmt;
--> statement-breakpoint
SET @promo_add_active_days = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'activeDays'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `activeDays` json NULL'
);
PREPARE promo_add_active_days_stmt FROM @promo_add_active_days;
EXECUTE promo_add_active_days_stmt;
DEALLOCATE PREPARE promo_add_active_days_stmt;
--> statement-breakpoint
SET @promo_add_fixed_price = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'fixedPrice'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `fixedPrice` decimal(15,2) NULL'
);
PREPARE promo_add_fixed_price_stmt FROM @promo_add_fixed_price;
EXECUTE promo_add_fixed_price_stmt;
DEALLOCATE PREPARE promo_add_fixed_price_stmt;
--> statement-breakpoint
SET @promo_add_bundle_price = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'bundlePrice'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `bundlePrice` decimal(15,2) NULL'
);
PREPARE promo_add_bundle_price_stmt FROM @promo_add_bundle_price;
EXECUTE promo_add_bundle_price_stmt;
DEALLOCATE PREPARE promo_add_bundle_price_stmt;
--> statement-breakpoint
SET @promo_add_bundle_mode = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'promotionBundleMode'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `promotionBundleMode` enum(''ALL_REQUIRED'',''PICK_ANY_N'') NULL'
);
PREPARE promo_add_bundle_mode_stmt FROM @promo_add_bundle_mode;
EXECUTE promo_add_bundle_mode_stmt;
DEALLOCATE PREPARE promo_add_bundle_mode_stmt;
--> statement-breakpoint
SET @promo_add_bundle_quantity = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'bundleQuantity'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `bundleQuantity` int NULL'
);
PREPARE promo_add_bundle_quantity_stmt FROM @promo_add_bundle_quantity;
EXECUTE promo_add_bundle_quantity_stmt;
DEALLOCATE PREPARE promo_add_bundle_quantity_stmt;
--> statement-breakpoint
SET @promo_add_bogo_buy = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'bogoBuyQuantity'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `bogoBuyQuantity` int NULL'
);
PREPARE promo_add_bogo_buy_stmt FROM @promo_add_bogo_buy;
EXECUTE promo_add_bogo_buy_stmt;
DEALLOCATE PREPARE promo_add_bogo_buy_stmt;
--> statement-breakpoint
SET @promo_add_bogo_get = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'bogoGetQuantity'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `bogoGetQuantity` int NULL'
);
PREPARE promo_add_bogo_get_stmt FROM @promo_add_bogo_get;
EXECUTE promo_add_bogo_get_stmt;
DEALLOCATE PREPARE promo_add_bogo_get_stmt;
--> statement-breakpoint
SET @promo_add_bogo_percent = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'bogoGetDiscountPercent'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `bogoGetDiscountPercent` decimal(5,2) NULL'
);
PREPARE promo_add_bogo_percent_stmt FROM @promo_add_bogo_percent;
EXECUTE promo_add_bogo_percent_stmt;
DEALLOCATE PREPARE promo_add_bogo_percent_stmt;
--> statement-breakpoint
SET @promo_add_tiered_mode = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND COLUMN_NAME = 'promotionTieredMode'),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD COLUMN `promotionTieredMode` enum(''PER_ITEM'',''POOL_ACROSS_TARGETS'') NULL'
);
PREPARE promo_add_tiered_mode_stmt FROM @promo_add_tiered_mode;
EXECUTE promo_add_tiered_mode_stmt;
DEALLOCATE PREPARE promo_add_tiered_mode_stmt;
--> statement-breakpoint
SET @promo_add_channel_idx = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotions' AND INDEX_NAME = 'idx_promo_channel'),
  'SELECT 1',
  'CREATE INDEX `idx_promo_channel` ON `promotions` (`promotionChannel`, `isActive`)'
);
PREPARE promo_add_channel_idx_stmt FROM @promo_add_channel_idx;
EXECUTE promo_add_channel_idx_stmt;
DEALLOCATE PREPARE promo_add_channel_idx_stmt;
--> statement-breakpoint
SET @target_add_unit_col = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotionTargets' AND COLUMN_NAME = 'productUnitId'),
  'SELECT 1',
  'ALTER TABLE `promotionTargets` ADD COLUMN `productUnitId` bigint NULL'
);
PREPARE target_add_unit_col_stmt FROM @target_add_unit_col;
EXECUTE target_add_unit_col_stmt;
DEALLOCATE PREPARE target_add_unit_col_stmt;
--> statement-breakpoint
SET @target_add_unit_fk = IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'promotionTargets' AND CONSTRAINT_NAME = 'fk_promo_target_unit'),
  'SELECT 1',
  'ALTER TABLE `promotionTargets` ADD CONSTRAINT `fk_promo_target_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE cascade ON UPDATE no action'
);
PREPARE target_add_unit_fk_stmt FROM @target_add_unit_fk;
EXECUTE target_add_unit_fk_stmt;
DEALLOCATE PREPARE target_add_unit_fk_stmt;
--> statement-breakpoint
SET @target_add_unit_idx = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotionTargets' AND INDEX_NAME = 'idx_promo_target_unit'),
  'SELECT 1',
  'CREATE INDEX `idx_promo_target_unit` ON `promotionTargets` (`productUnitId`)'
);
PREPARE target_add_unit_idx_stmt FROM @target_add_unit_idx;
EXECUTE target_add_unit_idx_stmt;
DEALLOCATE PREPARE target_add_unit_idx_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `promotionTiers` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `promotionId` bigint NOT NULL,
  `minQuantity` decimal(15,4) NOT NULL,
  `promotionTierType` enum('PERCENT','AMOUNT','FIXED_PRICE') NOT NULL,
  `discountPercent` decimal(5,2) NOT NULL DEFAULT '0',
  `discountAmount` decimal(15,2) NOT NULL DEFAULT '0',
  `fixedPrice` decimal(15,2) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `promotionTiers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @tier_add_promo_fk = IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'promotionTiers' AND CONSTRAINT_NAME = 'fk_promo_tier_promo'),
  'SELECT 1',
  'ALTER TABLE `promotionTiers` ADD CONSTRAINT `fk_promo_tier_promo` FOREIGN KEY (`promotionId`) REFERENCES `promotions`(`id`) ON DELETE cascade ON UPDATE no action'
);
PREPARE tier_add_promo_fk_stmt FROM @tier_add_promo_fk;
EXECUTE tier_add_promo_fk_stmt;
DEALLOCATE PREPARE tier_add_promo_fk_stmt;
--> statement-breakpoint
SET @tier_add_promo_idx = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotionTiers' AND INDEX_NAME = 'idx_promo_tier_promo'),
  'SELECT 1',
  'CREATE INDEX `idx_promo_tier_promo` ON `promotionTiers` (`promotionId`)'
);
PREPARE tier_add_promo_idx_stmt FROM @tier_add_promo_idx;
EXECUTE tier_add_promo_idx_stmt;
DEALLOCATE PREPARE tier_add_promo_idx_stmt;
--> statement-breakpoint
SET @tier_add_min_qty_uq = IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'promotionTiers' AND CONSTRAINT_NAME = 'uq_promo_tier_min_qty'),
  'SELECT 1',
  'ALTER TABLE `promotionTiers` ADD CONSTRAINT `uq_promo_tier_min_qty` UNIQUE (`promotionId`, `minQuantity`)'
);
PREPARE tier_add_min_qty_uq_stmt FROM @tier_add_min_qty_uq;
EXECUTE tier_add_min_qty_uq_stmt;
DEALLOCATE PREPARE tier_add_min_qty_uq_stmt;
--> statement-breakpoint
SET @tier_drop_min_qty_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotionTiers'
      AND CONSTRAINT_NAME = 'chk_promo_tier_min_qty'
  ),
  'ALTER TABLE `promotionTiers` DROP CHECK `chk_promo_tier_min_qty`',
  'SELECT 1'
);
PREPARE tier_drop_min_qty_chk_stmt FROM @tier_drop_min_qty_chk;
EXECUTE tier_drop_min_qty_chk_stmt;
DEALLOCATE PREPARE tier_drop_min_qty_chk_stmt;
--> statement-breakpoint
SET @tier_add_min_qty_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotionTiers'
      AND CONSTRAINT_NAME = 'chk_promo_tier_min_qty'
  ),
  'SELECT 1',
  'ALTER TABLE `promotionTiers` ADD CONSTRAINT `chk_promo_tier_min_qty` CHECK (`minQuantity` > 0)'
);
PREPARE tier_add_min_qty_chk_stmt FROM @tier_add_min_qty_chk;
EXECUTE tier_add_min_qty_chk_stmt;
DEALLOCATE PREPARE tier_add_min_qty_chk_stmt;
--> statement-breakpoint
SET @tier_drop_shape_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotionTiers'
      AND CONSTRAINT_NAME = 'chk_promo_tier_shape'
  ),
  'ALTER TABLE `promotionTiers` DROP CHECK `chk_promo_tier_shape`',
  'SELECT 1'
);
PREPARE tier_drop_shape_chk_stmt FROM @tier_drop_shape_chk;
EXECUTE tier_drop_shape_chk_stmt;
DEALLOCATE PREPARE tier_drop_shape_chk_stmt;
--> statement-breakpoint
SET @tier_add_shape_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotionTiers'
      AND CONSTRAINT_NAME = 'chk_promo_tier_shape'
  ),
  'SELECT 1',
  'ALTER TABLE `promotionTiers` ADD CONSTRAINT `chk_promo_tier_shape` CHECK (
    (`promotionTierType` = ''PERCENT'' AND `discountPercent` > 0 AND `discountPercent` <= 100 AND `discountAmount` = 0 AND `fixedPrice` IS NULL)
    OR (`promotionTierType` = ''AMOUNT'' AND `discountAmount` > 0 AND `discountPercent` = 0 AND `fixedPrice` IS NULL)
    OR (`promotionTierType` = ''FIXED_PRICE'' AND `fixedPrice` IS NOT NULL AND `fixedPrice` > 0 AND `discountPercent` = 0 AND `discountAmount` = 0)
  )'
);
PREPARE tier_add_shape_chk_stmt FROM @tier_add_shape_chk;
EXECUTE tier_add_shape_chk_stmt;
DEALLOCATE PREPARE tier_add_shape_chk_stmt;
--> statement-breakpoint
SET @promo_add_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotions'
      AND CONSTRAINT_NAME = 'chk_promo_shape'
  ),
  'SELECT 1',
  'ALTER TABLE `promotions` ADD CONSTRAINT `chk_promo_shape` CHECK (
    (promotionType = ''PERCENT'' AND discountPercent > 0 AND discountPercent <= 100 AND discountAmount = 0)
    OR (promotionType = ''AMOUNT'' AND discountPercent = 0 AND (discountAmount > 0 OR freeShipping = 1))
    OR (promotionType = ''FIXED_PRICE'' AND fixedPrice IS NOT NULL AND fixedPrice > 0)
    OR (promotionType = ''BUNDLE_PRICE'' AND bundlePrice IS NOT NULL AND bundlePrice > 0 AND promotionBundleMode IS NOT NULL AND (promotionBundleMode = ''ALL_REQUIRED'' OR (promotionBundleMode = ''PICK_ANY_N'' AND bundleQuantity IS NOT NULL AND bundleQuantity > 0)))
    OR (promotionType = ''BOGO'' AND bogoBuyQuantity IS NOT NULL AND bogoBuyQuantity > 0 AND bogoGetQuantity IS NOT NULL AND bogoGetQuantity > 0 AND bogoGetDiscountPercent IS NOT NULL AND bogoGetDiscountPercent > 0 AND bogoGetDiscountPercent <= 100)
    OR (promotionType = ''TIERED_QTY'' AND promotionTieredMode IS NOT NULL AND promotionTieredMode IN (''PER_ITEM'', ''POOL_ACROSS_TARGETS''))
    OR (promotionType = ''FREE_SHIPPING'' AND freeShipping = 1 AND discountPercent = 0 AND discountAmount = 0 AND fixedPrice IS NULL AND bundlePrice IS NULL AND promotionBundleMode IS NULL AND bundleQuantity IS NULL AND bogoBuyQuantity IS NULL AND bogoGetQuantity IS NULL AND bogoGetDiscountPercent IS NULL AND promotionTieredMode IS NULL)
  )'
);
PREPARE promo_add_stmt FROM @promo_add_chk;
EXECUTE promo_add_stmt;
DEALLOCATE PREPARE promo_add_stmt;
--> statement-breakpoint
SET @target_add_chk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'promotionTargets'
      AND CONSTRAINT_NAME = 'chk_promo_target_grain'
  ),
  'SELECT 1',
  'ALTER TABLE `promotionTargets` ADD CONSTRAINT `chk_promo_target_grain` CHECK (
    (CASE WHEN categoryId IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN productId IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN variantId IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN productUnitId IS NOT NULL THEN 1 ELSE 0 END) = 1
  )'
);
PREPARE target_add_stmt FROM @target_add_chk;
EXECUTE target_add_stmt;
DEALLOCATE PREPARE target_add_stmt;
--> statement-breakpoint
SET @inv_add_free_ship_promo = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'invoices'
      AND COLUMN_NAME = 'freeShippingPromotionId'
  ),
  'SELECT 1',
  'ALTER TABLE `invoices` ADD COLUMN `freeShippingPromotionId` bigint NULL'
);
PREPARE inv_add_free_ship_promo_stmt FROM @inv_add_free_ship_promo;
EXECUTE inv_add_free_ship_promo_stmt;
DEALLOCATE PREPARE inv_add_free_ship_promo_stmt;
--> statement-breakpoint
SET @inv_add_free_ship_promo_idx = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'invoices'
      AND INDEX_NAME = 'idx_invoice_free_shipping_promo'
  ),
  'SELECT 1',
  'ALTER TABLE `invoices` ADD INDEX `idx_invoice_free_shipping_promo` (`freeShippingPromotionId`)'
);
PREPARE inv_add_free_ship_promo_idx_stmt FROM @inv_add_free_ship_promo_idx;
EXECUTE inv_add_free_ship_promo_idx_stmt;
DEALLOCATE PREPARE inv_add_free_ship_promo_idx_stmt;
--> statement-breakpoint
SET @ord_add_free_ship_promo = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'onlineOrders'
      AND COLUMN_NAME = 'freeShippingPromotionId'
  ),
  'SELECT 1',
  'ALTER TABLE `onlineOrders` ADD COLUMN `freeShippingPromotionId` bigint NULL'
);
PREPARE ord_add_free_ship_promo_stmt FROM @ord_add_free_ship_promo;
EXECUTE ord_add_free_ship_promo_stmt;
DEALLOCATE PREPARE ord_add_free_ship_promo_stmt;
--> statement-breakpoint
SET @ord_add_free_ship_promo_idx = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'onlineOrders'
      AND INDEX_NAME = 'idx_online_order_free_shipping_promo'
  ),
  'SELECT 1',
  'ALTER TABLE `onlineOrders` ADD INDEX `idx_online_order_free_shipping_promo` (`freeShippingPromotionId`)'
);
PREPARE ord_add_free_ship_promo_idx_stmt FROM @ord_add_free_ship_promo_idx;
EXECUTE ord_add_free_ship_promo_idx_stmt;
DEALLOCATE PREPARE ord_add_free_ship_promo_idx_stmt;
