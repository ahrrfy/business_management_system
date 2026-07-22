-- محرّك تسعير الطباعة الرقمية (Digital) — البند⑥ الطبقة٢. المطبعة ديجيتال لا أوفست (قرار المالك
-- ٢٢/٧): الوحدة = الوجه المطبوع (الورق مشمول في سعره)، والعريض (فلكس) بالمتر المربّع. كل الأرقام
-- إعداداتٌ يملؤها المالك. ٥ جداول: الإعدادات المفردة + سعر الوجه (مقاس×نمط) + الورق المميّز +
-- الوسائط العريضة + خيارات التشطيب. راجع shared/printPricing.ts + server/services/printPricing.
CREATE TABLE `printPricingSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pricingMode` enum('MARGIN','DIRECT') NOT NULL DEFAULT 'MARGIN',
	`defaultMarginPercent` decimal(6,3) NOT NULL DEFAULT '0',
	`setupFee` decimal(15,2) NOT NULL DEFAULT '0',
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `printPricingSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `printFacePrices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`paperSize` enum('A0','A1','A2','A3','A4','A5','A6','A7','A8','A9','A10','B0','B1','B2','B3','B4','B5','B6','B7','B8','B9','B10') NOT NULL,
	`colorMode` enum('COLOR','BW') NOT NULL,
	`pricePerFace` decimal(15,2) NOT NULL,
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `printFacePrices_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_print_face_price` UNIQUE(`paperSize`,`colorMode`)
);
--> statement-breakpoint
CREATE TABLE `printPaperUpcharges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`unit` enum('PER_FACE','PER_SHEET') NOT NULL DEFAULT 'PER_SHEET',
	`upcharge` decimal(15,2) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `printPaperUpcharges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `printWideMedia` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`pricePerSqm` decimal(15,2) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `printWideMedia_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `printFinishingOptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`unit` enum('PER_COPY','PER_JOB') NOT NULL DEFAULT 'PER_COPY',
	`price` decimal(15,2) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `printFinishingOptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `printPricingSettings` ADD CONSTRAINT `fk_printprice_settings_user` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `printFacePrices` ADD CONSTRAINT `fk_printprice_face_user` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
