-- بند 12أ (٧/٧): الأقساط والشيكات الآجلة — خطة تحصيل مجدولة فوق ذمّة العميل (لا قيد عند الإنشاء؛
-- سداد القسط يمرّ بسند قبض حقيقي). الشيك الآجل = قسط kind=CHECK برقم شيك ومصرف.
CREATE TABLE `installmentPlans` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`customerId` bigint NOT NULL,
	`invoiceId` bigint,
	`branchId` bigint NOT NULL,
	`totalAmount` decimal(15,2) NOT NULL,
	`downPayment` decimal(15,2) NOT NULL DEFAULT '0',
	`planStatus` enum('ACTIVE','COMPLETED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`notes` text,
	`createdBy` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `installmentPlans_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
CREATE INDEX `idx_instplan_customer` ON `installmentPlans` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_instplan_branch_status` ON `installmentPlans` (`branchId`,`planStatus`);--> statement-breakpoint
CREATE TABLE `installmentLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`planId` bigint NOT NULL,
	`seq` int NOT NULL,
	`dueDate` date NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`lineKind` enum('CASH','CHECK') NOT NULL DEFAULT 'CASH',
	`checkNumber` varchar(60),
	`bankName` varchar(100),
	`lineStatus` enum('PENDING','PAID','BOUNCED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`receiptId` bigint,
	`paidAt` timestamp,
	`note` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `installmentLines_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
CREATE INDEX `idx_instline_plan` ON `installmentLines` (`planId`);--> statement-breakpoint
CREATE INDEX `idx_instline_due_status` ON `installmentLines` (`dueDate`,`lineStatus`);--> statement-breakpoint
ALTER TABLE `installmentLines` ADD CONSTRAINT `fk_instline_plan` FOREIGN KEY (`planId`) REFERENCES `installmentPlans`(`id`) ON DELETE CASCADE;
