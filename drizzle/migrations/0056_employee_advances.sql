-- بند 12ج (٧/٧): سلف الموظفين — تُمنح بسند صرف حقيقي وتُخصم تلقائياً من تشغيلات الرواتب
-- (payrollItems.advanceDeduction جزء من deductions لا إضافة عليها) حتى التسوية.
CREATE TABLE `employeeAdvances` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`remaining` decimal(15,2) NOT NULL,
	`monthlyDeduction` decimal(15,2),
	`advanceStatus` enum('ACTIVE','SETTLED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`receiptId` bigint,
	`note` varchar(255),
	`createdBy` bigint NOT NULL,
	`grantedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeAdvances_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
CREATE INDEX `idx_advance_emp_status` ON `employeeAdvances` (`employeeId`,`advanceStatus`);--> statement-breakpoint
ALTER TABLE `payrollItems` ADD `advanceDeduction` decimal(15,2) NOT NULL DEFAULT '0';
