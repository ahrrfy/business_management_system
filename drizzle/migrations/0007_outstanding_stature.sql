CREATE TABLE `employeePromotions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`fromTitle` varchar(150),
	`toTitle` varchar(150) NOT NULL,
	`fromSalary` decimal(15,2),
	`toSalary` decimal(15,2),
	`effectiveDate` date NOT NULL,
	`reason` varchar(255),
	`promotionStatus` enum('pending','approved') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`approvedAt` timestamp,
	`approvedBy` int,
	CONSTRAINT `employeePromotions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `employeeTerminations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`terminationType` varchar(30) NOT NULL,
	`lastDay` date NOT NULL,
	`settlement` decimal(15,2) NOT NULL DEFAULT '0',
	`reason` varchar(255),
	`terminationStatus` enum('pending','completed') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `employeeTerminations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `hrFingerprintDevices` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(200) NOT NULL,
	`model` varchar(120),
	`location` varchar(200),
	`branchId` bigint,
	`deviceCode` varchar(60),
	`ip` varchar(64),
	`port` int,
	`serverHost` varchar(120),
	`serverPort` int,
	`migrated` boolean NOT NULL DEFAULT false,
	`status` varchar(12) DEFAULT 'offline',
	`usersCount` int DEFAULT 0,
	`recordsCount` int DEFAULT 0,
	`firmware` varchar(60),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `hrFingerprintDevices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobApplicants` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(200) NOT NULL,
	`jobTitle` varchar(150),
	`source` varchar(20) NOT NULL DEFAULT 'external',
	`applicantStage` enum('new','review','interview','accepted','rejected','archived') NOT NULL DEFAULT 'new',
	`appliedDate` date,
	`phone` varchar(20),
	`email` varchar(120),
	`experience` varchar(120),
	`education` varchar(200),
	`rating` int DEFAULT 0,
	`notes` text,
	`cvFileKey` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `jobApplicants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `leaveRequests` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`leaveType` varchar(30) NOT NULL,
	`paid` boolean NOT NULL DEFAULT true,
	`fromDate` date NOT NULL,
	`toDate` date NOT NULL,
	`days` int NOT NULL,
	`leaveStatus` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`reason` text,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`decidedBy` int,
	`decidedAt` timestamp,
	CONSTRAINT `leaveRequests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payrollItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`runId` bigint NOT NULL,
	`employeeId` bigint NOT NULL,
	`payType` varchar(10) NOT NULL,
	`hours` decimal(8,2),
	`gross` decimal(15,2) NOT NULL DEFAULT '0',
	`allowances` decimal(15,2) NOT NULL DEFAULT '0',
	`overtime` decimal(15,2) NOT NULL DEFAULT '0',
	`deductions` decimal(15,2) NOT NULL DEFAULT '0',
	`net` decimal(15,2) NOT NULL DEFAULT '0',
	`note` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payrollItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payrollRuns` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`period` varchar(7) NOT NULL,
	`branchId` bigint,
	`payrollStatus` enum('draft','approved','paid') NOT NULL DEFAULT 'draft',
	`employeeCount` int NOT NULL DEFAULT 0,
	`totalGross` decimal(15,2) NOT NULL DEFAULT '0',
	`totalOvertime` decimal(15,2) NOT NULL DEFAULT '0',
	`totalDeductions` decimal(15,2) NOT NULL DEFAULT '0',
	`totalNet` decimal(15,2) NOT NULL DEFAULT '0',
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`approvedAt` timestamp,
	`paidAt` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payrollRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_payroll_period` UNIQUE(`period`)
);
--> statement-breakpoint
ALTER TABLE `attendance` ADD `hours` decimal(6,2);--> statement-breakpoint
ALTER TABLE `attendance` ADD `hourlyRate` decimal(15,2);--> statement-breakpoint
ALTER TABLE `attendance` ADD `amount` decimal(15,2);--> statement-breakpoint
ALTER TABLE `attendance` ADD `source` varchar(20) DEFAULT 'fingerprint';--> statement-breakpoint
ALTER TABLE `employeePromotions` ADD CONSTRAINT `employeePromotions_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeePromotions` ADD CONSTRAINT `employeePromotions_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeeTerminations` ADD CONSTRAINT `employeeTerminations_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD CONSTRAINT `hrFingerprintDevices_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leaveRequests` ADD CONSTRAINT `leaveRequests_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leaveRequests` ADD CONSTRAINT `leaveRequests_decidedBy_users_id_fk` FOREIGN KEY (`decidedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollItems` ADD CONSTRAINT `payrollItems_runId_payrollRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `payrollRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollItems` ADD CONSTRAINT `payrollItems_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_promo_emp` ON `employeePromotions` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_term_emp` ON `employeeTerminations` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_fpdev_migrated` ON `hrFingerprintDevices` (`migrated`);--> statement-breakpoint
CREATE INDEX `idx_applicant_stage` ON `jobApplicants` (`applicantStage`);--> statement-breakpoint
CREATE INDEX `idx_leave_emp` ON `leaveRequests` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_leave_status` ON `leaveRequests` (`leaveStatus`);--> statement-breakpoint
CREATE INDEX `idx_payitem_run` ON `payrollItems` (`runId`);--> statement-breakpoint
CREATE INDEX `idx_payitem_emp` ON `payrollItems` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_payroll_status` ON `payrollRuns` (`payrollStatus`);