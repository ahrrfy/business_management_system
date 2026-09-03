-- 0298 — حوكمة طلبات تعديل/مواد/إلغاء أوامر الشغل.
-- الصف المعلّق بلا أثر؛ الاعتماد وحده يطبّق القرار بعد مطابقة نسخة الأمر.

SET @needs_wo_version := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'workOrders' AND column_name = 'version'
);
SET @sql := IF(
  @needs_wo_version,
  'ALTER TABLE `workOrders` ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER `materialsEditCount`',
  'SELECT ''workOrders.version exists'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `workOrderControlRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `workOrderId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `requestType` ENUM('COMMERCIAL_EDIT','MATERIAL_ADJUST','CANCEL','REVERSE_DELIVERY') NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `baseVersion` INT NOT NULL,
  `payload` JSON NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `requestedBy` INT NOT NULL,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewNote` VARCHAR(500) NULL,
  `appliedAt` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `workOrderControlRequests_requestKey_unique` (`requestKey`),
  KEY `idx_wo_control_work_status` (`workOrderId`, `status`),
  KEY `idx_wo_control_branch_status` (`branchId`, `status`),
  KEY `idx_wo_control_requester` (`requestedBy`),
  KEY `idx_wo_control_reviewer` (`reviewedBy`),
  CONSTRAINT `fk_wo_control_work_order` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders` (`id`),
  CONSTRAINT `fk_wo_control_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_wo_control_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_wo_control_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_wo_control_decision_shape` CHECK (
    (`status` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_wo_control_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- قاعدة البيانات هي الكاتب الوحيد للنسخة كي لا يفلت أي مسار قديم أو جديد من الزيادة.
DROP TRIGGER IF EXISTS `trg_work_orders_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_work_orders_version_bu`
BEFORE UPDATE ON `workOrders`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
