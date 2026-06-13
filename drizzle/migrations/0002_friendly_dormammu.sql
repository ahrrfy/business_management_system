CREATE TABLE `expenseStockItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`expenseId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint,
	`quantity` decimal(15,4) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitCost` decimal(15,2) NOT NULL DEFAULT '0',
	`lineCost` decimal(15,2) NOT NULL DEFAULT '0',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `expenseStockItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `productionLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`productionOrderId` bigint NOT NULL,
	`productionLineDirection` enum('INPUT','OUTPUT') NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint,
	`quantity` decimal(15,4) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitCost` decimal(15,2) NOT NULL DEFAULT '0',
	`lineCost` decimal(15,2) NOT NULL DEFAULT '0',
	`allocatedCost` decimal(15,2),
	`manualSharePct` decimal(9,4),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `productionLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `productionOrders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`docNumber` varchar(50) NOT NULL,
	`branchId` bigint NOT NULL,
	`productionStatus` enum('CONFIRMED','CANCELLED') NOT NULL DEFAULT 'CONFIRMED',
	`materialsCost` decimal(15,2) NOT NULL DEFAULT '0',
	`laborCost` decimal(15,2) NOT NULL DEFAULT '0',
	`totalCost` decimal(15,2) NOT NULL DEFAULT '0',
	`notes` text,
	`linkedWorkOrderId` bigint,
	`linkedRecipeId` bigint,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productionOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_production_docnum` UNIQUE(`docNumber`)
);
--> statement-breakpoint
CREATE TABLE `productionRecipeLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`recipeId` bigint NOT NULL,
	`inputVariantId` bigint NOT NULL,
	`inputProductUnitId` bigint,
	`qtyPerOutputBase` decimal(15,4) NOT NULL,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `productionRecipeLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `productionRecipes` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(150) NOT NULL,
	`outputVariantId` bigint NOT NULL,
	`outputProductUnitId` bigint NOT NULL,
	`laborPerOutputBase` decimal(15,2) NOT NULL DEFAULT '0',
	`notes` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productionRecipes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_recipe_name` UNIQUE(`name`)
);
--> statement-breakpoint
ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE','WASTAGE') NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `expenseSource` enum('CASH','STOCK') DEFAULT 'CASH' NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `expenseStockReason` enum('INTERNAL_USE','WASTAGE');--> statement-breakpoint
ALTER TABLE `expenseStockItems` ADD CONSTRAINT `expenseStockItems_expenseId_expenses_id_fk` FOREIGN KEY (`expenseId`) REFERENCES `expenses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenseStockItems` ADD CONSTRAINT `expenseStockItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenseStockItems` ADD CONSTRAINT `expenseStockItems_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionLines` ADD CONSTRAINT `productionLines_productionOrderId_productionOrders_id_fk` FOREIGN KEY (`productionOrderId`) REFERENCES `productionOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionLines` ADD CONSTRAINT `productionLines_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionLines` ADD CONSTRAINT `productionLines_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionOrders` ADD CONSTRAINT `productionOrders_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionOrders` ADD CONSTRAINT `productionOrders_linkedWorkOrderId_workOrders_id_fk` FOREIGN KEY (`linkedWorkOrderId`) REFERENCES `workOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionOrders` ADD CONSTRAINT `productionOrders_linkedRecipeId_productionRecipes_id_fk` FOREIGN KEY (`linkedRecipeId`) REFERENCES `productionRecipes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionOrders` ADD CONSTRAINT `productionOrders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionRecipeLines` ADD CONSTRAINT `productionRecipeLines_recipeId_productionRecipes_id_fk` FOREIGN KEY (`recipeId`) REFERENCES `productionRecipes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionRecipeLines` ADD CONSTRAINT `productionRecipeLines_inputVariantId_productVariants_id_fk` FOREIGN KEY (`inputVariantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionRecipeLines` ADD CONSTRAINT `productionRecipeLines_inputProductUnitId_productUnits_id_fk` FOREIGN KEY (`inputProductUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionRecipes` ADD CONSTRAINT `productionRecipes_outputVariantId_productVariants_id_fk` FOREIGN KEY (`outputVariantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionRecipes` ADD CONSTRAINT `productionRecipes_outputProductUnitId_productUnits_id_fk` FOREIGN KEY (`outputProductUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productionRecipes` ADD CONSTRAINT `productionRecipes_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_expitem_expense` ON `expenseStockItems` (`expenseId`);--> statement-breakpoint
CREATE INDEX `idx_expitem_variant` ON `expenseStockItems` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_productionline_order` ON `productionLines` (`productionOrderId`);--> statement-breakpoint
CREATE INDEX `idx_productionline_variant` ON `productionLines` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_productionline_direction` ON `productionLines` (`productionLineDirection`);--> statement-breakpoint
CREATE INDEX `idx_production_number` ON `productionOrders` (`docNumber`);--> statement-breakpoint
CREATE INDEX `idx_production_branch` ON `productionOrders` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_production_status` ON `productionOrders` (`productionStatus`);--> statement-breakpoint
CREATE INDEX `idx_recipeline_recipe` ON `productionRecipeLines` (`recipeId`);--> statement-breakpoint
CREATE INDEX `idx_recipeline_input` ON `productionRecipeLines` (`inputVariantId`);--> statement-breakpoint
CREATE INDEX `idx_recipe_output` ON `productionRecipes` (`outputVariantId`);--> statement-breakpoint
CREATE INDEX `idx_recipe_active` ON `productionRecipes` (`isActive`);