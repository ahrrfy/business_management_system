CREATE TABLE `pushDailyClaim` (
	`userId` int NOT NULL,
	`pushClaimKind` enum('MORNING_BRIEF') NOT NULL,
	`claimDay` date NOT NULL,
	`claimedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pushDailyClaim_userId_pushClaimKind_claimDay_pk` PRIMARY KEY(`userId`,`pushClaimKind`,`claimDay`)
);
--> statement-breakpoint
CREATE TABLE `pushNotificationLog` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`pushKind` enum('MORNING_BRIEF') NOT NULL,
	`payload` text NOT NULL,
	`pushLogStatus` enum('SENT','FAILED_GONE','FAILED_OTHER') NOT NULL,
	`statusCode` int,
	`errorMessage` varchar(500),
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pushNotificationLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pushSubscriptions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`endpoint` varchar(500) NOT NULL,
	`p256dh` text NOT NULL,
	`auth` varchar(100) NOT NULL,
	`userAgent` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	CONSTRAINT `pushSubscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pushSubscriptions_endpoint_unique` UNIQUE(`endpoint`)
);
--> statement-breakpoint
ALTER TABLE `pushDailyClaim` ADD CONSTRAINT `pushDailyClaim_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pushNotificationLog` ADD CONSTRAINT `pushNotificationLog_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pushSubscriptions` ADD CONSTRAINT `pushSubscriptions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_push_log_user_sent` ON `pushNotificationLog` (`userId`,`sentAt`);--> statement-breakpoint
CREATE INDEX `idx_push_sub_user` ON `pushSubscriptions` (`userId`);