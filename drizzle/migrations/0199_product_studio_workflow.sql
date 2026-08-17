-- مركز استوديو المنتجات: إسنادٌ محكوم، أصل/مرشّح خاصّان، ومهمة نشطة واحدة لكل منتج.
ALTER TABLE `productImageJobs` MODIFY COLUMN `mode` enum('FLATTEN','CUT','PRO','AI') NOT NULL;--> statement-breakpoint
ALTER TABLE `productImageJobs` MODIFY COLUMN `status` enum('ASSIGNED','IN_PROGRESS','PENDING_REVIEW','APPROVED','REJECTED','FAILED','REVERTED') NOT NULL DEFAULT 'PENDING_REVIEW';--> statement-breakpoint
ALTER TABLE `productImages` MODIFY COLUMN `origin` enum('ORIGINAL','STUDIO_FREE','STUDIO_PRO','STUDIO_AI','MANUAL') NOT NULL DEFAULT 'ORIGINAL';--> statement-breakpoint
ALTER TABLE `productImages` ADD `publishedStudioJobId` bigint;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `sourceImageId` bigint;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `branchId` bigint;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `sourceProductHash` varchar(64);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `originalObjectKey` varchar(255);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processedObjectKey` varchar(255);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `originalMime` varchar(32);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processedMime` varchar(32);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processedContentHash` varchar(64);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processedBytes` int;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processedWidth` int;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processedHeight` int;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `assignedTo` int;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `assignedBy` int;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `activeSlot` tinyint;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `uploadLeaseToken` varchar(64);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `uploadLeaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processingProofTokenHash` varchar(64);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processingProofMode` enum('PRO','AI');--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processingProofCandidateHash` varchar(64);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `processingProofExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `proposedName` varchar(255);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `proposedDescription` text;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `proposedMarketingCopy` text;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `rejectionReason` varchar(500);--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD `submittedAt` timestamp;--> statement-breakpoint
-- صفوف الإرث لا تُحجَز كمهام نشطة؛ المسار الجديد وحده يكتب activeSlot=1.
UPDATE `productImageJobs` SET `activeSlot` = NULL;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_source_image` FOREIGN KEY (`sourceImageId`) REFERENCES `productImages`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_assigned_to` FOREIGN KEY (`assignedTo`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_assigned_by` FOREIGN KEY (`assignedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_pijob_assignee_status` ON `productImageJobs` (`assignedTo`,`status`);--> statement-breakpoint
CREATE INDEX `idx_pijob_branch_status` ON `productImageJobs` (`branchId`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pijob_product_active` ON `productImageJobs` (`productId`,`activeSlot`);
--> statement-breakpoint
ALTER TABLE `productImages` ADD CONSTRAINT `fk_pimg_published_studio_job` FOREIGN KEY (`publishedStudioJobId`) REFERENCES `productImageJobs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE `productImageObjectStaging` (
  `objectKey` varchar(255) NOT NULL,
  `state` enum('PENDING','REFERENCED') NOT NULL DEFAULT 'PENDING',
  `touchedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `referencedAt` timestamp NULL,
  CONSTRAINT `productImageObjectStaging_objectKey` PRIMARY KEY(`objectKey`),
  INDEX `idx_piostage_state_touched` (`state`,`touchedAt`)
);--> statement-breakpoint
-- صف واحد لكل مستخدم: معدل الدقيقة عالمي بين عمال PM2 ولا ينشئ صفاً لكل طلب.
CREATE TABLE `imageStudioUserRateState` (
  `userId` int NOT NULL,
  `windowStartedAt` timestamp NOT NULL,
  `requestCount` int NOT NULL DEFAULT 0,
  `lastRequestedAt` timestamp NOT NULL,
  CONSTRAINT `imageStudioUserRateState_userId` PRIMARY KEY(`userId`),
  CONSTRAINT `fk_image_studio_rate_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);
