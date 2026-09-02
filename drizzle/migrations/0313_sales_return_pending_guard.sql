-- 0313 — حوكمة العمليات الحرجة على فواتير البيع.
-- الطلب PENDING صفر الأثر. الاعتماد وحده يقفل الطلب والفاتورة، يعيد مطابقة اللقطة والبصمة،
-- ينفّذ الأثر المالي/المخزني، ثم يختم الطلب داخل المعاملة نفسها.

CREATE TABLE `salesControlRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `invoiceId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `requestType` ENUM('SALES_RETURN','SALES_CANCEL','SALES_REISSUE','SALES_EXCHANGE','SALES_DUE_DATE_CHANGE') NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `payload` JSON NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `invoiceSnapshot` JSON NOT NULL,
  `snapshotHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `requestedBy` INT NOT NULL,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewNote` VARCHAR(500) NULL,
  `resultInvoiceId` BIGINT NULL,
  `appliedAt` TIMESTAMP NULL,
  `activeInvoiceId` BIGINT GENERATED ALWAYS AS (CASE WHEN `status` = 'PENDING' THEN `invoiceId` ELSE NULL END) STORED,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `salesControlRequests_requestKey_unique` (`requestKey`),
  UNIQUE KEY `salesControlRequests_active_invoice_unique` (`activeInvoiceId`),
  KEY `idx_sales_control_branch_status` (`branchId`, `status`),
  KEY `idx_sales_control_invoice_status` (`invoiceId`, `status`),
  KEY `idx_sales_control_requester` (`requestedBy`),
  KEY `idx_sales_control_reviewer` (`reviewedBy`),
  CONSTRAINT `fk_sales_control_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`),
  CONSTRAINT `fk_sales_control_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_sales_control_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_sales_control_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_sales_control_result_invoice` FOREIGN KEY (`resultInvoiceId`) REFERENCES `invoices` (`id`),
  CONSTRAINT `chk_sales_control_decision_shape` CHECK (
    (`status` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_sales_control_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `salesExchangeCommands`
  ADD CONSTRAINT `fk_sales_exchange_control_request`
  FOREIGN KEY (`controlRequestId`) REFERENCES `salesControlRequests` (`id`);
