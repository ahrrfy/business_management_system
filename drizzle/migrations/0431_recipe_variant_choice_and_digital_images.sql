-- Additive surgical enhancements:
-- 1) productionRecipeLines.allowVariantChoice: allow cashier/designer to pick material color/variant per order.
-- 2) digitalProviders.logoUrl & digitalOfferings.imageUrl: provider logo inheritance + per-card override (served via /api/img/digital-*).
SET @ddl_0431_recipe_choice = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'productionRecipeLines'
      AND COLUMN_NAME = 'allowVariantChoice'
  ),
  'SELECT 1',
  'ALTER TABLE `productionRecipeLines` ADD COLUMN `allowVariantChoice` tinyint(1) NOT NULL DEFAULT 0'
);
PREPARE stmt_0431_recipe_choice FROM @ddl_0431_recipe_choice;
EXECUTE stmt_0431_recipe_choice;
DEALLOCATE PREPARE stmt_0431_recipe_choice;
--> statement-breakpoint
SET @ddl_0431_provider_logo = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'digitalProviders'
      AND COLUMN_NAME = 'logoUrl'
  ),
  'SELECT 1',
  'ALTER TABLE `digitalProviders` ADD COLUMN `logoUrl` mediumtext NULL'
);
PREPARE stmt_0431_provider_logo FROM @ddl_0431_provider_logo;
EXECUTE stmt_0431_provider_logo;
DEALLOCATE PREPARE stmt_0431_provider_logo;
--> statement-breakpoint
SET @ddl_0431_offering_image = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'digitalOfferings'
      AND COLUMN_NAME = 'imageUrl'
  ),
  'SELECT 1',
  'ALTER TABLE `digitalOfferings` ADD COLUMN `imageUrl` mediumtext NULL'
);
PREPARE stmt_0431_offering_image FROM @ddl_0431_offering_image;
EXECUTE stmt_0431_offering_image;
DEALLOCATE PREPARE stmt_0431_offering_image;
--> statement-breakpoint
SET @ddl_0431_item_selections = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'invoiceItems'
      AND COLUMN_NAME = 'recipeSelections'
  ),
  'SELECT 1',
  'ALTER TABLE `invoiceItems` ADD COLUMN `recipeSelections` json NULL'
);
PREPARE stmt_0431_item_selections FROM @ddl_0431_item_selections;
EXECUTE stmt_0431_item_selections;
DEALLOCATE PREPARE stmt_0431_item_selections;
