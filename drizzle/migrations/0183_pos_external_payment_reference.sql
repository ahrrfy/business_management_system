CREATE TABLE `externalPaymentAttempts` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `branchId` bigint NOT NULL,
  `externalPaymentChannel` enum('POS','PRINT_POS') NOT NULL,
  `externalPaymentMethod` enum('CARD','CHECK','TRANSFER','WALLET') NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `providerCode` varchar(32) NOT NULL,
  `accountReference` varchar(80) NOT NULL,
  `deviceId` varchar(64) NOT NULL,
  `externalReference` varchar(100) NOT NULL,
  `normalizedReference` varchar(100) NOT NULL,
  `externalPaymentState` enum('INITIATED','CONFIRMED','FAILED','REVERSED') NOT NULL DEFAULT 'INITIATED',
  `requestId` varchar(80) NOT NULL,
  `createdBy` int NOT NULL,
  `confirmedBy` int,
  `confirmedAt` timestamp NULL,
  `invoiceId` bigint,
  `receiptId` bigint,
  `consumedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `externalPaymentAttempts_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_extpay_reference` UNIQUE(`normalizedReference`),
  CONSTRAINT `uq_extpay_request` UNIQUE(`createdBy`,`requestId`),
  CONSTRAINT `uq_extpay_invoice` UNIQUE(`invoiceId`),
  CONSTRAINT `uq_extpay_receipt` UNIQUE(`receiptId`),
  CONSTRAINT `chk_extpay_amount_positive` CHECK (`amount` > 0),
  CONSTRAINT `chk_extpay_reference_normalized` CHECK (`normalizedReference` = UPPER(TRIM(`externalReference`)) AND `normalizedReference` <> ''),
  CONSTRAINT `chk_extpay_confirmed_evidence` CHECK (
    `externalPaymentState` NOT IN ('CONFIRMED','REVERSED')
    OR (`confirmedBy` IS NOT NULL AND `confirmedAt` IS NOT NULL)
  ),
  CONSTRAINT `chk_extpay_consumption_complete` CHECK (
    (`invoiceId` IS NULL AND `receiptId` IS NULL AND `consumedAt` IS NULL)
    OR (`invoiceId` IS NOT NULL AND `receiptId` IS NOT NULL AND `consumedAt` IS NOT NULL AND `externalPaymentState` IN ('CONFIRMED','REVERSED'))
  ),
  CONSTRAINT `fk_extpay_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_extpay_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_extpay_confirmed_by` FOREIGN KEY (`confirmedBy`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_extpay_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`),
  CONSTRAINT `fk_extpay_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_extpay_branch_state` ON `externalPaymentAttempts` (`branchId`,`externalPaymentState`,`createdAt`);
--> statement-breakpoint
ALTER TABLE `digitalSaleIntents`
  ADD COLUMN `externalPaymentAttemptId` bigint NULL,
  ADD COLUMN `externalPaymentDeviceId` varchar(64) NULL,
  ADD CONSTRAINT `uq_dsi_extpay_attempt` UNIQUE (`externalPaymentAttemptId`),
  ADD CONSTRAINT `fk_dsi_extpay_attempt` FOREIGN KEY (`externalPaymentAttemptId`) REFERENCES `externalPaymentAttempts`(`id`);
