-- Immutable idempotency ledger for count.submit.
-- The mutable stocktakeCounts projection may be edited by the same assignment;
-- request keys must not move with that projection or an older device retry can
-- overwrite a newer count.
CREATE TABLE `stocktakeCountOperations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `sessionId` BIGINT NOT NULL,
  `variantId` BIGINT NOT NULL,
  `assignmentId` BIGINT NOT NULL,
  `clientRequestId` VARCHAR(64) NOT NULL,
  `requestQty` INT NOT NULL,
  `requestUnitBreakdown` TEXT NULL,
  `resultKind` ENUM('FIRST', 'RECOUNT', 'VERIFY') NOT NULL,
  `resultVerifyMatch` TINYINT(1) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stkcountop_request` (`sessionId`, `clientRequestId`),
  KEY `idx_stkcountop_assignment_created` (`assignmentId`, `createdAt`),
  CONSTRAINT `fk_stkcountop_session`
    FOREIGN KEY (`sessionId`) REFERENCES `stocktakeSessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_stkcountop_variant`
    FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `fk_stkcountop_assignment`
    FOREIGN KEY (`assignmentId`) REFERENCES `stocktakeAssignments` (`id`)
) ENGINE=InnoDB;

-- Preserve every request key still present in the legacy mutable projection.
-- Historical keys overwritten before this migration cannot be reconstructed,
-- but from this point onward every accepted request is retained append-only.
INSERT INTO `stocktakeCountOperations` (
  `sessionId`,
  `variantId`,
  `assignmentId`,
  `clientRequestId`,
  `requestQty`,
  `requestUnitBreakdown`,
  `resultKind`,
  `resultVerifyMatch`,
  `createdAt`
)
SELECT
  `sessionId`,
  `variantId`,
  `assignmentId`,
  `clientRequestId`,
  `qty`,
  `unitBreakdown`,
  `kind`,
  CASE WHEN `kind` = 'VERIFY' THEN NOT `isConflict` ELSE NULL END,
  `createdAt`
FROM `stocktakeCounts`
WHERE `clientRequestId` IS NOT NULL;
