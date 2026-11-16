CREATE TABLE IF NOT EXISTS `productPhotographyLocks` (
	`productId` bigint NOT NULL,
	`variantId` bigint,
	`userId` int NOT NULL,
	`userName` varchar(120) NOT NULL,
	`lockedAt` timestamp NOT NULL DEFAULT (now()),
	`heartbeatAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	CONSTRAINT `productPhotographyLocks_productId` PRIMARY KEY(`productId`),
	CONSTRAINT `productPhotographyLocks_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_pplocks_expires` ON `productPhotographyLocks` (`expiresAt`);
