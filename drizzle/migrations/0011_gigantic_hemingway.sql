CREATE TABLE `jobVacancies` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`title` varchar(200) NOT NULL,
	`department` varchar(120),
	`employmentType` varchar(30) NOT NULL DEFAULT 'full_time',
	`location` varchar(200),
	`branchId` bigint,
	`summary` varchar(400),
	`description` text,
	`requirements` text,
	`openings` int NOT NULL DEFAULT 1,
	`imageUrl` mediumtext,
	`isPublished` boolean NOT NULL DEFAULT false,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jobVacancies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `customers` MODIFY COLUMN `creditLimit` decimal(15,2);--> statement-breakpoint
ALTER TABLE `expenses` ADD `expenseCashBucket` enum('DRAWER','TREASURY');--> statement-breakpoint
ALTER TABLE `jobApplicants` ADD `vacancyId` bigint;--> statement-breakpoint
ALTER TABLE `receipts` ADD `cashBucket` enum('DRAWER','TREASURY');--> statement-breakpoint
ALTER TABLE `jobVacancies` ADD CONSTRAINT `jobVacancies_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_vacancy_published` ON `jobVacancies` (`isPublished`);--> statement-breakpoint
ALTER TABLE `jobApplicants` ADD CONSTRAINT `jobApplicants_vacancyId_jobVacancies_id_fk` FOREIGN KEY (`vacancyId`) REFERENCES `jobVacancies`(`id`) ON DELETE no action ON UPDATE no action;