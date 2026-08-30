CREATE TABLE `appNotificationOutbox` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `branchId` bigint,
  `recipientUserId` int NOT NULL,
  `streamKey` varchar(190) NOT NULL,
  `occurrenceId` varchar(80) NOT NULL,
  `eventKey` varchar(190) NOT NULL,
  `payload` json NOT NULL,
  `status` enum('PENDING','DELIVERED','INVALID') NOT NULL DEFAULT 'PENDING',
  `attemptCount` int NOT NULL DEFAULT 0,
  `availableAt` timestamp NOT NULL DEFAULT (now()),
  `processedAt` timestamp,
  `lastError` varchar(500),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `appNotificationOutbox_id` PRIMARY KEY(`id`),
  CONSTRAINT `appNotificationOutbox_eventKey_unique` UNIQUE(`eventKey`),
  CONSTRAINT `appNotificationOutbox_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `appNotificationOutbox_recipientUserId_users_id_fk` FOREIGN KEY (`recipientUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_app_notice_outbox_due` ON `appNotificationOutbox` (`status`,`availableAt`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_app_notice_outbox_occurrence` ON `appNotificationOutbox` (`occurrenceId`,`status`,`availableAt`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_app_notice_outbox_stream` ON `appNotificationOutbox` (`streamKey`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_app_notice_outbox_branch_due` ON `appNotificationOutbox` (`branchId`,`status`,`availableAt`,`id`);
