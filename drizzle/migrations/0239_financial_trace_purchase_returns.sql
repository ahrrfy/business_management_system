-- مرتجع شراء مستقلّ ومربوط ببند أمر الشراء، مع سقف ذري للمُرتجَع.
ALTER TABLE `purchaseOrderItems`
  ADD COLUMN `returnedBaseQuantity` int NOT NULL DEFAULT 0 AFTER `receivedBaseQuantity`;

-- ترحيل حركات المرتجعات المرجعية القديمة. أوامرنا القياسية تملك بنداً واحداً لكل متغيّر؛
-- GREATEST يبقي العداد ضمن المجال المقبول حتى للبيانات القديمة غير المكتملة.
UPDATE `purchaseOrderItems` poi
LEFT JOIN (
  SELECT `referenceId` AS purchaseOrderId, `variantId`, SUM(`quantity`) AS returnedQty
  FROM `inventoryMovements`
  WHERE `referenceType` = 'PURCHASE_RETURN_REF' AND `movementType` = 'OUT'
  GROUP BY `referenceId`, `variantId`
) legacy ON legacy.purchaseOrderId = poi.purchaseOrderId AND legacy.variantId = poi.variantId
SET poi.returnedBaseQuantity = LEAST(poi.receivedBaseQuantity, GREATEST(0, COALESCE(legacy.returnedQty, 0)));

CREATE TABLE `purchaseReturns` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `returnNumber` varchar(50) NOT NULL,
  `clientRequestId` varchar(80) NOT NULL,
  `purchaseOrderId` bigint NOT NULL,
  `supplierId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `accountingEntryId` bigint NULL,
  `settlement` enum('CREDIT','CASH') NOT NULL DEFAULT 'CREDIT',
  `paymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET') NOT NULL DEFAULT 'CASH',
  `netAmount` decimal(15,2) NOT NULL,
  `taxAmount` decimal(15,2) NOT NULL DEFAULT 0,
  `totalAmount` decimal(15,2) NOT NULL,
  `cashRefundAmount` decimal(15,2) NOT NULL DEFAULT 0,
  `creditOffsetAmount` decimal(15,2) NOT NULL DEFAULT 0,
  `reason` varchar(500) NULL,
  `createdBy` int NULL,
  `createdByNameSnapshot` varchar(255) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `purchaseReturns_returnNumber_unique` (`returnNumber`),
  UNIQUE KEY `purchaseReturns_clientRequestId_unique` (`clientRequestId`),
  KEY `idx_purchase_returns_po` (`purchaseOrderId`),
  KEY `idx_purchase_returns_supplier_date` (`supplierId`,`createdAt`),
  KEY `idx_purchase_returns_branch_date` (`branchId`,`createdAt`),
  UNIQUE KEY `purchaseReturns_accountingEntryId_unique` (`accountingEntryId`),
  KEY `purchaseReturns_createdBy_fk` (`createdBy`),
  CONSTRAINT `purchaseReturns_purchaseOrderId_fk` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `purchaseReturns_supplierId_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `purchaseReturns_branchId_fk` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `purchaseReturns_accountingEntryId_fk` FOREIGN KEY (`accountingEntryId`) REFERENCES `accountingEntries` (`id`) ON DELETE SET NULL,
  CONSTRAINT `purchaseReturns_createdBy_fk` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_purchase_returns_amounts` CHECK (`netAmount` >= 0 AND `taxAmount` >= 0 AND `totalAmount` >= 0 AND `cashRefundAmount` >= 0 AND `creditOffsetAmount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `purchaseReturnItems` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `purchaseReturnId` bigint NOT NULL,
  `purchaseOrderItemId` bigint NOT NULL,
  `variantId` bigint NOT NULL,
  `productUnitId` bigint NULL,
  `quantity` decimal(15,3) NOT NULL,
  `baseQuantity` int NOT NULL,
  `unitPrice` decimal(15,2) NOT NULL,
  `lineTotal` decimal(15,2) NOT NULL,
  `productNameSnapshot` varchar(255) NOT NULL,
  `variantNameSnapshot` varchar(120) NULL,
  `unitNameSnapshot` varchar(80) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_purchase_return_items_return` (`purchaseReturnId`),
  KEY `idx_purchase_return_items_po_item` (`purchaseOrderItemId`),
  KEY `purchaseReturnItems_variantId_fk` (`variantId`),
  KEY `purchaseReturnItems_productUnitId_fk` (`productUnitId`),
  CONSTRAINT `purchaseReturnItems_purchaseReturnId_fk` FOREIGN KEY (`purchaseReturnId`) REFERENCES `purchaseReturns` (`id`) ON DELETE CASCADE,
  CONSTRAINT `purchaseReturnItems_purchaseOrderItemId_fk` FOREIGN KEY (`purchaseOrderItemId`) REFERENCES `purchaseOrderItems` (`id`),
  CONSTRAINT `purchaseReturnItems_variantId_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `purchaseReturnItems_productUnitId_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits` (`id`),
  CONSTRAINT `chk_purchase_return_items_values` CHECK (`quantity` > 0 AND `baseQuantity` > 0 AND `unitPrice` >= 0 AND `lineTotal` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `documentPrintEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `requestId` varchar(80) NOT NULL,
  `documentType` varchar(40) NOT NULL,
  `documentId` bigint NULL,
  `branchId` bigint NULL,
  `actorUserId` int NOT NULL,
  `actorNameSnapshot` varchar(255) NOT NULL,
  `channel` enum('BROWSER','PDF','THERMAL','SERVER_BRIDGE') NOT NULL,
  `outcome` enum('REQUESTED','DIALOG_OPENED','DISPATCHED','FAILED') NOT NULL,
  `copies` int NOT NULL DEFAULT 1,
  `failureCode` varchar(80) NULL,
  `reprintOfRequestId` varchar(80) NULL,
  `eventAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_print_event_request_outcome` (`requestId`,`outcome`),
  KEY `idx_print_event_document` (`documentType`,`documentId`,`eventAt`),
  KEY `idx_print_event_actor_date` (`actorUserId`,`eventAt`),
  KEY `idx_print_event_branch_date` (`branchId`,`eventAt`),
  CONSTRAINT `documentPrintEvents_branchId_fk` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `documentPrintEvents_actorUserId_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_print_event_copies` CHECK (`copies` BETWEEN 1 AND 20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
