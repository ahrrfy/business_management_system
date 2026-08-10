CREATE TABLE `nativePushDevices` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `tokenHash` char(64) NOT NULL,
  `tokenCiphertext` text NOT NULL,
  `devicePublicKeyHash` char(64) NOT NULL,
  `platform` enum('ANDROID') NOT NULL DEFAULT 'ANDROID',
  `environment` enum('dev','staging','prod') NOT NULL,
  `appVersion` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `lastSeenAt` timestamp NOT NULL DEFAULT (now()),
  `revokedAt` timestamp NULL,
  CONSTRAINT `nativePushDevices_id` PRIMARY KEY(`id`),
  CONSTRAINT `nativePushDevices_tokenHash_unique` UNIQUE(`tokenHash`),
  CONSTRAINT `nativePushDevices_userId_users_id_fk`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);

CREATE INDEX `idx_native_push_user_active`
  ON `nativePushDevices` (`userId`, `revokedAt`, `environment`);
CREATE INDEX `idx_native_push_device_owner`
  ON `nativePushDevices` (`userId`, `devicePublicKeyHash`, `revokedAt`);

CREATE TABLE `nativePushDeliveryLog` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `tokenHash` char(64) NOT NULL,
  `notificationId` varchar(96) NOT NULL,
  `kind` varchar(40) NOT NULL,
  `destination` varchar(256) NOT NULL,
  `status` enum('SENT','GONE','FAILED') NOT NULL,
  `statusCode` int NOT NULL,
  `messageId` varchar(255),
  `errorCode` varchar(64),
  `sentAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `nativePushDeliveryLog_id` PRIMARY KEY(`id`),
  CONSTRAINT `nativePushDeliveryLog_userId_users_id_fk`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);

CREATE INDEX `idx_native_push_delivery_user_sent`
  ON `nativePushDeliveryLog` (`userId`, `sentAt`);
CREATE INDEX `idx_native_push_delivery_notification`
  ON `nativePushDeliveryLog` (`notificationId`);

ALTER TABLE `nativePushDeliveryLog`
  ADD CONSTRAINT `nativePushDeliveryLog_notification_token_unique`
  UNIQUE (`notificationId`, `tokenHash`);

CREATE TABLE `nativePushOutbox` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `eventKey` varchar(190) NOT NULL,
  `payload` json NOT NULL,
  `environment` enum('dev','staging','prod') NOT NULL,
  `status` enum('PENDING','PROCESSING','RETRY','SENT','DEAD') NOT NULL DEFAULT 'PENDING',
  `attemptCount` int NOT NULL DEFAULT 0,
  `availableAt` timestamp NOT NULL DEFAULT (now()),
  `lockedAt` timestamp NULL,
  `completedAt` timestamp NULL,
  `lastError` varchar(64),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `nativePushOutbox_id` PRIMARY KEY(`id`),
  CONSTRAINT `nativePushOutbox_eventKey_unique` UNIQUE(`eventKey`),
  CONSTRAINT `nativePushOutbox_userId_users_id_fk`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action
);

CREATE INDEX `idx_native_push_outbox_due`
  ON `nativePushOutbox` (`status`, `availableAt`, `id`);
CREATE INDEX `idx_native_push_outbox_user_created`
  ON `nativePushOutbox` (`userId`, `createdAt`);
