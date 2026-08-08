-- Transactional, versioned stocktake item review approvals.
-- Existing approvals from 0163 intentionally keep a NULL snapshot hash: the
-- application treats them as stale and asks a manager to re-confirm them.
ALTER TABLE `stocktakeItems`
  ADD COLUMN `reviewApprovedOperationId` BIGINT NULL AFTER `reviewApprovedAt`,
  ADD COLUMN `reviewApprovedQty` INT NULL AFTER `reviewApprovedOperationId`,
  ADD COLUMN `reviewApprovedSnapshotHash` VARCHAR(64) NULL AFTER `reviewApprovedQty`,
  ADD COLUMN `reviewReopenedBy` INT NULL AFTER `reviewApprovedSnapshotHash`,
  ADD COLUMN `reviewReopenedAt` TIMESTAMP NULL AFTER `reviewReopenedBy`,
  ADD COLUMN `reviewReopenReason` VARCHAR(255) NULL AFTER `reviewReopenedAt`,
  ADD CONSTRAINT `fk_stkitem_review_approved_operation`
    FOREIGN KEY (`reviewApprovedOperationId`) REFERENCES `stocktakeCountOperations`(`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_stkitem_review_reopened_by`
    FOREIGN KEY (`reviewReopenedBy`) REFERENCES `users`(`id`);

CREATE TABLE `stocktakeItemReviewEvents` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `sessionId` BIGINT NOT NULL,
  `variantId` BIGINT NOT NULL,
  `action` ENUM('APPROVE', 'REOPEN') NOT NULL,
  `snapshotOperationId` BIGINT NULL,
  `snapshotQty` INT NULL,
  `snapshotHash` VARCHAR(64) NULL,
  `reason` VARCHAR(255) NULL,
  `actedBy` INT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_stk_review_event_session_variant_created` (`sessionId`, `variantId`, `createdAt`),
  KEY `idx_stk_review_event_actor_created` (`actedBy`, `createdAt`),
  CONSTRAINT `fk_stk_review_event_session`
    FOREIGN KEY (`sessionId`) REFERENCES `stocktakeSessions`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_stk_review_event_variant`
    FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`),
  CONSTRAINT `fk_stk_review_event_operation`
    FOREIGN KEY (`snapshotOperationId`) REFERENCES `stocktakeCountOperations`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_stk_review_event_actor`
    FOREIGN KEY (`actedBy`) REFERENCES `users`(`id`)
) ENGINE=InnoDB;
