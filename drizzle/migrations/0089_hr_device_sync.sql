-- 0089: مزامنة أجهزة الحضور الحقيقية (استبدال الاشتراك المدفوع بخادمنا) — الشريحة ١.
-- توسعة hrFingerprintDevices بحقول الهوية الحقيقية (SN/بروتوكول/حالة حياة/devInfo مُبلَّغ)
-- + ثلاثة جداول: بصمات خام idempotent، مرآة مستخدمي الجهاز (ربط + نسخ قوالب احتياطي)، طابور أوامر.
-- ملاحظة MySQL 8: لا يدعم ADD COLUMN IF NOT EXISTS — تُطبَّق مرة واحدة عبر drizzle migrator.
ALTER TABLE `hrFingerprintDevices` ADD COLUMN `serialNumber` VARCHAR(64) NULL AFTER `firmware`;
--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD COLUMN `protocol` VARCHAR(20) NOT NULL DEFAULT 'AIFACE_WS' AFTER `serialNumber`;
--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT true AFTER `protocol`;
--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD COLUMN `lastSeenAt` TIMESTAMP NULL AFTER `enabled`;
--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD COLUMN `lastHandshakeAt` TIMESTAMP NULL AFTER `lastSeenAt`;
--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD COLUMN `lastPunchAt` DATETIME NULL AFTER `lastHandshakeAt`;
--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD COLUMN `devInfo` JSON NULL AFTER `lastPunchAt`;
--> statement-breakpoint
ALTER TABLE `hrFingerprintDevices` ADD CONSTRAINT `uq_fpdev_serial` UNIQUE (`serialNumber`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hrAttendancePunches` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `deviceId` BIGINT DEFAULT NULL,
  `serialNumber` VARCHAR(64) NOT NULL,
  `enrollId` INT NOT NULL,
  `punchAt` DATETIME NOT NULL,
  `mode` VARCHAR(12) DEFAULT NULL,
  `inOut` VARCHAR(8) DEFAULT NULL,
  `employeeId` BIGINT DEFAULT NULL,
  `processedAt` TIMESTAMP NULL DEFAULT NULL,
  `processNote` VARCHAR(200) DEFAULT NULL,
  `raw` JSON DEFAULT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_punch_sn_enroll_time` (`serialNumber`, `enrollId`, `punchAt`),
  KEY `idx_punch_unprocessed` (`processedAt`),
  KEY `idx_punch_employee_time` (`employeeId`, `punchAt`),
  KEY `idx_punch_device` (`deviceId`),
  CONSTRAINT `fk_punch_device` FOREIGN KEY (`deviceId`) REFERENCES `hrFingerprintDevices`(`id`),
  CONSTRAINT `fk_punch_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hrDeviceUsers` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `deviceId` BIGINT NOT NULL,
  `enrollId` INT NOT NULL,
  `name` VARCHAR(120) DEFAULT NULL,
  `isAdmin` BOOLEAN NOT NULL DEFAULT false,
  `cardNo` VARCHAR(40) DEFAULT NULL,
  `backupData` JSON DEFAULT NULL,
  `employeeId` BIGINT DEFAULT NULL,
  `syncedAt` TIMESTAMP NULL DEFAULT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_devuser_device_enroll` (`deviceId`, `enrollId`),
  KEY `idx_devuser_employee` (`employeeId`),
  CONSTRAINT `fk_devuser_device` FOREIGN KEY (`deviceId`) REFERENCES `hrFingerprintDevices`(`id`),
  CONSTRAINT `fk_devuser_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hrDeviceCommands` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `deviceId` BIGINT NOT NULL,
  `cmd` VARCHAR(30) NOT NULL,
  `payload` JSON DEFAULT NULL,
  `status` ENUM('queued','sent','done','failed') NOT NULL DEFAULT 'queued',
  `result` JSON DEFAULT NULL,
  `error` TEXT DEFAULT NULL,
  `createdBy` INT DEFAULT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sentAt` TIMESTAMP NULL DEFAULT NULL,
  `doneAt` TIMESTAMP NULL DEFAULT NULL,
  KEY `idx_devcmd_device_status` (`deviceId`, `status`),
  CONSTRAINT `fk_devcmd_device` FOREIGN KEY (`deviceId`) REFERENCES `hrFingerprintDevices`(`id`),
  CONSTRAINT `fk_devcmd_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`)
);
