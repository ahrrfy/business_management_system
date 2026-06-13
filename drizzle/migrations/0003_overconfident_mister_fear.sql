ALTER TABLE `productionOrders` ADD `batchQty` int;--> statement-breakpoint
ALTER TABLE `productionOrders` ADD `goodQty` int;--> statement-breakpoint
ALTER TABLE `productionOrders` ADD `scrapQty` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `productionOrders` ADD `abnormalLoss` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `productionRecipes` ADD `wasteStdPct` decimal(5,2) DEFAULT '0' NOT NULL;