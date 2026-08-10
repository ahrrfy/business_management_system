ALTER TABLE `stocktakeItems`
  ADD COLUMN `reviewApprovedBy` int NULL AFTER `recountRequestedAt`,
  ADD COLUMN `reviewApprovedAt` timestamp NULL AFTER `reviewApprovedBy`,
  ADD CONSTRAINT `stocktakeItems_reviewApprovedBy_users_id_fk`
    FOREIGN KEY (`reviewApprovedBy`) REFERENCES `users`(`id`);

CREATE INDEX `idx_stkitem_session_review_approved`
  ON `stocktakeItems` (`sessionId`, `reviewApprovedAt`);
