CREATE TABLE `employeeDocuments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`documentType` enum('PASSPORT','RESIDENCY_VISA','WORK_PERMIT','NATIONAL_ID','HEALTH_CERTIFICATE','EDUCATION_CERTIFICATE','CONTRACT_SCAN','OTHER') NOT NULL,
	`title` varchar(200) NOT NULL,
	`documentNumber` varchar(100),
	`issueDate` date,
	`expiryDate` date,
	`fileUrl` mediumtext,
	`fileSize` int,
	`mimeType` varchar(100),
	`notes` text,
	`status` enum('ACTIVE','EXPIRED','EXPIRING_SOON') NOT NULL DEFAULT 'ACTIVE',
	`alertDaysBefore` int NOT NULL DEFAULT 30,
	`createdById` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeDocuments_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_emp_doc_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_doc_creator` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `idx_emp_doc_employee` ON `employeeDocuments` (`employeeId`);
--> statement-breakpoint
CREATE INDEX `idx_emp_doc_type` ON `employeeDocuments` (`documentType`);
--> statement-breakpoint
CREATE INDEX `idx_emp_doc_expiry` ON `employeeDocuments` (`expiryDate`);
--> statement-breakpoint
CREATE INDEX `idx_emp_doc_status` ON `employeeDocuments` (`status`);
--> statement-breakpoint
CREATE TABLE `employeePenalties` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`branchId` bigint,
	`penaltyType` enum('ATTENTION','WARNING','SALARY_DEDUCTION','SUSPENSION','DISMISSAL') NOT NULL,
	`decisionNumber` varchar(100) NOT NULL,
	`decisionDate` date NOT NULL,
	`reason` text NOT NULL,
	`deductionDays` decimal(5,2) NOT NULL DEFAULT '0.00',
	`deductionAmount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`payrollRunId` bigint,
	`status` enum('DRAFT','APPROVED','APPLIED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`approvedById` int,
	`approvedAt` timestamp,
	`createdById` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeePenalties_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_emp_penalty_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_penalty_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_penalty_payroll_run` FOREIGN KEY (`payrollRunId`) REFERENCES `payrollRuns`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_penalty_creator` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_penalty_approver` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `idx_emp_penalty_employee` ON `employeePenalties` (`employeeId`);
--> statement-breakpoint
CREATE INDEX `idx_emp_penalty_status` ON `employeePenalties` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_emp_penalty_payroll_run` ON `employeePenalties` (`payrollRunId`);
--> statement-breakpoint
CREATE TABLE `employeeContracts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`branchId` bigint,
	`contractType` enum('FIXED_TERM','INDEFINITE','PROBATION','SEASONAL') NOT NULL DEFAULT 'FIXED_TERM',
	`contractNumber` varchar(100),
	`startDate` date NOT NULL,
	`endDate` date,
	`probationEndDate` date,
	`jobTitle` varchar(150),
	`basicSalary` decimal(15,2),
	`allowances` decimal(15,2) DEFAULT '0.00',
	`terms` text,
	`status` enum('DRAFT','ACTIVE','RENEWED','TERMINATED','EXPIRED') NOT NULL DEFAULT 'DRAFT',
	`fileUrl` mediumtext,
	`createdById` int NOT NULL,
	`approvedById` int,
	`approvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeContracts_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_emp_contract_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_contract_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_contract_creator` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_contract_approver` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `idx_emp_contract_employee` ON `employeeContracts` (`employeeId`);
--> statement-breakpoint
CREATE INDEX `idx_emp_contract_status` ON `employeeContracts` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_emp_contract_probation` ON `employeeContracts` (`probationEndDate`);
--> statement-breakpoint
CREATE INDEX `idx_emp_contract_end` ON `employeeContracts` (`endDate`);
--> statement-breakpoint
CREATE TABLE `employeeSpotBonuses` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`reason` varchar(255) NOT NULL,
	`decisionNumber` varchar(100),
	`disbursementType` enum('CASH_TREASURY','PAYROLL_ADDITION') NOT NULL DEFAULT 'CASH_TREASURY',
	`voucherId` bigint,
	`payrollRunId` bigint,
	`status` enum('DRAFT','APPROVED','PAID','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`createdById` int NOT NULL,
	`approvedById` int,
	`approvedAt` timestamp,
	`paidAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeSpotBonuses_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_spot_bonus_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_spot_bonus_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_spot_bonus_payroll_run` FOREIGN KEY (`payrollRunId`) REFERENCES `payrollRuns`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_spot_bonus_creator` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_spot_bonus_approver` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `idx_spot_bonus_employee` ON `employeeSpotBonuses` (`employeeId`);
--> statement-breakpoint
CREATE INDEX `idx_spot_bonus_branch` ON `employeeSpotBonuses` (`branchId`);
--> statement-breakpoint
CREATE INDEX `idx_spot_bonus_status` ON `employeeSpotBonuses` (`status`);
--> statement-breakpoint
CREATE TABLE `employeeTransfers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`fromBranchId` bigint,
	`toBranchId` bigint,
	`fromDepartment` varchar(100),
	`toDepartment` varchar(100),
	`fromPosition` varchar(100),
	`toPosition` varchar(100),
	`decisionNumber` varchar(100) NOT NULL,
	`transferDate` date NOT NULL,
	`effectiveDate` date NOT NULL,
	`reason` varchar(255),
	`notes` text,
	`status` enum('PENDING','APPROVED','EFFECTIVE','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`createdById` int NOT NULL,
	`approvedById` int,
	`approvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeTransfers_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_emp_transfer_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_transfer_from_branch` FOREIGN KEY (`fromBranchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_transfer_to_branch` FOREIGN KEY (`toBranchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_transfer_creator` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_transfer_approver` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `idx_emp_transfer_employee` ON `employeeTransfers` (`employeeId`);
--> statement-breakpoint
CREATE INDEX `idx_emp_transfer_status` ON `employeeTransfers` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_emp_transfer_effective` ON `employeeTransfers` (`effectiveDate`);
--> statement-breakpoint
CREATE TABLE `employeeLoanRequests` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`installmentsCount` int NOT NULL DEFAULT 1,
	`monthlyDeduction` decimal(15,2) NOT NULL,
	`reason` varchar(255),
	`status` enum('PENDING','APPROVED','REJECTED','CANCELLED','DISBURSED') NOT NULL DEFAULT 'PENDING',
	`advanceId` bigint,
	`rejectionReason` varchar(255),
	`createdById` int NOT NULL,
	`reviewedById` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeLoanRequests_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_emp_loan_req_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_loan_req_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_loan_req_advance` FOREIGN KEY (`advanceId`) REFERENCES `employeeAdvances`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_loan_req_creator` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_loan_req_reviewer` FOREIGN KEY (`reviewedById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `idx_emp_loan_req_employee_status` ON `employeeLoanRequests` (`employeeId`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_emp_loan_req_branch` ON `employeeLoanRequests` (`branchId`);
--> statement-breakpoint
CREATE TABLE `employeeCustody` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`itemType` enum('TOOL','DEVICE','VEHICLE','KEY','DOCUMENT','UNIFORM','OTHER') NOT NULL DEFAULT 'TOOL',
	`itemName` varchar(200) NOT NULL,
	`itemCode` varchar(100),
	`serialNumber` varchar(100),
	`quantity` int NOT NULL DEFAULT 1,
	`conditionAtHandover` varchar(100),
	`handoverDate` date NOT NULL,
	`expectedReturnDate` date,
	`actualReturnDate` date,
	`conditionAtReturn` varchar(100),
	`returnNotes` text,
	`status` enum('HELD','RETURNED','DAMAGED','LOST') NOT NULL DEFAULT 'HELD',
	`notes` text,
	`createdById` int NOT NULL,
	`receivedById` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeCustody_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_emp_custody_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_custody_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_custody_creator` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
	CONSTRAINT `fk_emp_custody_receiver` FOREIGN KEY (`receivedById`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX `idx_emp_custody_employee` ON `employeeCustody` (`employeeId`);
--> statement-breakpoint
CREATE INDEX `idx_emp_custody_branch` ON `employeeCustody` (`branchId`);
--> statement-breakpoint
CREATE INDEX `idx_emp_custody_status` ON `employeeCustody` (`status`);
