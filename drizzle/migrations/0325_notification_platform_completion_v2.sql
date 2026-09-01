ALTER TABLE `appNotifications`
  ADD COLUMN `family` ENUM('OPERATIONS','ADMIN','EMPLOYEE','SYSTEM','APPROVAL') NOT NULL DEFAULT 'SYSTEM' AFTER `kind`;

UPDATE `appNotifications`
SET `family` = CASE
  WHEN `kind` = 'TASK_ASSIGNED' THEN 'OPERATIONS'
  WHEN `kind` IN ('PAYROLL_READY','ATTENDANCE','LEAVE_STATUS') THEN 'EMPLOYEE'
  WHEN `kind` = 'APPROVAL_REQUIRED' THEN 'APPROVAL'
  WHEN `kind` = 'SESSION_EVENT' THEN 'ADMIN'
  ELSE 'SYSTEM'
END;

CREATE INDEX `idx_app_notice_user_family_created`
  ON `appNotifications` (`userId`,`family`,`createdAt`);

CREATE TABLE `webPushOutbox` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `eventKey` VARCHAR(190) NOT NULL,
  `payload` JSON NOT NULL,
  `status` ENUM('PENDING','PROCESSING','RETRY','SENT','DEAD') NOT NULL DEFAULT 'PENDING',
  `attemptCount` INT NOT NULL DEFAULT 0,
  `availableAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lockedAt` TIMESTAMP NULL,
  `completedAt` TIMESTAMP NULL,
  `lastError` VARCHAR(64) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `webPushOutbox_eventKey_unique` UNIQUE (`eventKey`),
  CONSTRAINT `fk_web_push_outbox_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_web_push_outbox_due` (`status`,`availableAt`,`id`),
  INDEX `idx_web_push_outbox_user_created` (`userId`,`createdAt`)
);

ALTER TABLE `storefrontPushCampaigns`
  ADD COLUMN `eventKey` VARCHAR(190) NULL AFTER `id`,
  ADD CONSTRAINT `storefrontPushCampaigns_eventKey_unique` UNIQUE (`eventKey`);
