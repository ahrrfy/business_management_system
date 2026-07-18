-- 0082: طلبات تسوية المخزون المُعلَّقة (stockAdjustmentRequests) — فصل مهام #٦ الشريحة ٢.
-- التسوية المباشرة للمخزون عمليةٌ حسّاسة (قد تُخفي عجزاً/سرقة) ⇒ تُنشأ **طلباً معلَّقاً بلا تغيير مخزون**
-- يعتمده مديرٌ آخر (SOD: المُعتمِد ≠ المُنشئ) فيُطبَّق setStock + قيد ADJUST. idempotent (CREATE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS `stockAdjustmentRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `variantId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `targetQuantity` INT NOT NULL,
  `notes` VARCHAR(500) DEFAULT NULL,
  `stockAdjustmentStatus` ENUM('PENDING_APPROVAL','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING_APPROVAL',
  `createdBy` INT NOT NULL,
  `approvedBy` INT DEFAULT NULL,
  `approvedAt` TIMESTAMP NULL DEFAULT NULL,
  `appliedMovementId` BIGINT DEFAULT NULL,
  `rejectionReason` VARCHAR(500) DEFAULT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_stockadj_status_branch` (`stockAdjustmentStatus`, `branchId`),
  KEY `idx_stockadj_variant` (`variantId`),
  CONSTRAINT `fk_stockadj_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`),
  CONSTRAINT `fk_stockadj_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_stockadj_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_stockadj_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`)
);
