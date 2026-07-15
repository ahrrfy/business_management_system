-- 0076: CRM — حملات تجارية موحّدة + عروض تُفعَّل تلقائياً أو بكوبون + إصدار/استرداد كوبونات.
-- إضافية بالكامل: لا تغيّر سلوك العروض القديمة (AUTO افتراضياً) ولا تمسّ الفواتير التاريخية.

CREATE TABLE IF NOT EXISTS `crmCampaigns` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `name` varchar(255) NOT NULL,
  `objective` text,
  `crmCampaignStatus` enum('DRAFT','REVIEW','APPROVED','SCHEDULED','ACTIVE','PAUSED','ENDED') NOT NULL DEFAULT 'DRAFT',
  `branchId` bigint,
  `startsOn` date,
  `endsOn` date,
  `ownerUserId` int,
  `approvedBy` int,
  `approvedAt` timestamp NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `crmCampaigns_id` PRIMARY KEY(`id`),
  CONSTRAINT `crmCampaigns_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL,
  CONSTRAINT `crmCampaigns_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `crmCampaigns_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `crmCampaigns_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
  INDEX `idx_crm_campaign_branch_status` (`branchId`,`crmCampaignStatus`),
  INDEX `idx_crm_campaign_dates` (`startsOn`,`endsOn`)
);
--> statement-breakpoint
ALTER TABLE `promotions`
  ADD COLUMN `campaignId` bigint NULL,
  ADD COLUMN `promotionApplicationMode` enum('AUTO','COUPON') NOT NULL DEFAULT 'AUTO',
  ADD CONSTRAINT `promotions_campaignId_crmCampaigns_id_fk` FOREIGN KEY (`campaignId`) REFERENCES `crmCampaigns`(`id`) ON DELETE SET NULL,
  ADD INDEX `idx_promo_campaign` (`campaignId`),
  ADD INDEX `idx_promo_application` (`promotionApplicationMode`,`isActive`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `couponPrograms` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `campaignId` bigint,
  `promotionId` bigint NOT NULL,
  `name` varchar(255) NOT NULL,
  `couponProgramStatus` enum('DRAFT','ACTIVE','PAUSED','ENDED') NOT NULL DEFAULT 'DRAFT',
  `branchId` bigint,
  `validFrom` date NOT NULL,
  `validTo` date,
  `perCouponLimit` int NOT NULL DEFAULT 1,
  `perCustomerLimit` int NOT NULL DEFAULT 1,
  `codePrefix` varchar(12) NOT NULL DEFAULT 'CRM',
  `designJson` json,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `couponPrograms_id` PRIMARY KEY(`id`),
  CONSTRAINT `couponPrograms_campaignId_crmCampaigns_id_fk` FOREIGN KEY (`campaignId`) REFERENCES `crmCampaigns`(`id`) ON DELETE SET NULL,
  CONSTRAINT `couponPrograms_promotionId_promotions_id_fk` FOREIGN KEY (`promotionId`) REFERENCES `promotions`(`id`),
  CONSTRAINT `couponPrograms_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL,
  CONSTRAINT `couponPrograms_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
  INDEX `idx_coupon_program_campaign` (`campaignId`),
  INDEX `idx_coupon_program_promo` (`promotionId`),
  INDEX `idx_coupon_program_branch_status` (`branchId`,`couponProgramStatus`),
  INDEX `idx_coupon_program_dates` (`validFrom`,`validTo`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `coupons` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `programId` bigint NOT NULL,
  `code` varchar(64) NOT NULL,
  `codeHash` varchar(64) NOT NULL,
  `customerId` bigint,
  `couponStatus` enum('ACTIVE','REDEEMED','VOID') NOT NULL DEFAULT 'ACTIVE',
  `redemptionCount` int NOT NULL DEFAULT 0,
  `issuedAt` timestamp NOT NULL DEFAULT (now()),
  `voidedAt` timestamp NULL,
  `voidedBy` int,
  CONSTRAINT `coupons_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_coupon_code` UNIQUE(`code`),
  CONSTRAINT `uq_coupon_hash` UNIQUE(`codeHash`),
  CONSTRAINT `coupons_programId_couponPrograms_id_fk` FOREIGN KEY (`programId`) REFERENCES `couponPrograms`(`id`) ON DELETE CASCADE,
  CONSTRAINT `coupons_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE SET NULL,
  CONSTRAINT `coupons_voidedBy_users_id_fk` FOREIGN KEY (`voidedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX `idx_coupon_program` (`programId`),
  INDEX `idx_coupon_customer` (`customerId`),
  INDEX `idx_coupon_status` (`couponStatus`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `couponRedemptions` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `couponId` bigint NOT NULL,
  `programId` bigint NOT NULL,
  `invoiceId` bigint NOT NULL,
  `customerId` bigint,
  `branchId` bigint NOT NULL,
  `discountAmount` decimal(15,2) NOT NULL,
  `redeemedBy` int NOT NULL,
  `redeemedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `couponRedemptions_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_coupon_redemption_invoice` UNIQUE(`invoiceId`),
  CONSTRAINT `uq_coupon_redemption_coupon_invoice` UNIQUE(`couponId`,`invoiceId`),
  CONSTRAINT `couponRedemptions_couponId_coupons_id_fk` FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`),
  CONSTRAINT `couponRedemptions_programId_couponPrograms_id_fk` FOREIGN KEY (`programId`) REFERENCES `couponPrograms`(`id`),
  CONSTRAINT `couponRedemptions_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`),
  CONSTRAINT `couponRedemptions_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE SET NULL,
  CONSTRAINT `couponRedemptions_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `couponRedemptions_redeemedBy_users_id_fk` FOREIGN KEY (`redeemedBy`) REFERENCES `users`(`id`),
  INDEX `idx_coupon_redemption_program_customer` (`programId`,`customerId`),
  INDEX `idx_coupon_redemption_at` (`redeemedAt`)
);
