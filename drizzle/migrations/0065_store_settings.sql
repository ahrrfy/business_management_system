-- 0065: إعدادات المتجر (storeSettings) — صفّ مفرد (نمط taxSettings). idempotent.

CREATE TABLE IF NOT EXISTS `storeSettings` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `isOpen` BOOLEAN NOT NULL DEFAULT TRUE,
  `announcement` VARCHAR(500) DEFAULT NULL,
  `whatsappNumber` VARCHAR(20) DEFAULT NULL,
  `updatedBy` INT DEFAULT NULL,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_store_settings_user` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'storeSettings' AND CONSTRAINT_NAME = 'fk_store_settings_user');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `storeSettings` ADD CONSTRAINT `fk_store_settings_user` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
