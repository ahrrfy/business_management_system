CREATE TABLE IF NOT EXISTS `announcements` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`title` varchar(200) NOT NULL,
	`body` text NOT NULL,
	`announcementPriority` enum('NORMAL','IMPORTANT','CRITICAL') NOT NULL DEFAULT 'NORMAL',
	`announcementAudience` enum('ALL','BRANCH','ROLE') NOT NULL,
	`audienceBranchId` bigint,
	`audienceRole` varchar(40),
	`requiresAck` boolean NOT NULL DEFAULT false,
	`createdBy` int NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`expiresAt` timestamp NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `announcements_id` PRIMARY KEY(`id`),
	KEY `idx_announcement_active` (`isActive`,`createdAt`),
	KEY `idx_announcement_audience` (`announcementAudience`,`audienceBranchId`),
	CONSTRAINT `fk_announcement_branch` FOREIGN KEY (`audienceBranchId`) REFERENCES `branches`(`id`),
	CONSTRAINT `fk_announcement_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `announcementReads` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`announcementId` bigint NOT NULL,
	`userId` int NOT NULL,
	`readAt` timestamp NOT NULL DEFAULT (now()),
	`acknowledgedAt` timestamp NULL,
	CONSTRAINT `announcementReads_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_announcement_read` UNIQUE(`announcementId`,`userId`),
	KEY `idx_announcement_read_user` (`userId`),
	CONSTRAINT `fk_announcement_read_ann` FOREIGN KEY (`announcementId`) REFERENCES `announcements`(`id`),
	CONSTRAINT `fk_announcement_read_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
);
