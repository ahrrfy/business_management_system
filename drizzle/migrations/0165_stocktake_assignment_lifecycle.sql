-- إدارة عمّال الجرد أثناء الجلسة مع حفظ الأثر التاريخي.
-- REMOVED يلغي الوصول فوراً ولا يحذف التكليف أو العدّات المرتبطة به.
ALTER TABLE `stocktakeAssignments`
  MODIFY COLUMN `assignmentStatus` ENUM('ACTIVE','SUBMITTED','REMOVED') NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN `addedBy` INT NULL AFTER `assignmentStatus`,
  ADD COLUMN `removedBy` INT NULL AFTER `addedBy`,
  ADD COLUMN `removedAt` TIMESTAMP NULL AFTER `removedBy`,
  ADD COLUMN `removalReason` VARCHAR(255) NULL AFTER `removedAt`,
  ADD CONSTRAINT `fk_stkassign_added_by`
    FOREIGN KEY (`addedBy`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `fk_stkassign_removed_by`
    FOREIGN KEY (`removedBy`) REFERENCES `users` (`id`);

CREATE INDEX `idx_stkassign_session_status`
  ON `stocktakeAssignments` (`sessionId`, `assignmentStatus`);
