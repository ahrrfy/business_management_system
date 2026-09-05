-- 0312 — سجل تنفيذ الاستبدال الذري لفواتير البيع.
-- لا يُنشأ الصف إلا داخل معاملة اعتماد طلب SALES_EXCHANGE وبعد نجاح العكس وإصدار البديل
-- وتسوية الفرق. لذلك لا توجد حالة «مرتجع بلا بديل» أو «بديل بلا تسوية» قابلة للحفظ.

CREATE TABLE `salesExchangeCommands` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `controlRequestId` BIGINT NOT NULL,
  `commandKey` VARCHAR(120) NOT NULL,
  `branchId` BIGINT NOT NULL,
  `originalInvoiceId` BIGINT NOT NULL,
  `replacementInvoiceId` BIGINT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `snapshotHash` CHAR(64) NOT NULL,
  `originalTotal` DECIMAL(15,2) NOT NULL,
  `replacementTotal` DECIMAL(15,2) NOT NULL,
  `deltaAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `settlementKind` ENUM('NONE','COLLECT','CASH_REFUND','CUSTOMER_CREDIT','OUTSTANDING') NOT NULL,
  `settlementMethod` ENUM('CASH','CARD','CHECK','TRANSFER','WALLET') NULL,
  `requestedBy` INT NOT NULL,
  `approvedBy` INT NOT NULL,
  `executedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `salesExchangeCommands_controlRequest_unique` (`controlRequestId`),
  UNIQUE KEY `salesExchangeCommands_commandKey_unique` (`commandKey`),
  UNIQUE KEY `salesExchangeCommands_replacement_unique` (`replacementInvoiceId`),
  KEY `idx_sales_exchange_original` (`originalInvoiceId`),
  KEY `idx_sales_exchange_branch_date` (`branchId`, `executedAt`),
  CONSTRAINT `fk_sales_exchange_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_sales_exchange_original` FOREIGN KEY (`originalInvoiceId`) REFERENCES `invoices` (`id`),
  CONSTRAINT `fk_sales_exchange_replacement` FOREIGN KEY (`replacementInvoiceId`) REFERENCES `invoices` (`id`),
  CONSTRAINT `fk_sales_exchange_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_sales_exchange_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_sales_exchange_maker_checker` CHECK (`requestedBy` <> `approvedBy`),
  CONSTRAINT `chk_sales_exchange_delta_nonnegative` CHECK (`deltaAmount` >= 0),
  CONSTRAINT `chk_sales_exchange_invoice_distinct` CHECK (`originalInvoiceId` <> `replacementInvoiceId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
