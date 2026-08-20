-- حملات Product Studio: تجميع آمن لمهام المنتجات الناقصة دون إسناد أو نشر تلقائي.
SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE `productStudioCampaigns` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(180) NOT NULL,
  `branchId` BIGINT NOT NULL,
  `status` ENUM('DRAFT','ACTIVE','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  `startsAt` TIMESTAMP NULL,
  `dueAt` TIMESTAMP NULL,
  `createdBy` INT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_pscampaign_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_pscampaign_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  INDEX `idx_pscampaign_branch_status` (`branchId`, `status`),
  INDEX `idx_pscampaign_branch_due` (`branchId`, `dueAt`)
);
--> statement-breakpoint

ALTER TABLE `productImageJobs`
  ADD COLUMN `campaignId` BIGINT NULL AFTER `variantId`,
  ADD CONSTRAINT `fk_pijob_campaign`
    FOREIGN KEY (`campaignId`) REFERENCES `productStudioCampaigns` (`id`) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX `idx_pijob_campaign_status`
  ON `productImageJobs` (`campaignId`, `status`);
