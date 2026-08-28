CREATE TABLE `statutoryAccountingProfiles` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`profileKey` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`authorityReference` varchar(255) NOT NULL,
	`effectiveFrom` date NOT NULL,
	`status` enum('DRAFT','ACTIVE','RETIRED') NOT NULL DEFAULT 'DRAFT',
	`activeGuard` varchar(16),
	`contentHash` char(64),
	`accountantName` varchar(150),
	`approvalReference` varchar(255),
	`approvedBy` int,
	`approvedAt` timestamp,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `statutoryAccountingProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stat_profile_key_version` UNIQUE(`profileKey`,`version`),
	CONSTRAINT `uq_stat_profile_active_guard` UNIQUE(`activeGuard`),
	CONSTRAINT `chk_stat_profile_active_state` CHECK(((`status` = 'ACTIVE' AND `activeGuard` = 'ACTIVE') OR (`status` <> 'ACTIVE' AND `activeGuard` IS NULL)))
);
--> statement-breakpoint
CREATE TABLE `statutoryAccounts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`profileId` bigint NOT NULL,
	`code` varchar(30) NOT NULL,
	`name` varchar(160) NOT NULL,
	`type` enum('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE') NOT NULL,
	`normalBalance` enum('DEBIT','CREDIT') NOT NULL,
	`parentId` bigint,
	`isPosting` boolean NOT NULL DEFAULT true,
	`sortOrder` int NOT NULL DEFAULT 0,
	`notes` varchar(500),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `statutoryAccounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stat_account_profile_code` UNIQUE(`profileId`,`code`)
);
--> statement-breakpoint
CREATE TABLE `statutoryAccountMappings` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`profileId` bigint NOT NULL,
	`internalAccountId` bigint NOT NULL,
	`statutoryAccountId` bigint NOT NULL,
	`rationale` varchar(500),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `statutoryAccountMappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stat_mapping_internal` UNIQUE(`profileId`,`internalAccountId`)
);
--> statement-breakpoint
ALTER TABLE `journalLines` ADD COLUMN `statutoryProfileId` bigint;
--> statement-breakpoint
ALTER TABLE `journalLines` ADD COLUMN `statutoryAccountId` bigint;
--> statement-breakpoint
ALTER TABLE `statutoryAccountingProfiles` ADD CONSTRAINT `statutoryAccountingProfiles_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `statutoryAccountingProfiles` ADD CONSTRAINT `statutoryAccountingProfiles_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `statutoryAccounts` ADD CONSTRAINT `statutoryAccounts_profileId_statutoryAccountingProfiles_id_fk` FOREIGN KEY (`profileId`) REFERENCES `statutoryAccountingProfiles`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `statutoryAccounts` ADD CONSTRAINT `fk_stat_account_parent` FOREIGN KEY (`parentId`) REFERENCES `statutoryAccounts`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `statutoryAccountMappings` ADD CONSTRAINT `fk_stat_mapping_profile` FOREIGN KEY (`profileId`) REFERENCES `statutoryAccountingProfiles`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `statutoryAccountMappings` ADD CONSTRAINT `fk_stat_mapping_internal` FOREIGN KEY (`internalAccountId`) REFERENCES `accounts`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `statutoryAccountMappings` ADD CONSTRAINT `fk_stat_mapping_account` FOREIGN KEY (`statutoryAccountId`) REFERENCES `statutoryAccounts`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `statutoryAccountMappings` ADD CONSTRAINT `statutoryAccountMappings_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `journalLines` ADD CONSTRAINT `fk_journal_line_stat_profile` FOREIGN KEY (`statutoryProfileId`) REFERENCES `statutoryAccountingProfiles`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `journalLines` ADD CONSTRAINT `fk_journal_line_stat_account` FOREIGN KEY (`statutoryAccountId`) REFERENCES `statutoryAccounts`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_stat_profile_status` ON `statutoryAccountingProfiles` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_stat_account_profile_type` ON `statutoryAccounts` (`profileId`,`type`,`sortOrder`);
--> statement-breakpoint
CREATE INDEX `idx_stat_mapping_statutory` ON `statutoryAccountMappings` (`profileId`,`statutoryAccountId`);
--> statement-breakpoint
CREATE INDEX `idx_journal_line_statutory` ON `journalLines` (`statutoryProfileId`,`statutoryAccountId`);
