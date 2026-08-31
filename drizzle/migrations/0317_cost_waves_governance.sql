CREATE TABLE `costUpdateWaves` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`reason` varchar(500) NOT NULL,
	`costWavePurpose` enum('CORRECTION','IMPAIRMENT') NOT NULL,
	`costWaveRuleType` enum('SET_COST','INCREASE_PERCENT','DECREASE_PERCENT') NOT NULL,
	`changeValue` decimal(15,4) NOT NULL,
	`scopeJson` json NOT NULL,
	`previewFingerprint` char(64) NOT NULL,
	`itemCount` int NOT NULL,
	`skippedCount` int NOT NULL DEFAULT 0,
	`expectedQuantity` int NOT NULL,
	`inventoryValueBefore` decimal(20,2) NOT NULL,
	`inventoryValueAfter` decimal(20,2) NOT NULL,
	`expectedValueDelta` decimal(20,2) NOT NULL,
	`requiredApprovals` tinyint NOT NULL DEFAULT 2,
	`approvalCount` tinyint NOT NULL DEFAULT 0,
	`costWaveStatus` enum('PENDING_APPROVAL','APPLIED','REJECTED','CONFLICTED') NOT NULL DEFAULT 'PENDING_APPROVAL',
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`appliedBy` int,
	`appliedAt` timestamp NULL,
	`rejectedBy` int,
	`rejectedAt` timestamp NULL,
	`rejectionReason` varchar(500),
	`conflictReason` varchar(1000),
	`updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `costUpdateWaves_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_costwave_approvals` CHECK (`requiredApprovals` = 2 AND `approvalCount` BETWEEN 0 AND 2),
	CONSTRAINT `chk_costwave_counts` CHECK (`itemCount` > 0 AND `skippedCount` >= 0 AND `expectedQuantity` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_costwave_status_created` ON `costUpdateWaves` (`costWaveStatus`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `idx_costwave_creator` ON `costUpdateWaves` (`createdBy`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `idx_costwave_branch` ON `costUpdateWaves` (`branchId`,`createdAt`);
--> statement-breakpoint
ALTER TABLE `costUpdateWaves` ADD CONSTRAINT `costUpdateWaves_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `costUpdateWaves` ADD CONSTRAINT `costUpdateWaves_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `costUpdateWaves` ADD CONSTRAINT `costUpdateWaves_appliedBy_users_id_fk` FOREIGN KEY (`appliedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `costUpdateWaves` ADD CONSTRAINT `costUpdateWaves_rejectedBy_users_id_fk` FOREIGN KEY (`rejectedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE `costUpdateWaveItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`waveId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productNameSnapshot` varchar(255) NOT NULL,
	`variantLabelSnapshot` varchar(255),
	`skuSnapshot` varchar(100),
	`categoryNameSnapshot` varchar(255),
	`oldCost` decimal(15,2) NOT NULL,
	`newCost` decimal(15,2) NOT NULL,
	`expectedQuantity` int NOT NULL,
	`branchQuantities` json NOT NULL,
	`inventoryValueBefore` decimal(20,2) NOT NULL,
	`inventoryValueAfter` decimal(20,2) NOT NULL,
	`expectedValueDelta` decimal(20,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `costUpdateWaveItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_costwave_item_variant` UNIQUE(`waveId`,`variantId`),
	CONSTRAINT `chk_costwave_item_values` CHECK (`oldCost` >= 0 AND `newCost` >= 0 AND `expectedQuantity` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_costwave_item_variant` ON `costUpdateWaveItems` (`variantId`);
--> statement-breakpoint
ALTER TABLE `costUpdateWaveItems` ADD CONSTRAINT `costUpdateWaveItems_waveId_costUpdateWaves_id_fk` FOREIGN KEY (`waveId`) REFERENCES `costUpdateWaves`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `costUpdateWaveItems` ADD CONSTRAINT `costUpdateWaveItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE `costUpdateWaveApprovals` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`waveId` bigint NOT NULL,
	`approverId` int NOT NULL,
	`costWaveDecision` enum('APPROVED','REJECTED') NOT NULL,
	`reason` varchar(500),
	`snapshotFingerprint` char(64) NOT NULL,
	`decidedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `costUpdateWaveApprovals_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_costwave_approval_actor` UNIQUE(`waveId`,`approverId`)
);
--> statement-breakpoint
CREATE INDEX `idx_costwave_approver` ON `costUpdateWaveApprovals` (`approverId`,`decidedAt`);
--> statement-breakpoint
ALTER TABLE `costUpdateWaveApprovals` ADD CONSTRAINT `costUpdateWaveApprovals_waveId_costUpdateWaves_id_fk` FOREIGN KEY (`waveId`) REFERENCES `costUpdateWaves`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `costUpdateWaveApprovals` ADD CONSTRAINT `costUpdateWaveApprovals_approverId_users_id_fk` FOREIGN KEY (`approverId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE `costUpdateWaveEvents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`waveId` bigint NOT NULL,
	`costWaveEventStage` enum('SUBMITTED','APPROVAL_1','APPROVAL_2','APPLIED','REJECTED','CONFLICTED') NOT NULL,
	`actorUserId` int NOT NULL,
	`snapshotFingerprint` char(64) NOT NULL,
	`snapshotJson` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `costUpdateWaveEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_costwave_event_wave_stage` ON `costUpdateWaveEvents` (`waveId`,`costWaveEventStage`,`createdAt`);
--> statement-breakpoint
ALTER TABLE `costUpdateWaveEvents` ADD CONSTRAINT `costUpdateWaveEvents_waveId_costUpdateWaves_id_fk` FOREIGN KEY (`waveId`) REFERENCES `costUpdateWaves`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `costUpdateWaveEvents` ADD CONSTRAINT `costUpdateWaveEvents_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
