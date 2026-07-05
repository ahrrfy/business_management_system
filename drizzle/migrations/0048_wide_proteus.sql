CREATE TABLE `apReminders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`supplierId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`totalUnpaidSnapshot` decimal(15,2) NOT NULL,
	`oldestPoDate` date NOT NULL,
	`daysOverdue` int NOT NULL,
	`messageBody` text NOT NULL,
	`apReminderStatus` enum('SENT','SKIPPED') NOT NULL,
	`skipReason` varchar(255),
	`promisedDate` date,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `apReminders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `apReminders` ADD CONSTRAINT `apReminders_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `apReminders` ADD CONSTRAINT `apReminders_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `apReminders` ADD CONSTRAINT `apReminders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ap_reminders_supplier_created` ON `apReminders` (`supplierId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_ap_reminders_branch_created` ON `apReminders` (`branchId`,`createdAt`);