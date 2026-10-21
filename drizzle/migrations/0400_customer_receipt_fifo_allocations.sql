CREATE TABLE `customerReceiptSettlements` (
  `id` bigint AUTO_INCREMENT PRIMARY KEY,
  `receiptId` bigint NOT NULL,
  `customerId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `accountAmount` decimal(15,2) NOT NULL,
  `unallocatedAmount` decimal(15,2) NOT NULL,
  `initialUnallocatedAmount` decimal(15,2) NOT NULL,
  `refundedAmount` decimal(15,2) NOT NULL DEFAULT 0,
  `sourceHash` char(64) NOT NULL,
  `reversalReceiptId` bigint NULL,
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `uq_customer_receipt_settlement` UNIQUE (`receiptId`),
  CONSTRAINT `uq_customer_receipt_reversal` UNIQUE (`reversalReceiptId`),
  CONSTRAINT `fk_crs_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_crs_customer` FOREIGN KEY (`customerId`) REFERENCES `customers` (`id`),
  CONSTRAINT `fk_crs_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_crs_reversal` FOREIGN KEY (`reversalReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_crs_actor` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_crs_money` CHECK (`amount` > 0 AND `accountAmount` >= 0 AND `unallocatedAmount` >= 0 AND `refundedAmount` >= 0 AND `accountAmount` + `unallocatedAmount` + `refundedAmount` <= `amount`),
  INDEX `idx_customer_receipt_scope` (`customerId`, `branchId`)
);
--> statement-breakpoint
CREATE TABLE `customerReceiptCreditUses` (
  `id` bigint AUTO_INCREMENT PRIMARY KEY,
  `settlementId` bigint NOT NULL,
  `receiptId` bigint NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `reversalReceiptId` bigint NULL,
  CONSTRAINT `uq_customer_credit_use` UNIQUE (`settlementId`, `receiptId`),
  CONSTRAINT `fk_ccu_source` FOREIGN KEY (`settlementId`) REFERENCES `customerReceiptSettlements` (`id`),
  CONSTRAINT `fk_ccu_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `fk_ccu_reversal` FOREIGN KEY (`reversalReceiptId`) REFERENCES `receipts` (`id`),
  CONSTRAINT `chk_ccu_money` CHECK (`amount` > 0),
  INDEX `idx_customer_credit_use_receipt` (`receiptId`)
);
--> statement-breakpoint
CREATE TABLE `customerReceiptAllocations` (
  `id` bigint AUTO_INCREMENT PRIMARY KEY,
  `settlementId` bigint NOT NULL,
  `invoiceId` bigint NOT NULL,
  `originalInvoiceId` bigint NOT NULL,
  `originalAmount` decimal(15,2) NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `uq_customer_receipt_invoice` UNIQUE (`settlementId`, `invoiceId`),
  CONSTRAINT `fk_cra_source` FOREIGN KEY (`settlementId`) REFERENCES `customerReceiptSettlements` (`id`),
  CONSTRAINT `fk_cra_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`),
  CONSTRAINT `fk_cra_original` FOREIGN KEY (`originalInvoiceId`) REFERENCES `invoices` (`id`),
  CONSTRAINT `chk_cra_money` CHECK (`amount` >= 0),
  INDEX `idx_customer_receipt_invoice` (`invoiceId`)
);
