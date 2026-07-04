CREATE TABLE `customerNotes` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`customerId` bigint NOT NULL,
	`note` text NOT NULL,
	`followUpDate` date,
	`isResolved` boolean NOT NULL DEFAULT false,
	`createdBy` int NOT NULL,
	`branchId` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customerNotes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `customerNotes` ADD CONSTRAINT `customerNotes_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `customerNotes` ADD CONSTRAINT `customerNotes_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `customerNotes` ADD CONSTRAINT `customerNotes_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_customer_notes_customer` ON `customerNotes` (`customerId`);
--> statement-breakpoint
CREATE INDEX `idx_customer_notes_followup` ON `customerNotes` (`followUpDate`,`isResolved`);
