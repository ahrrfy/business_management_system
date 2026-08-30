-- عقد إسناد العملية مستقلّ ومفهرس (٢٠٢٦-٠٨-٣٠).
-- يحافظ على نوع oldValue/newValue التاريخي، ويمنع JSON_EXTRACT الكامل عند فتح سجل شاشة.

SET @needs_operation := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'auditLogs' AND column_name = 'operation'
);
SET @sql := IF(@needs_operation,
  "ALTER TABLE `auditLogs` ADD COLUMN `operation` JSON NULL AFTER `newValue`",
  "SELECT 'auditLogs.operation exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @needs_screen_path := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'auditLogs' AND column_name = 'screenPath'
);
SET @sql := IF(@needs_screen_path,
  "ALTER TABLE `auditLogs` ADD COLUMN `screenPath` VARCHAR(255) NULL AFTER `operation`",
  "SELECT 'auditLogs.screenPath exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @needs_screen_path_idx := (
  SELECT COUNT(*) = 0 FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'auditLogs' AND index_name = 'idx_audit_screen_path_id'
);
SET @sql := IF(@needs_screen_path_idx,
  "CREATE INDEX `idx_audit_screen_path_id` ON `auditLogs` (`screenPath`, `id`)",
  "SELECT 'idx_audit_screen_path_id exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
