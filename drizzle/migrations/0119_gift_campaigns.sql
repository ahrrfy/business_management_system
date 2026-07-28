-- ربط حملة الهدايا (G-م٧، ٢٨/٧/٢٦) — جدول `giftCampaigns` + عمود `campaignId` على `giftVouchers` (nullable،
-- للصادر فقط دلالياً). ميزانية اختيارية (`budgetCost`) تُفرَض بقفلٍ تسلسليّ (نمط قفل ATP في الحجوزات):
-- تجاوزها ⇒ الهدية PENDING_APPROVAL دائماً (حتى للمدير)، تماماً كتجاوز عتبة التكلفة العامة.
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE `giftCampaigns` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`reason` varchar(255),
	`startDate` date,
	`endDate` date,
	`budgetCost` decimal(15,2),
	`status` enum('ACTIVE','CLOSED') NOT NULL DEFAULT 'ACTIVE',
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `giftCampaigns_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_gift_campaign_name` UNIQUE(`name`),
	CONSTRAINT `giftCampaigns_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
ALTER TABLE `giftVouchers` ADD COLUMN `campaignId` bigint;
--> statement-breakpoint
ALTER TABLE `giftVouchers` ADD CONSTRAINT `giftVouchers_campaignId_giftCampaigns_id_fk` FOREIGN KEY (`campaignId`) REFERENCES `giftCampaigns`(`id`);
--> statement-breakpoint
CREATE INDEX `idx_gift_campaign` ON `giftVouchers` (`campaignId`);
