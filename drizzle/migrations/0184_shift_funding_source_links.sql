CREATE TABLE `shiftFundingSourceLinks` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `requestReceiptId` bigint NOT NULL,
  `sourceReceiptId` bigint NOT NULL,
  `activeSourceReceiptId` bigint,
  `targetShiftId` bigint NOT NULL,
  `activeTargetShiftId` bigint,
  `branchId` bigint NOT NULL,
  `shiftFundingLinkState` enum('PENDING','CONSUMED','RELEASED') NOT NULL DEFAULT 'PENDING',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `shiftFundingSourceLinks_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_shift_funding_link_request` UNIQUE(`requestReceiptId`),
  CONSTRAINT `uq_shift_funding_link_active_source` UNIQUE(`activeSourceReceiptId`),
  CONSTRAINT `uq_shift_funding_link_active_target` UNIQUE(`activeTargetShiftId`),
  CONSTRAINT `chk_shift_funding_link_active_state` CHECK (
    (`shiftFundingLinkState` = 'PENDING' AND `activeSourceReceiptId` IS NOT NULL AND `activeSourceReceiptId` = `sourceReceiptId` AND `activeTargetShiftId` IS NOT NULL AND `activeTargetShiftId` = `targetShiftId`)
    OR (`shiftFundingLinkState` = 'CONSUMED' AND `activeSourceReceiptId` IS NOT NULL AND `activeSourceReceiptId` = `sourceReceiptId` AND `activeTargetShiftId` IS NULL)
    OR (`shiftFundingLinkState` = 'RELEASED' AND `activeSourceReceiptId` IS NULL AND `activeTargetShiftId` IS NULL)
  ),
  CONSTRAINT `fk_shift_funding_link_request` FOREIGN KEY (`requestReceiptId`) REFERENCES `receipts`(`id`),
  CONSTRAINT `fk_shift_funding_link_source` FOREIGN KEY (`sourceReceiptId`) REFERENCES `receipts`(`id`),
  CONSTRAINT `fk_shift_funding_link_active_source` FOREIGN KEY (`activeSourceReceiptId`) REFERENCES `receipts`(`id`),
  CONSTRAINT `fk_shift_funding_link_target` FOREIGN KEY (`targetShiftId`) REFERENCES `shifts`(`id`),
  CONSTRAINT `fk_shift_funding_link_active_target` FOREIGN KEY (`activeTargetShiftId`) REFERENCES `shifts`(`id`),
  CONSTRAINT `fk_shift_funding_link_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_shift_funding_link_target_state` ON `shiftFundingSourceLinks` (`targetShiftId`,`shiftFundingLinkState`);
--> statement-breakpoint
CREATE INDEX `idx_shift_funding_link_branch_state` ON `shiftFundingSourceLinks` (`branchId`,`shiftFundingLinkState`);
