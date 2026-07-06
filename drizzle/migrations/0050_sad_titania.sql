CREATE TABLE `userRecoveryCodes` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`codeHash` varchar(255) NOT NULL,
	`usedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `userRecoveryCodes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `lastFailedLoginAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `totpSecretEncrypted` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `totpEnabledAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `totpLastUsedStep` bigint;--> statement-breakpoint
ALTER TABLE `userRecoveryCodes` ADD CONSTRAINT `userRecoveryCodes_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_recovery_codes_user` ON `userRecoveryCodes` (`userId`);