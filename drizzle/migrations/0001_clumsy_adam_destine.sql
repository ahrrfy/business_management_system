CREATE TABLE `kioskDevices` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`label` varchar(120) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`tokenPrefix` varchar(16) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`lastSeenAt` timestamp,
	`lastSeenIp` varchar(64),
	`revokedAt` timestamp,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `kioskDevices_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_kiosk_token_hash` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `kioskDevices` ADD CONSTRAINT `kioskDevices_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `kioskDevices` ADD CONSTRAINT `kioskDevices_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_kiosk_branch` ON `kioskDevices` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_kiosk_active` ON `kioskDevices` (`isActive`);