-- 0301 — إذن استلام مخزني مستقل + GRNI + عكس محكوم بفصل الواجبات.
-- الاستلام لا ينشئ AP؛ فاتورة المورد في 0302 هي مستند الاستحقاق.

CREATE TABLE IF NOT EXISTS `goodsReceipts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `receiptNumber` VARCHAR(50) NOT NULL,
  `clientRequestId` VARCHAR(120) NOT NULL,
  `origin` ENUM('NATIVE','LEGACY_AGGREGATE') NOT NULL DEFAULT 'NATIVE',
  `purchaseOrderId` BIGINT NOT NULL,
  `purchaseOrderRevisionId` BIGINT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `status` ENUM('POSTED','PARTIALLY_REVERSED','REVERSED') NOT NULL DEFAULT 'POSTED',
  `version` INT NOT NULL DEFAULT 1,
  `receivedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `supplierDeliveryNote` VARCHAR(160) NULL,
  `currency` ENUM('IQD','USD') NOT NULL,
  `agreedRate` DECIMAL(15,4) NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `usdTotal` DECIMAL(15,2) NULL,
  `notes` VARCHAR(500) NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `createdBy` INT NULL,
  `postedBy` INT NULL,
  `postedAt` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_goods_receipt_number` (`receiptNumber`),
  UNIQUE KEY `uq_goods_receipt_request` (`clientRequestId`),
  UNIQUE KEY `uq_goods_receipt_request_hash` (`clientRequestId`,`payloadHash`),
  KEY `idx_goods_receipt_order_date` (`purchaseOrderId`,`receivedAt`),
  KEY `idx_goods_receipt_branch_status` (`branchId`,`status`),
  KEY `idx_goods_receipt_supplier_date` (`supplierId`,`receivedAt`),
  CONSTRAINT `fk_grn_order` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_grn_revision` FOREIGN KEY (`purchaseOrderRevisionId`) REFERENCES `purchaseOrderRevisions` (`id`),
  CONSTRAINT `fk_grn_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_grn_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_grn_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_grn_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_goods_receipt_amounts` CHECK (`netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`),
  CONSTRAINT `chk_goods_receipt_origin_revision` CHECK (`origin` = 'LEGACY_AGGREGATE' OR (`purchaseOrderRevisionId` IS NOT NULL AND `createdBy` IS NOT NULL)),
  CONSTRAINT `chk_goods_receipt_posting` CHECK (`origin` = 'LEGACY_AGGREGATE' OR (`postedBy` IS NOT NULL AND `postedAt` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `goodsReceiptItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `goodsReceiptId` BIGINT NOT NULL,
  `lineNo` INT NOT NULL,
  `purchaseOrderItemId` BIGINT NOT NULL,
  `purchaseOrderRevisionItemId` BIGINT NULL,
  `variantId` BIGINT NOT NULL,
  `productUnitId` BIGINT NULL,
  `receivedBaseQuantity` INT NOT NULL,
  `acceptedBaseQuantity` INT NOT NULL,
  `rejectedBaseQuantity` INT NOT NULL DEFAULT 0,
  `reversedBaseQuantity` INT NOT NULL DEFAULT 0,
  `returnedBaseQuantity` INT NOT NULL DEFAULT 0,
  `rejectionReason` VARCHAR(500) NULL,
  `unitCostIqd` DECIMAL(15,2) NOT NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `usdAmount` DECIMAL(15,2) NULL,
  `inventoryMovementId` BIGINT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_goods_receipt_inventory_movement` (`inventoryMovementId`),
  UNIQUE KEY `uq_goods_receipt_line` (`goodsReceiptId`,`lineNo`),
  UNIQUE KEY `uq_goods_receipt_order_item` (`goodsReceiptId`,`purchaseOrderItemId`),
  KEY `idx_goods_receipt_item_order` (`purchaseOrderItemId`),
  KEY `idx_goods_receipt_item_revision` (`purchaseOrderRevisionItemId`),
  CONSTRAINT `fk_grn_item_receipt` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goodsReceipts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_grn_item_po_item` FOREIGN KEY (`purchaseOrderItemId`) REFERENCES `purchaseOrderItems` (`id`),
  CONSTRAINT `fk_grn_item_revision_item` FOREIGN KEY (`purchaseOrderRevisionItemId`) REFERENCES `purchaseOrderRevisionItems` (`id`),
  CONSTRAINT `fk_grn_item_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `fk_grn_item_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits` (`id`),
  CONSTRAINT `fk_grn_item_movement` FOREIGN KEY (`inventoryMovementId`) REFERENCES `inventoryMovements` (`id`),
  CONSTRAINT `chk_goods_receipt_item_quantities` CHECK (`receivedBaseQuantity` > 0 AND `acceptedBaseQuantity` >= 0 AND `rejectedBaseQuantity` >= 0 AND `receivedBaseQuantity` = `acceptedBaseQuantity` + `rejectedBaseQuantity` AND `reversedBaseQuantity` >= 0 AND `returnedBaseQuantity` >= 0 AND `reversedBaseQuantity` + `returnedBaseQuantity` <= `acceptedBaseQuantity`),
  CONSTRAINT `chk_goods_receipt_item_amounts` CHECK (`unitCostIqd` >= 0 AND `netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `goodsReceiptReversalRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `goodsReceiptId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `baseReceiptVersion` INT NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `pendingGuard` VARCHAR(180) NULL,
  `requestedBy` INT NOT NULL,
  `requestedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewReason` VARCHAR(500) NULL,
  `decisionKey` VARCHAR(120) NULL,
  `decisionHash` CHAR(64) NULL,
  `appliedAt` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_grn_reversal_request_key` (`requestKey`),
  UNIQUE KEY `uq_grn_reversal_pending` (`pendingGuard`),
  UNIQUE KEY `uq_grn_reversal_decision_key` (`decisionKey`),
  KEY `idx_grn_reversal_request_branch_status` (`branchId`,`status`),
  KEY `idx_grn_reversal_request_receipt_status` (`goodsReceiptId`,`status`),
  CONSTRAINT `fk_grn_rev_req_receipt` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goodsReceipts` (`id`),
  CONSTRAINT `fk_grn_rev_req_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_grn_rev_req_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_grn_rev_req_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_grn_reversal_request_decision` CHECK (
    (`status` = 'PENDING' AND `pendingGuard` IS NOT NULL AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `decisionKey` IS NULL AND `decisionHash` IS NULL AND `appliedAt` IS NULL)
    OR (`status` = 'APPROVED' AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NOT NULL)
    OR (`status` IN ('REJECTED','STALE') AND `pendingGuard` IS NULL AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `decisionKey` IS NOT NULL AND `decisionHash` IS NOT NULL AND `appliedAt` IS NULL)
  ),
  CONSTRAINT `chk_grn_reversal_request_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `goodsReceiptReversalRequestItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestId` BIGINT NOT NULL,
  `goodsReceiptItemId` BIGINT NOT NULL,
  `baseQuantity` INT NOT NULL,
  `reason` VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_grn_reversal_request_item` (`requestId`,`goodsReceiptItemId`),
  CONSTRAINT `fk_grn_rev_req_item_request` FOREIGN KEY (`requestId`) REFERENCES `goodsReceiptReversalRequests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_grn_rev_req_item_receipt_item` FOREIGN KEY (`goodsReceiptItemId`) REFERENCES `goodsReceiptItems` (`id`),
  CONSTRAINT `chk_grn_reversal_request_item_qty` CHECK (`baseQuantity` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `goodsReceiptReversals` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `reversalNumber` VARCHAR(50) NOT NULL,
  `requestId` BIGINT NOT NULL,
  `goodsReceiptId` BIGINT NOT NULL,
  `purchaseOrderId` BIGINT NOT NULL,
  `purchaseOrderRevisionId` BIGINT NOT NULL,
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `postedBy` INT NOT NULL,
  `postedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_grn_reversal_number` (`reversalNumber`),
  UNIQUE KEY `uq_grn_reversal_request` (`requestId`),
  UNIQUE KEY `uq_grn_reversal_hash` (`payloadHash`),
  KEY `idx_grn_reversal_receipt_date` (`goodsReceiptId`,`postedAt`),
  CONSTRAINT `fk_grn_reversal_request` FOREIGN KEY (`requestId`) REFERENCES `goodsReceiptReversalRequests` (`id`),
  CONSTRAINT `fk_grn_reversal_receipt` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goodsReceipts` (`id`),
  CONSTRAINT `fk_grn_reversal_order` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_grn_reversal_revision` FOREIGN KEY (`purchaseOrderRevisionId`) REFERENCES `purchaseOrderRevisions` (`id`),
  CONSTRAINT `fk_grn_reversal_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_grn_reversal_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_grn_reversal_poster` FOREIGN KEY (`postedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_grn_reversal_amounts` CHECK (`netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `goodsReceiptReversalItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `reversalId` BIGINT NOT NULL,
  `goodsReceiptItemId` BIGINT NOT NULL,
  `baseQuantity` INT NOT NULL,
  `netAmount` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `totalAmount` DECIMAL(15,2) NOT NULL,
  `inventoryMovementId` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_grn_reversal_inventory_movement` (`inventoryMovementId`),
  UNIQUE KEY `uq_grn_reversal_item` (`reversalId`,`goodsReceiptItemId`),
  CONSTRAINT `fk_grn_reversal_item_reversal` FOREIGN KEY (`reversalId`) REFERENCES `goodsReceiptReversals` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_grn_reversal_item_receipt_item` FOREIGN KEY (`goodsReceiptItemId`) REFERENCES `goodsReceiptItems` (`id`),
  CONSTRAINT `fk_grn_reversal_item_movement` FOREIGN KEY (`inventoryMovementId`) REFERENCES `inventoryMovements` (`id`),
  CONSTRAINT `chk_grn_reversal_item_shape` CHECK (`baseQuantity` > 0 AND `netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` = `netAmount` + `taxAmount`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `goodsReceiptAccountingLinks` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `linkKey` VARCHAR(160) NOT NULL,
  `goodsReceiptId` BIGINT NOT NULL,
  `reversalId` BIGINT NULL,
  `accountingEntryId` BIGINT NOT NULL,
  `linkType` ENUM('GRNI_RECOGNITION','GRNI_REVERSAL','LEGACY_PURCHASE') NOT NULL,
  `amount` DECIMAL(15,2) NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_grn_accounting_link_key` (`linkKey`),
  UNIQUE KEY `uq_grn_accounting_entry` (`accountingEntryId`),
  KEY `idx_grn_accounting_receipt` (`goodsReceiptId`),
  CONSTRAINT `fk_grn_accounting_receipt` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goodsReceipts` (`id`),
  CONSTRAINT `fk_grn_accounting_reversal` FOREIGN KEY (`reversalId`) REFERENCES `goodsReceiptReversals` (`id`),
  CONSTRAINT `fk_grn_accounting_entry` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`),
  CONSTRAINT `chk_grn_accounting_link_shape` CHECK (`amount` >= 0 AND ((`linkType` = 'GRNI_REVERSAL' AND `reversalId` IS NOT NULL) OR (`linkType` <> 'GRNI_REVERSAL' AND `reversalId` IS NULL)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- ترحيل صادق: إذن مجمّع لكل أمر استُلِم تاريخياً. لا نختلق رقم وصل المورد أو حركة مخزون دقيقة.
INSERT IGNORE INTO `goodsReceipts` (
  `receiptNumber`,`clientRequestId`,`origin`,`purchaseOrderId`,`purchaseOrderRevisionId`,
  `supplierId`,`branchId`,`status`,`receivedAt`,`supplierDeliveryNote`,`currency`,`agreedRate`,
  `netAmount`,`taxAmount`,`totalAmount`,`usdTotal`,`notes`,`payloadCanonical`,`payloadHash`,
  `createdBy`,`postedBy`,`postedAt`,`createdAt`,`updatedAt`
)
SELECT
  CONCAT('LEGACY-GRN-', po.`id`), CONCAT('legacy-grn-', po.`id`), 'LEGACY_AGGREGATE', po.`id`, po.`approvedRevisionId`,
  po.`supplierId`, po.`branchId`, 'POSTED', po.`updatedAt`, NULL, po.`poCurrency`, po.`agreedRate`,
  ROUND(SUM(poi.`receivedNet`), 2),
  COALESCE((SELECT ROUND(SUM(a.`taxAmount`), 2) FROM `accountingEntries` a WHERE a.`purchaseOrderId` = po.`id` AND a.`entryType` = 'PURCHASE'), 0),
  ROUND(SUM(poi.`receivedNet`), 2) + COALESCE((SELECT ROUND(SUM(a.`taxAmount`), 2) FROM `accountingEntries` a WHERE a.`purchaseOrderId` = po.`id` AND a.`entryType` = 'PURCHASE'), 0),
  CASE WHEN po.`poCurrency` = 'USD' THEN ROUND(SUM(poi.`receivedUsd`), 2) ELSE NULL END,
  'ترحيل تاريخي مجمّع؛ تفاصيل دفعات الاستلام الأصلية غير متاحة',
  CAST(JSON_OBJECT('legacy', TRUE, 'purchaseOrderId', po.`id`, 'aggregation', 'PO_RECEIVED_TOTALS') AS CHAR CHARACTER SET utf8mb4),
  SHA2(CONCAT_WS('|','LEGACY-GRN',po.`id`,ROUND(SUM(poi.`receivedNet`),2),ROUND(SUM(poi.`receivedUsd`),2)),256),
  po.`createdBy`, NULL, po.`updatedAt`, po.`createdAt`, po.`updatedAt`
FROM `purchaseOrders` po
JOIN `purchaseOrderItems` poi ON poi.`purchaseOrderId` = po.`id` AND COALESCE(poi.`receivedBaseQuantity`,0) > 0
GROUP BY po.`id`, po.`approvedRevisionId`, po.`supplierId`, po.`branchId`, po.`updatedAt`, po.`poCurrency`, po.`agreedRate`, po.`createdBy`, po.`createdAt`;
--> statement-breakpoint

-- الضريبة التاريخية تبقى على رأس الإذن لأنها لم تُحفظ سطراً سطراً؛ توزيعها هنا سيكون اختلاقاً.
INSERT IGNORE INTO `goodsReceiptItems` (
  `goodsReceiptId`,`lineNo`,`purchaseOrderItemId`,`purchaseOrderRevisionItemId`,`variantId`,`productUnitId`,
  `receivedBaseQuantity`,`acceptedBaseQuantity`,`rejectedBaseQuantity`,`reversedBaseQuantity`,`returnedBaseQuantity`,
  `unitCostIqd`,`netAmount`,`taxAmount`,`totalAmount`,`usdAmount`,`inventoryMovementId`
)
SELECT gr.`id`, ROW_NUMBER() OVER (PARTITION BY poi.`purchaseOrderId` ORDER BY poi.`id`),
  poi.`id`, pri.`id`, poi.`variantId`, poi.`productUnitId`, poi.`receivedBaseQuantity`,
  poi.`receivedBaseQuantity`, 0, 0, COALESCE(poi.`returnedBaseQuantity`,0),
  CASE WHEN poi.`receivedBaseQuantity` > 0 THEN ROUND(poi.`receivedNet` / poi.`receivedBaseQuantity`, 2) ELSE 0 END,
  poi.`receivedNet`, 0, poi.`receivedNet`,
  CASE WHEN po.`poCurrency` = 'USD' THEN poi.`receivedUsd` ELSE NULL END, NULL
FROM `purchaseOrderItems` poi
JOIN `purchaseOrders` po ON po.`id` = poi.`purchaseOrderId`
JOIN `goodsReceipts` gr ON gr.`clientRequestId` = CONCAT('legacy-grn-', po.`id`)
LEFT JOIN `purchaseOrderRevisionItems` pri
  ON pri.`revisionId` = po.`approvedRevisionId`
 AND pri.`lineNo` = (SELECT COUNT(*) FROM `purchaseOrderItems` x WHERE x.`purchaseOrderId` = poi.`purchaseOrderId` AND x.`id` <= poi.`id`)
WHERE COALESCE(poi.`receivedBaseQuantity`,0) > 0;
--> statement-breakpoint

-- كل قيد PURCHASE قديم يبقى مربوطاً بهويته؛ لا نجمع عدة قيود في معرّف محاسبي مختلق.
INSERT IGNORE INTO `goodsReceiptAccountingLinks` (
  `linkKey`,`goodsReceiptId`,`reversalId`,`accountingEntryId`,`linkType`,`amount`,`createdAt`
)
SELECT CONCAT('LEGACY-PURCHASE:', a.`id`), gr.`id`, NULL, a.`id`, 'LEGACY_PURCHASE', ABS(a.`amount`), a.`createdAt`
FROM `accountingEntries` a
JOIN `goodsReceipts` gr ON gr.`purchaseOrderId` = a.`purchaseOrderId` AND gr.`origin` = 'LEGACY_AGGREGATE'
WHERE a.`entryType` = 'PURCHASE';
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_goods_receipts_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_goods_receipts_version_bu`
BEFORE UPDATE ON `goodsReceipts`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
