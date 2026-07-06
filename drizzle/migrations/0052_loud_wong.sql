CREATE TABLE `commissionAssignments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`planId` bigint NOT NULL,
	`effectiveFrom` varchar(7) NOT NULL,
	`effectiveTo` varchar(7),
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `commissionAssignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `commissionPlanTiers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`planId` bigint NOT NULL,
	`sort` int NOT NULL,
	`threshold` decimal(15,2) NOT NULL,
	`ratePct` decimal(7,4) NOT NULL DEFAULT '0',
	`fixedBonus` decimal(15,2) NOT NULL DEFAULT '0',
	CONSTRAINT `commissionPlanTiers_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ctier_plan_sort` UNIQUE(`planId`,`sort`),
	CONSTRAINT `uq_ctier_plan_threshold` UNIQUE(`planId`,`threshold`)
);
--> statement-breakpoint
CREATE TABLE `commissionPlans` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`commissionBasis` enum('NET_SALES','COLLECTED','PROFIT') NOT NULL DEFAULT 'NET_SALES',
	`commissionTierMode` enum('TARGET_PCT','AMOUNT_SLAB') NOT NULL DEFAULT 'TARGET_PCT',
	`isActive` boolean NOT NULL DEFAULT true,
	`notes` varchar(255),
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `commissionPlans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `commissionRunLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`runId` bigint NOT NULL,
	`employeeId` bigint NOT NULL,
	`userId` int NOT NULL,
	`branchId` bigint,
	`baseSales` decimal(15,2) NOT NULL DEFAULT '0',
	`baseReturns` decimal(15,2) NOT NULL DEFAULT '0',
	`carryIn` decimal(15,2) NOT NULL DEFAULT '0',
	`effectiveBase` decimal(15,2) NOT NULL DEFAULT '0',
	`carryOut` decimal(15,2) NOT NULL DEFAULT '0',
	`targetAmount` decimal(15,2),
	`achievementPct` decimal(9,2),
	`planId` bigint NOT NULL,
	`tierIndex` int,
	`ratePct` decimal(7,4) NOT NULL DEFAULT '0',
	`fixedBonus` decimal(15,2) NOT NULL DEFAULT '0',
	`commissionAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`detail` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `commissionRunLines_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_cline_run_emp` UNIQUE(`runId`,`employeeId`)
);
--> statement-breakpoint
CREATE TABLE `commissionRuns` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`period` varchar(7) NOT NULL,
	`commissionRunStatus` enum('draft','approved') NOT NULL DEFAULT 'draft',
	`employeeCount` int NOT NULL DEFAULT 0,
	`totalBaseSales` decimal(15,2) NOT NULL DEFAULT '0',
	`totalBaseReturns` decimal(15,2) NOT NULL DEFAULT '0',
	`totalCommission` decimal(15,2) NOT NULL DEFAULT '0',
	`payrollRunId` bigint,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	`notes` text,
	`createdBy` int,
	`approvedBy` int,
	`approvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `commissionRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_commission_period` UNIQUE(`period`)
);
--> statement-breakpoint
CREATE TABLE `salesTargets` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`period` varchar(7) NOT NULL,
	`targetAmount` decimal(15,2) NOT NULL,
	`notes` varchar(255),
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `salesTargets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_target_emp_period` UNIQUE(`employeeId`,`period`)
);
--> statement-breakpoint
ALTER TABLE `payrollItems` ADD `commission` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD `totalCommission` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `workOrders` ADD CONSTRAINT `uq_wo_invoice` UNIQUE(`invoiceId`);--> statement-breakpoint
ALTER TABLE `commissionAssignments` ADD CONSTRAINT `commissionAssignments_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionAssignments` ADD CONSTRAINT `commissionAssignments_planId_commissionPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `commissionPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionAssignments` ADD CONSTRAINT `commissionAssignments_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionPlanTiers` ADD CONSTRAINT `commissionPlanTiers_planId_commissionPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `commissionPlans`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionPlans` ADD CONSTRAINT `commissionPlans_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionRunLines` ADD CONSTRAINT `commissionRunLines_runId_commissionRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `commissionRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionRunLines` ADD CONSTRAINT `commissionRunLines_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionRunLines` ADD CONSTRAINT `commissionRunLines_planId_commissionPlans_id_fk` FOREIGN KEY (`planId`) REFERENCES `commissionPlans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionRuns` ADD CONSTRAINT `commissionRuns_payrollRunId_payrollRuns_id_fk` FOREIGN KEY (`payrollRunId`) REFERENCES `payrollRuns`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionRuns` ADD CONSTRAINT `commissionRuns_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commissionRuns` ADD CONSTRAINT `commissionRuns_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `salesTargets` ADD CONSTRAINT `salesTargets_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `salesTargets` ADD CONSTRAINT `salesTargets_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_cassign_emp_from` ON `commissionAssignments` (`employeeId`,`effectiveFrom`);--> statement-breakpoint
CREATE INDEX `idx_cassign_plan` ON `commissionAssignments` (`planId`);--> statement-breakpoint
CREATE INDEX `idx_cplan_active` ON `commissionPlans` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_cline_emp` ON `commissionRunLines` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_commission_status` ON `commissionRuns` (`commissionRunStatus`);--> statement-breakpoint
CREATE INDEX `idx_target_period` ON `salesTargets` (`period`);--> statement-breakpoint
CREATE INDEX `idx_entry_type_date` ON `accountingEntries` (`entryType`,`entryDate`);