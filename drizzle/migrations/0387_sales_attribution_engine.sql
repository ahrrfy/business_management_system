ALTER TABLE `invoices` ADD COLUMN `salesRepId` int;
--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_salesRepId_users_id_fk` FOREIGN KEY (`salesRepId`) REFERENCES `users`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `attributionMode` enum('DIRECT','SPLIT','POOL') NOT NULL DEFAULT 'DIRECT';
--> statement-breakpoint
CREATE INDEX `idx_invoice_sales_rep_date` ON `invoices` (`salesRepId`, `invoiceDate`);
--> statement-breakpoint
ALTER TABLE `receptionDrafts` ADD COLUMN `salesRepId` int;
--> statement-breakpoint
ALTER TABLE `receptionDrafts` ADD CONSTRAINT `receptionDrafts_salesRepId_users_id_fk` FOREIGN KEY (`salesRepId`) REFERENCES `users`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE `invoiceAttributions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`invoiceId` bigint NOT NULL,
	`userId` int NOT NULL,
	`role` enum('FLOOR_REP','RECEPTIONIST','CASHIER','FULFILLER') NOT NULL,
	`attributionMode` enum('DIRECT','SPLIT','POOL') NOT NULL DEFAULT 'DIRECT',
	`sharePct` decimal(5,4) NOT NULL DEFAULT '1.0000',
	`creditedBaseAmount` decimal(15,2) NOT NULL,
	`teamPoolId` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoiceAttributions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `invoiceAttributions` ADD CONSTRAINT `invoiceAttributions_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE `invoiceAttributions` ADD CONSTRAINT `invoiceAttributions_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `invoiceAttributions` ADD CONSTRAINT `invoiceAttributions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX `idx_inv_attr_branch_invoice` ON `invoiceAttributions` (`branchId`, `invoiceId`);
--> statement-breakpoint
CREATE INDEX `idx_inv_attr_user_created_at` ON `invoiceAttributions` (`userId`, `createdAt`);
--> statement-breakpoint
CREATE INDEX `idx_inv_attr_invoice` ON `invoiceAttributions` (`invoiceId`);
