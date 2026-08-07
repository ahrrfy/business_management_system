CREATE TABLE `appNotifications` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `kind` varchar(40) NOT NULL,
  `title` varchar(180) NOT NULL,
  `body` varchar(600) NOT NULL,
  `route` varchar(255) NOT NULL,
  `entityType` varchar(60),
  `entityId` bigint,
  `eventKey` varchar(190) NOT NULL,
  `requiresAction` boolean NOT NULL DEFAULT false,
  `readAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `appNotifications_id` PRIMARY KEY(`id`),
  CONSTRAINT `appNotifications_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `appNotifications_eventKey_unique` UNIQUE(`eventKey`)
);

CREATE INDEX `idx_app_notice_user_created` ON `appNotifications` (`userId`, `createdAt`);
CREATE INDEX `idx_app_notice_user_read` ON `appNotifications` (`userId`, `readAt`);

CREATE TABLE `appNotificationPreferences` (
  `userId` int NOT NULL,
  `taskAssigned` boolean NOT NULL DEFAULT true,
  `payrollReady` boolean NOT NULL DEFAULT true,
  `attendance` boolean NOT NULL DEFAULT true,
  `leaveStatus` boolean NOT NULL DEFAULT true,
  `approvals` boolean NOT NULL DEFAULT true,
  `quietHoursStart` varchar(5),
  `quietHoursEnd` varchar(5),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `appNotificationPreferences_userId` PRIMARY KEY(`userId`),
  CONSTRAINT `appNotificationPreferences_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);

ALTER TABLE `pushNotificationLog`
  MODIFY COLUMN `pushKind` varchar(40) NOT NULL;
