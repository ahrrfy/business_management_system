CREATE TABLE `assetCustodyLog` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`assetId` bigint NOT NULL,
	`employeeId` bigint NOT NULL,
	`fromDate` date NOT NULL,
	`toDate` date,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `assetCustodyLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `assetDocuments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`assetId` bigint NOT NULL,
	`title` varchar(255) NOT NULL,
	`fileKey` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `assetDocuments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `assetMaintenance` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`assetId` bigint NOT NULL,
	`maintDate` date NOT NULL,
	`type` varchar(255) NOT NULL,
	`vendor` varchar(255),
	`cost` decimal(15,2) NOT NULL DEFAULT '0',
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `assetMaintenance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `fixedAssets` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`code` varchar(30) NOT NULL,
	`name` varchar(255) NOT NULL,
	`assetCategory` enum('computers','display','furniture','vehicles','printing','devices') NOT NULL,
	`brand` varchar(120),
	`serial` varchar(120),
	`branchId` bigint,
	`location` varchar(255),
	`custodianId` bigint,
	`supplierId` bigint,
	`purchaseDate` date NOT NULL,
	`purchaseValue` decimal(15,2) NOT NULL,
	`salvageValue` decimal(15,2) NOT NULL DEFAULT '0',
	`usefulLifeYears` int NOT NULL,
	`depreciationMethod` enum('sl','db') NOT NULL DEFAULT 'sl',
	`condition` varchar(60),
	`warrantyEnd` date,
	`assetStatus` enum('active','maintenance','retired','disposed') NOT NULL DEFAULT 'active',
	`disposalDate` date,
	`disposalValue` decimal(15,2),
	`disposalReason` varchar(255),
	`linkedDeviceId` bigint,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `fixedAssets_id` PRIMARY KEY(`id`),
	CONSTRAINT `fixedAssets_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `assetCustodyLog` ADD CONSTRAINT `assetCustodyLog_assetId_fixedAssets_id_fk` FOREIGN KEY (`assetId`) REFERENCES `fixedAssets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assetCustodyLog` ADD CONSTRAINT `assetCustodyLog_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assetDocuments` ADD CONSTRAINT `assetDocuments_assetId_fixedAssets_id_fk` FOREIGN KEY (`assetId`) REFERENCES `fixedAssets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assetMaintenance` ADD CONSTRAINT `assetMaintenance_assetId_fixedAssets_id_fk` FOREIGN KEY (`assetId`) REFERENCES `fixedAssets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixedAssets` ADD CONSTRAINT `fixedAssets_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixedAssets` ADD CONSTRAINT `fixedAssets_custodianId_employees_id_fk` FOREIGN KEY (`custodianId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixedAssets` ADD CONSTRAINT `fixedAssets_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixedAssets` ADD CONSTRAINT `fixedAssets_linkedDeviceId_kioskDevices_id_fk` FOREIGN KEY (`linkedDeviceId`) REFERENCES `kioskDevices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_custody_asset` ON `assetCustodyLog` (`assetId`);--> statement-breakpoint
CREATE INDEX `idx_custody_employee` ON `assetCustodyLog` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_doc_asset` ON `assetDocuments` (`assetId`);--> statement-breakpoint
CREATE INDEX `idx_maint_asset` ON `assetMaintenance` (`assetId`);--> statement-breakpoint
CREATE INDEX `idx_maint_date` ON `assetMaintenance` (`maintDate`);--> statement-breakpoint
CREATE INDEX `idx_asset_code` ON `fixedAssets` (`code`);--> statement-breakpoint
CREATE INDEX `idx_asset_status` ON `fixedAssets` (`assetStatus`);--> statement-breakpoint
CREATE INDEX `idx_asset_custodian` ON `fixedAssets` (`custodianId`);--> statement-breakpoint
CREATE INDEX `idx_asset_branch` ON `fixedAssets` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_asset_category` ON `fixedAssets` (`assetCategory`);