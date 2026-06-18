CREATE TABLE `cashBuckets` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`kind` enum('DRAWER','TREASURY','BANK','SAFE') NOT NULL,
	`branchId` bigint NOT NULL,
	`ownerUserId` int,
	`shiftId` bigint,
	`name` varchar(120) NOT NULL,
	`currentBalance` decimal(15,2) NOT NULL DEFAULT '0',
	`version` int NOT NULL DEFAULT 1,
	`isActive` boolean NOT NULL DEFAULT true,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cashBuckets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `receipts` ADD `bucketId` bigint;--> statement-breakpoint
ALTER TABLE `receipts` ADD `pairToken` varchar(64);--> statement-breakpoint
ALTER TABLE `receipts` ADD `balanceAfter` decimal(15,2);--> statement-breakpoint
CREATE INDEX `idx_bucket_branch_kind` ON `cashBuckets` (`branchId`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_bucket_shift` ON `cashBuckets` (`shiftId`);--> statement-breakpoint
CREATE INDEX `idx_bucket_active` ON `cashBuckets` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_receipt_bucket` ON `receipts` (`bucketId`);--> statement-breakpoint
CREATE INDEX `idx_receipt_pair` ON `receipts` (`pairToken`);