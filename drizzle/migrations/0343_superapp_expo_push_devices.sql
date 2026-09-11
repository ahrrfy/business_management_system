-- Super Arabia Expo has a distinct push boundary from the legacy Android and
-- customer-store apps. Tokens are encrypted at rest; the unique SHA-256 hash
-- permits conflict detection without making the token queryable.
CREATE TABLE `superAppExpoPushDevices` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `tokenHash` char(64) NOT NULL,
  `tokenCiphertext` text NOT NULL,
  `devicePublicKeyHash` char(64) NOT NULL,
  `platform` enum('ANDROID','IOS') NOT NULL,
  `environment` enum('dev','staging','prod') NOT NULL,
  `appVersion` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lastSeenAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revokedAt` timestamp NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `superAppExpoPushDevices_tokenHash_unique` (`tokenHash`),
  KEY `idx_superapp_expo_push_user_active` (`userId`,`revokedAt`,`environment`),
  KEY `idx_superapp_expo_push_device_owner` (`userId`,`devicePublicKeyHash`,`revokedAt`),
  CONSTRAINT `superAppExpoPushDevices_userId_users_id_fk`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE `superAppExpoPushOutbox` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `eventKey` varchar(190) NOT NULL,
  `payload` json NOT NULL,
  `environment` enum('dev','staging','prod') NOT NULL,
  `status` enum('PENDING','PROCESSING','RETRY','SENT','DEAD') NOT NULL DEFAULT 'PENDING',
  `attemptCount` int NOT NULL DEFAULT 0,
  `availableAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lockedAt` timestamp NULL,
  `completedAt` timestamp NULL,
  `lastError` varchar(64) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `superAppExpoPushOutbox_eventKey_unique` (`eventKey`),
  KEY `idx_superapp_expo_push_outbox_due` (`status`,`availableAt`,`id`),
  KEY `idx_superapp_expo_push_outbox_user_created` (`userId`,`createdAt`),
  CONSTRAINT `superAppExpoPushOutbox_userId_users_id_fk`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE
);
