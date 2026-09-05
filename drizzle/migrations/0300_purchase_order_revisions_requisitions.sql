-- 0300 — مراجعات أوامر الشراء الثابتة وطلبات الشراء الداخلية.
-- الاعتماد يثبت revision بعينها؛ الطلبات المعلّقة صفرية الأثر وتخضع لفصل الواجبات.

CREATE TABLE IF NOT EXISTS `purchaseOrderRevisions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `purchaseOrderId` BIGINT NOT NULL,
  `revisionNo` INT NOT NULL,
  `baseRevisionId` BIGINT NULL,
  `origin` ENUM('NATIVE','LEGACY') NOT NULL DEFAULT 'NATIVE',
  `supplierId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `agreedCurrency` ENUM('IQD','USD') NOT NULL,
  `agreedRate` DECIMAL(15,4) NULL,
  `settlementType` ENUM('CASH','CREDIT') NOT NULL,
  `expectedDeliveryDate` DATE NULL,
  `subtotal` DECIMAL(15,2) NOT NULL,
  `taxAmount` DECIMAL(15,2) NOT NULL,
  `shippingCost` DECIMAL(15,2) NOT NULL,
  `customsCost` DECIMAL(15,2) NOT NULL,
  `invoiceDiscount` DECIMAL(15,2) NOT NULL,
  `total` DECIMAL(15,2) NOT NULL,
  `usdTotal` DECIMAL(15,2) NULL,
  `notesSnapshot` TEXT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `revisionReason` VARCHAR(500) NOT NULL,
  `createdBy` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_po_revision_no` (`purchaseOrderId`, `revisionNo`),
  UNIQUE KEY `uq_po_revision_hash` (`purchaseOrderId`, `payloadHash`),
  KEY `idx_po_revision_branch_time` (`branchId`, `createdAt`),
  CONSTRAINT `fk_po_revision_order` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_po_revision_base` FOREIGN KEY (`baseRevisionId`) REFERENCES `purchaseOrderRevisions` (`id`),
  CONSTRAINT `fk_po_revision_supplier` FOREIGN KEY (`supplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `fk_po_revision_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_po_revision_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_po_revision_number` CHECK (`revisionNo` > 0),
  CONSTRAINT `chk_po_revision_amounts` CHECK (`subtotal` >= 0 AND `taxAmount` >= 0 AND `shippingCost` >= 0 AND `customsCost` >= 0 AND `invoiceDiscount` >= 0 AND `total` >= 0),
  CONSTRAINT `chk_po_revision_native_actor` CHECK (`origin` = 'LEGACY' OR `createdBy` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseOrderRevisionItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `revisionId` BIGINT NOT NULL,
  `lineNo` INT NOT NULL,
  `variantId` BIGINT NOT NULL,
  `productUnitId` BIGINT NULL,
  `quantity` DECIMAL(15,3) NOT NULL,
  `baseQuantity` INT NOT NULL,
  `listUnitPrice` DECIMAL(15,2) NOT NULL,
  `unitPrice` DECIMAL(15,2) NOT NULL,
  `lineTotal` DECIMAL(15,2) NOT NULL,
  `usdListUnitPrice` DECIMAL(15,4) NULL,
  `usdUnitPrice` DECIMAL(15,4) NULL,
  `usdLineTotal` DECIMAL(15,2) NULL,
  `productNameSnapshot` VARCHAR(255) NOT NULL,
  `variantNameSnapshot` VARCHAR(120) NULL,
  `skuSnapshot` VARCHAR(120) NULL,
  `unitNameSnapshot` VARCHAR(80) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_po_revision_line` (`revisionId`, `lineNo`),
  KEY `idx_po_revision_item_variant` (`variantId`),
  CONSTRAINT `fk_po_revision_item_revision` FOREIGN KEY (`revisionId`) REFERENCES `purchaseOrderRevisions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_po_revision_item_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `fk_po_revision_item_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits` (`id`),
  CONSTRAINT `chk_po_revision_item_values` CHECK (`lineNo` > 0 AND `quantity` > 0 AND `baseQuantity` > 0 AND `listUnitPrice` >= 0 AND `unitPrice` >= 0 AND `lineTotal` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseOrderControlRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `purchaseOrderId` BIGINT NOT NULL,
  `revisionId` BIGINT NULL,
  `branchId` BIGINT NOT NULL,
  `kind` ENUM('APPROVE_REVISION','CANCEL_ORDER','EMERGENCY_ORDER') NOT NULL,
  `baseOrderVersion` INT NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `pendingGuard` VARCHAR(160) NULL,
  `requestedBy` INT NOT NULL,
  `requestedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewReason` VARCHAR(500) NULL,
  `appliedAt` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_po_control_request_key` (`requestKey`),
  UNIQUE KEY `uq_po_control_pending` (`pendingGuard`),
  KEY `idx_po_control_branch_status` (`branchId`, `status`),
  KEY `idx_po_control_order_status` (`purchaseOrderId`, `status`),
  CONSTRAINT `fk_po_control_order` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_po_control_revision` FOREIGN KEY (`revisionId`) REFERENCES `purchaseOrderRevisions` (`id`),
  CONSTRAINT `fk_po_control_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_po_control_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_po_control_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_po_control_decision` CHECK (
    (`status` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `appliedAt` IS NULL AND `pendingGuard` IS NOT NULL)
    OR (`status` = 'APPROVED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NOT NULL AND `pendingGuard` IS NULL)
    OR (`status` IN ('REJECTED','STALE') AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NULL AND `pendingGuard` IS NULL)
  ),
  CONSTRAINT `chk_po_control_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseOrderEvents` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `eventKey` VARCHAR(160) NOT NULL,
  `purchaseOrderId` BIGINT NOT NULL,
  `revisionId` BIGINT NULL,
  `requestId` BIGINT NULL,
  `branchId` BIGINT NOT NULL,
  `eventType` VARCHAR(60) NOT NULL,
  `reason` VARCHAR(500) NULL,
  `actorUserId` INT NULL,
  `payloadCanonical` MEDIUMTEXT NOT NULL,
  `previousEventHash` CHAR(64) NULL,
  `eventHash` CHAR(64) NOT NULL,
  `occurredAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_po_event_key` (`eventKey`),
  UNIQUE KEY `uq_po_event_hash` (`eventHash`),
  KEY `idx_po_event_order_time` (`purchaseOrderId`, `occurredAt`),
  KEY `idx_po_event_branch_time` (`branchId`, `occurredAt`),
  CONSTRAINT `fk_po_event_order` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders` (`id`),
  CONSTRAINT `fk_po_event_revision` FOREIGN KEY (`revisionId`) REFERENCES `purchaseOrderRevisions` (`id`),
  CONSTRAINT `fk_po_event_request` FOREIGN KEY (`requestId`) REFERENCES `purchaseOrderControlRequests` (`id`),
  CONSTRAINT `fk_po_event_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_po_event_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseControlSettings` (
  `branchId` BIGINT NOT NULL,
  `requireRequisition` BOOLEAN NOT NULL DEFAULT FALSE,
  `allowEmergencyOrder` BOOLEAN NOT NULL DEFAULT TRUE,
  `requireEmergencyApproval` BOOLEAN NOT NULL DEFAULT TRUE,
  `priceTolerancePercent` DECIMAL(7,4) NOT NULL DEFAULT 0,
  `totalToleranceAmount` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `blockUninvoicedReceiptsAtClose` BOOLEAN NOT NULL DEFAULT TRUE,
  `version` INT NOT NULL DEFAULT 1,
  `updatedBy` INT NULL,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`branchId`),
  CONSTRAINT `fk_purchase_control_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_purchase_control_updater` FOREIGN KEY (`updatedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_control_tolerances` CHECK (`priceTolerancePercent` >= 0 AND `totalToleranceAmount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseRequisitions` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requisitionNumber` VARCHAR(50) NOT NULL,
  `branchId` BIGINT NOT NULL,
  `neededBy` DATE NULL,
  `purpose` VARCHAR(500) NOT NULL,
  `costCenter` VARCHAR(120) NULL,
  `priority` ENUM('LOW','NORMAL','URGENT') NOT NULL DEFAULT 'NORMAL',
  `version` INT NOT NULL DEFAULT 1,
  `status` ENUM('DRAFT','SUBMITTED','APPROVED','PARTIALLY_ORDERED','FULLY_ORDERED','FULFILLED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  `createdBy` INT NOT NULL,
  `submittedBy` INT NULL,
  `submittedAt` TIMESTAMP NULL,
  `approvedBy` INT NULL,
  `approvedAt` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_req_number` (`requisitionNumber`),
  KEY `idx_purchase_req_branch_status` (`branchId`, `status`),
  KEY `idx_purchase_req_needed` (`neededBy`),
  CONSTRAINT `fk_purchase_req_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_purchase_req_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_purchase_req_submitter` FOREIGN KEY (`submittedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_purchase_req_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseRequisitionItems` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requisitionId` BIGINT NOT NULL,
  `lineNo` INT NOT NULL,
  `variantId` BIGINT NOT NULL,
  `productUnitId` BIGINT NULL,
  `requestedBaseQuantity` INT NOT NULL,
  `approvedBaseQuantity` INT NOT NULL DEFAULT 0,
  `orderedBaseQuantity` INT NOT NULL DEFAULT 0,
  `receivedBaseQuantity` INT NOT NULL DEFAULT 0,
  `estimatedUnitPrice` DECIMAL(15,2) NULL,
  `preferredSupplierId` BIGINT NULL,
  `justification` VARCHAR(500) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_req_line` (`requisitionId`, `lineNo`),
  KEY `idx_purchase_req_item_variant` (`variantId`),
  CONSTRAINT `fk_purchase_req_item_req` FOREIGN KEY (`requisitionId`) REFERENCES `purchaseRequisitions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_purchase_req_item_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `fk_purchase_req_item_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits` (`id`),
  CONSTRAINT `fk_purchase_req_item_supplier` FOREIGN KEY (`preferredSupplierId`) REFERENCES `suppliers` (`id`),
  CONSTRAINT `chk_purchase_req_item_quantities` CHECK (`requestedBaseQuantity` > 0 AND `approvedBaseQuantity` >= 0 AND `approvedBaseQuantity` <= `requestedBaseQuantity` AND `orderedBaseQuantity` >= 0 AND `orderedBaseQuantity` <= `approvedBaseQuantity` AND `receivedBaseQuantity` >= 0 AND `receivedBaseQuantity` <= `orderedBaseQuantity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseRequisitionControlRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `requestKey` VARCHAR(120) NOT NULL,
  `requisitionId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `kind` ENUM('APPROVE','CANCEL') NOT NULL,
  `baseVersion` INT NOT NULL,
  `payload` JSON NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED','STALE') NOT NULL DEFAULT 'PENDING',
  `pendingGuard` VARCHAR(160) NULL,
  `requestedBy` INT NOT NULL,
  `requestedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewedBy` INT NULL,
  `reviewedAt` TIMESTAMP NULL,
  `reviewReason` VARCHAR(500) NULL,
  `appliedAt` TIMESTAMP NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchase_req_control_request_key` (`requestKey`),
  UNIQUE KEY `uq_purchase_req_control_pending` (`pendingGuard`),
  KEY `idx_purchase_req_control_branch_status` (`branchId`, `status`),
  CONSTRAINT `fk_purchase_req_control_req` FOREIGN KEY (`requisitionId`) REFERENCES `purchaseRequisitions` (`id`),
  CONSTRAINT `fk_purchase_req_control_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_purchase_req_control_requester` FOREIGN KEY (`requestedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_purchase_req_control_reviewer` FOREIGN KEY (`reviewedBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_purchase_req_control_decision` CHECK (
    (`status` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `appliedAt` IS NULL AND `pendingGuard` IS NOT NULL)
    OR (`status` = 'APPROVED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NOT NULL AND `pendingGuard` IS NULL)
    OR (`status` IN ('REJECTED','STALE') AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NULL AND `pendingGuard` IS NULL)
  ),
  CONSTRAINT `chk_purchase_req_control_maker_checker` CHECK (`reviewedBy` IS NULL OR `reviewedBy` <> `requestedBy`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `purchaseOrderRequisitionAllocations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `purchaseOrderRevisionItemId` BIGINT NOT NULL,
  `requisitionItemId` BIGINT NOT NULL,
  `allocatedBaseQuantity` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_po_req_allocation_pair` (`purchaseOrderRevisionItemId`, `requisitionItemId`),
  KEY `idx_po_req_allocation_req` (`requisitionItemId`),
  CONSTRAINT `fk_po_req_alloc_revision_item` FOREIGN KEY (`purchaseOrderRevisionItemId`) REFERENCES `purchaseOrderRevisionItems` (`id`),
  CONSTRAINT `fk_po_req_alloc_req_item` FOREIGN KEY (`requisitionItemId`) REFERENCES `purchaseRequisitionItems` (`id`),
  CONSTRAINT `chk_po_req_allocation_positive` CHECK (`allocatedBaseQuantity` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- db:push يبني الأعمدة من schema قبل extras؛ الإنتاج التسلسلي يحتاج إضافتها هنا.
SET @missing_po_governance := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'purchaseOrders'
    AND column_name IN ('version','currentRevisionId','approvedRevisionId','lastEditedBy','submittedBy','submittedAt','approvedBy','approvedAt')
);
SET @sql := IF(
  @missing_po_governance = 0,
  'ALTER TABLE `purchaseOrders`
    ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER `notes`,
    ADD COLUMN `currentRevisionId` BIGINT NULL AFTER `version`,
    ADD COLUMN `approvedRevisionId` BIGINT NULL AFTER `currentRevisionId`,
    ADD COLUMN `lastEditedBy` INT NULL AFTER `approvedRevisionId`,
    ADD COLUMN `submittedBy` INT NULL AFTER `lastEditedBy`,
    ADD COLUMN `submittedAt` TIMESTAMP NULL AFTER `submittedBy`,
    ADD COLUMN `approvedBy` INT NULL AFTER `submittedAt`,
    ADD COLUMN `approvedAt` TIMESTAMP NULL AFTER `approvedBy`',
  IF(@missing_po_governance = 8, 'SELECT ''purchaseOrders governance columns exist'' AS msg',
    'SELECT 1 FROM `__partial_purchaseOrders_governance_migration__`')
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- جسر rolling-deploy يُنشأ قبل أول backfill: أي عامل قديم يكتب أثناء الردم يُسجّل
-- OLD/NEW ذرياً في معاملته. ويشمل ITEM تغيّرات الاستلام التي يلتقطها 0301 لاحقاً.
CREATE TABLE IF NOT EXISTS `purchaseOrderCompatibilityWrites` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `purchaseOrderId` BIGINT NOT NULL,
  `purchaseOrderItemId` BIGINT NULL,
  `writeScope` ENUM('ORDER','ITEM') NOT NULL,
  `writeOperation` ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  `beforeCanonical` JSON NULL,
  `afterCanonical` JSON NULL,
  `connectionId` BIGINT NOT NULL,
  `occurredAt` TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_po_compat_order_time` (`purchaseOrderId`,`occurredAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `purchaseOrderCompatibilityCheckpoints` (
  `id` TINYINT NOT NULL,
  `replayedThroughId` BIGINT NOT NULL,
  `updatedAt` TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_po_compat_checkpoint_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_po_compat_order_ai`;
--> statement-breakpoint
CREATE TRIGGER `trg_po_compat_order_ai` AFTER INSERT ON `purchaseOrders` FOR EACH ROW
INSERT INTO `purchaseOrderCompatibilityWrites` (`purchaseOrderId`,`writeScope`,`writeOperation`,`afterCanonical`,`connectionId`)
VALUES (NEW.`id`,'ORDER','INSERT',JSON_OBJECT('status',NEW.`poStatus`,'total',NEW.`total`,'currentRevisionId',NEW.`currentRevisionId`),CONNECTION_ID());
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_po_compat_order_au`;
--> statement-breakpoint
CREATE TRIGGER `trg_po_compat_order_au` AFTER UPDATE ON `purchaseOrders` FOR EACH ROW
INSERT INTO `purchaseOrderCompatibilityWrites` (`purchaseOrderId`,`writeScope`,`writeOperation`,`beforeCanonical`,`afterCanonical`,`connectionId`)
VALUES (NEW.`id`,'ORDER','UPDATE',JSON_OBJECT('status',OLD.`poStatus`,'total',OLD.`total`,'currentRevisionId',OLD.`currentRevisionId`),JSON_OBJECT('status',NEW.`poStatus`,'total',NEW.`total`,'currentRevisionId',NEW.`currentRevisionId`),CONNECTION_ID());
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_po_compat_item_ai`;
--> statement-breakpoint
CREATE TRIGGER `trg_po_compat_item_ai` AFTER INSERT ON `purchaseOrderItems` FOR EACH ROW
INSERT INTO `purchaseOrderCompatibilityWrites` (`purchaseOrderId`,`purchaseOrderItemId`,`writeScope`,`writeOperation`,`afterCanonical`,`connectionId`)
VALUES (NEW.`purchaseOrderId`,NEW.`id`,'ITEM','INSERT',JSON_OBJECT('variantId',NEW.`variantId`,'baseQuantity',NEW.`baseQuantity`,'receivedBaseQuantity',NEW.`receivedBaseQuantity`,'receivedNet',NEW.`receivedNet`),CONNECTION_ID());
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_po_compat_item_au`;
--> statement-breakpoint
CREATE TRIGGER `trg_po_compat_item_au` AFTER UPDATE ON `purchaseOrderItems` FOR EACH ROW
INSERT INTO `purchaseOrderCompatibilityWrites` (`purchaseOrderId`,`purchaseOrderItemId`,`writeScope`,`writeOperation`,`beforeCanonical`,`afterCanonical`,`connectionId`)
VALUES (NEW.`purchaseOrderId`,NEW.`id`,'ITEM','UPDATE',JSON_OBJECT('variantId',OLD.`variantId`,'baseQuantity',OLD.`baseQuantity`,'receivedBaseQuantity',OLD.`receivedBaseQuantity`,'receivedNet',OLD.`receivedNet`),JSON_OBJECT('variantId',NEW.`variantId`,'baseQuantity',NEW.`baseQuantity`,'receivedBaseQuantity',NEW.`receivedBaseQuantity`,'receivedNet',NEW.`receivedNet`),CONNECTION_ID());
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_po_compat_item_ad`;
--> statement-breakpoint
CREATE TRIGGER `trg_po_compat_item_ad` AFTER DELETE ON `purchaseOrderItems` FOR EACH ROW
INSERT INTO `purchaseOrderCompatibilityWrites` (`purchaseOrderId`,`purchaseOrderItemId`,`writeScope`,`writeOperation`,`beforeCanonical`,`connectionId`)
VALUES (OLD.`purchaseOrderId`,OLD.`id`,'ITEM','DELETE',JSON_OBJECT('variantId',OLD.`variantId`,'baseQuantity',OLD.`baseQuantity`,'receivedBaseQuantity',OLD.`receivedBaseQuantity`,'receivedNet',OLD.`receivedNet`),CONNECTION_ID());
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_po_compat_writes_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_po_compat_writes_bu` BEFORE UPDATE ON `purchaseOrderCompatibilityWrites` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase compatibility writes are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_po_compat_writes_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_po_compat_writes_bd` BEFORE DELETE ON `purchaseOrderCompatibilityWrites` FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase compatibility writes are append-only';
--> statement-breakpoint
SET @po_compat_backfill_start := COALESCE((SELECT MAX(`id`) FROM `purchaseOrderCompatibilityWrites`), 0);
--> statement-breakpoint

-- ترحيل صادق: revision واحدة لكل PO تاريخي، بلا اختلاق مستخدم حين createdBy مفقود.
INSERT IGNORE INTO `purchaseOrderRevisions` (
  `purchaseOrderId`,`revisionNo`,`origin`,`supplierId`,`branchId`,`agreedCurrency`,`agreedRate`,
  `settlementType`,`expectedDeliveryDate`,`subtotal`,`taxAmount`,`shippingCost`,`customsCost`,
  `invoiceDiscount`,`total`,`usdTotal`,`notesSnapshot`,`payloadCanonical`,`payloadHash`,
  `revisionReason`,`createdBy`,`createdAt`
)
SELECT po.`id`, 1, 'LEGACY', po.`supplierId`, po.`branchId`, po.`poCurrency`, po.`agreedRate`,
  po.`settlementType`, po.`expectedDeliveryDate`, po.`subtotal`, po.`taxAmount`, po.`shippingCost`,
  po.`customsCost`, po.`invoiceDiscount`, po.`total`, po.`usdTotal`, po.`notes`,
  CAST(JSON_OBJECT(
    'legacy', TRUE, 'purchaseOrderId', po.`id`, 'poNumber', po.`poNumber`, 'supplierId', po.`supplierId`,
    'branchId', po.`branchId`, 'currency', po.`poCurrency`, 'settlementType', po.`settlementType`,
    'subtotal', po.`subtotal`, 'taxAmount', po.`taxAmount`, 'shippingCost', po.`shippingCost`,
    'customsCost', po.`customsCost`, 'invoiceDiscount', po.`invoiceDiscount`, 'total', po.`total`
  ) AS CHAR CHARACTER SET utf8mb4),
  SHA2(CONCAT_WS('|','LEGACY',po.`id`,po.`supplierId`,po.`branchId`,po.`poCurrency`,
    po.`settlementType`,po.`subtotal`,po.`taxAmount`,po.`shippingCost`,po.`customsCost`,
    po.`invoiceDiscount`,po.`total`,COALESCE(po.`usdTotal`,'')), 256),
  'ترحيل تاريخي تلقائي', po.`createdBy`, po.`createdAt`
FROM `purchaseOrders` po;
--> statement-breakpoint

INSERT IGNORE INTO `purchaseOrderRevisionItems` (
  `revisionId`,`lineNo`,`variantId`,`productUnitId`,`quantity`,`baseQuantity`,`listUnitPrice`,
  `unitPrice`,`lineTotal`,`usdListUnitPrice`,`usdUnitPrice`,`usdLineTotal`,
  `productNameSnapshot`,`variantNameSnapshot`,`skuSnapshot`,`unitNameSnapshot`
)
SELECT rev.`id`, ROW_NUMBER() OVER (PARTITION BY poi.`purchaseOrderId` ORDER BY poi.`id`),
  poi.`variantId`, poi.`productUnitId`, poi.`quantity`, poi.`baseQuantity`,
  COALESCE(poi.`listUnitPrice`, poi.`unitPrice`), poi.`unitPrice`, poi.`total`,
  COALESCE(poi.`usdListUnitPrice`, poi.`usdUnitPrice`), poi.`usdUnitPrice`, poi.`usdTotal`,
  p.`name`, pv.`variantName`, pv.`sku`, pu.`unitName`
FROM `purchaseOrderItems` poi
JOIN `purchaseOrderRevisions` rev ON rev.`purchaseOrderId` = poi.`purchaseOrderId` AND rev.`revisionNo` = 1
JOIN `productVariants` pv ON pv.`id` = poi.`variantId`
JOIN `products` p ON p.`id` = pv.`productId`
LEFT JOIN `productUnits` pu ON pu.`id` = poi.`productUnitId`;
--> statement-breakpoint

UPDATE `purchaseOrders` po
JOIN `purchaseOrderRevisions` rev ON rev.`purchaseOrderId` = po.`id` AND rev.`revisionNo` = 1
SET po.`currentRevisionId` = COALESCE(po.`currentRevisionId`, rev.`id`),
    po.`approvedRevisionId` = CASE
      WHEN po.`poStatus` IN ('CONFIRMED','RECEIVED','CANCELLED') THEN COALESCE(po.`approvedRevisionId`, rev.`id`)
      ELSE po.`approvedRevisionId`
    END,
    po.`lastEditedBy` = COALESCE(po.`lastEditedBy`, po.`createdBy`);
-- لا ننسب اعتماداً تاريخياً لمنشئ الأمر ولا نختلق وقت اعتماد. approvedRevisionId هنا
-- projection تشغيلي للمستند LEGACY فقط؛ origin/revisionReason يثبتان أن المصدر مجهول الدليل،
-- وتبقى approvedBy/approvedAt NULL حتى لا تستخدمهما خدمات SOD كشهادة مصطنعة.
--> statement-breakpoint

-- قيود projection على PO (تُضاف فقط في مسار الإنتاج الذي لم يبنها db:push).
SET @has_po_revision_fk := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'purchaseOrders'
    AND index_name = 'uq_po_current_revision'
);
SET @sql := IF(@has_po_revision_fk = 0,
  'ALTER TABLE `purchaseOrders`
    ADD UNIQUE KEY `uq_po_current_revision` (`currentRevisionId`),
    ADD UNIQUE KEY `uq_po_approved_revision` (`approvedRevisionId`),
    ADD CONSTRAINT `fk_po_current_revision` FOREIGN KEY (`currentRevisionId`) REFERENCES `purchaseOrderRevisions` (`id`),
    ADD CONSTRAINT `fk_po_approved_revision` FOREIGN KEY (`approvedRevisionId`) REFERENCES `purchaseOrderRevisions` (`id`),
    ADD CONSTRAINT `fk_po_last_editor` FOREIGN KEY (`lastEditedBy`) REFERENCES `users` (`id`),
    ADD CONSTRAINT `fk_po_submitter` FOREIGN KEY (`submittedBy`) REFERENCES `users` (`id`),
    ADD CONSTRAINT `fk_po_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users` (`id`)',
  'SELECT ''purchaseOrders revision constraints exist'' AS msg'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_purchase_orders_version_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_purchase_orders_version_bu`
BEFORE UPDATE ON `purchaseOrders`
FOR EACH ROW
BEGIN
  SET NEW.`version` = OLD.`version` + 1;
END;
--> statement-breakpoint

-- Replay يلتقط high-water ثابتاً. ما يأتي بعده لا يضيع: يبقى في السجل فوق checkpoint
-- ليعالجه الإصدار الجديد، بينما كل ما ≤ high-water يُعاد إسقاطه في revision 1 الآن.
SET @po_compat_replay_high_water := COALESCE((SELECT MAX(`id`) FROM `purchaseOrderCompatibilityWrites`), @po_compat_backfill_start, 0);
--> statement-breakpoint

INSERT IGNORE INTO `purchaseOrderRevisions` (`purchaseOrderId`,`revisionNo`,`origin`,`supplierId`,`branchId`,`agreedCurrency`,`agreedRate`,`settlementType`,`expectedDeliveryDate`,`subtotal`,`taxAmount`,`shippingCost`,`customsCost`,`invoiceDiscount`,`total`,`usdTotal`,`notesSnapshot`,`payloadCanonical`,`payloadHash`,`revisionReason`,`createdBy`,`createdAt`)
SELECT po.`id`,1,'LEGACY',po.`supplierId`,po.`branchId`,po.`poCurrency`,po.`agreedRate`,po.`settlementType`,po.`expectedDeliveryDate`,po.`subtotal`,po.`taxAmount`,po.`shippingCost`,po.`customsCost`,po.`invoiceDiscount`,po.`total`,po.`usdTotal`,po.`notes`,CAST(JSON_OBJECT('legacy',TRUE,'purchaseOrderId',po.`id`,'poNumber',po.`poNumber`,'supplierId',po.`supplierId`,'branchId',po.`branchId`,'currency',po.`poCurrency`,'settlementType',po.`settlementType`,'subtotal',po.`subtotal`,'taxAmount',po.`taxAmount`,'shippingCost',po.`shippingCost`,'customsCost',po.`customsCost`,'invoiceDiscount',po.`invoiceDiscount`,'total',po.`total`) AS CHAR CHARACTER SET utf8mb4),SHA2(CONCAT_WS('|','LEGACY',po.`id`,po.`supplierId`,po.`branchId`,po.`poCurrency`,po.`settlementType`,po.`subtotal`,po.`taxAmount`,po.`shippingCost`,po.`customsCost`,po.`invoiceDiscount`,po.`total`,COALESCE(po.`usdTotal`,'')),256),'ترحيل عامل قديم أثناء نافذة النشر',po.`createdBy`,po.`createdAt`
FROM `purchaseOrders` po
WHERE EXISTS (SELECT 1 FROM `purchaseOrderCompatibilityWrites` cw WHERE cw.`purchaseOrderId` = po.`id` AND cw.`id` > @po_compat_backfill_start AND cw.`id` <= @po_compat_replay_high_water);
--> statement-breakpoint

UPDATE `purchaseOrderRevisions` rev
JOIN `purchaseOrders` po ON po.`id` = rev.`purchaseOrderId`
SET rev.`supplierId` = po.`supplierId`, rev.`branchId` = po.`branchId`,
    rev.`agreedCurrency` = po.`poCurrency`, rev.`agreedRate` = po.`agreedRate`,
    rev.`settlementType` = po.`settlementType`, rev.`expectedDeliveryDate` = po.`expectedDeliveryDate`,
    rev.`subtotal` = po.`subtotal`, rev.`taxAmount` = po.`taxAmount`,
    rev.`shippingCost` = po.`shippingCost`, rev.`customsCost` = po.`customsCost`,
    rev.`invoiceDiscount` = po.`invoiceDiscount`, rev.`total` = po.`total`,
    rev.`usdTotal` = po.`usdTotal`, rev.`notesSnapshot` = po.`notes`,
    rev.`payloadCanonical` = CAST(JSON_OBJECT('legacy', TRUE, 'purchaseOrderId', po.`id`, 'poNumber', po.`poNumber`, 'supplierId', po.`supplierId`, 'branchId', po.`branchId`, 'currency', po.`poCurrency`, 'settlementType', po.`settlementType`, 'subtotal', po.`subtotal`, 'taxAmount', po.`taxAmount`, 'shippingCost', po.`shippingCost`, 'customsCost', po.`customsCost`, 'invoiceDiscount', po.`invoiceDiscount`, 'total', po.`total`) AS CHAR CHARACTER SET utf8mb4),
    rev.`payloadHash` = SHA2(CONCAT_WS('|','LEGACY',po.`id`,po.`supplierId`,po.`branchId`,po.`poCurrency`,po.`settlementType`,po.`subtotal`,po.`taxAmount`,po.`shippingCost`,po.`customsCost`,po.`invoiceDiscount`,po.`total`,COALESCE(po.`usdTotal`,'')), 256)
WHERE rev.`revisionNo` = 1
  AND EXISTS (SELECT 1 FROM `purchaseOrderCompatibilityWrites` cw WHERE cw.`purchaseOrderId` = po.`id` AND cw.`id` > @po_compat_backfill_start AND cw.`id` <= @po_compat_replay_high_water);
--> statement-breakpoint

DELETE pri FROM `purchaseOrderRevisionItems` pri
JOIN `purchaseOrderRevisions` rev ON rev.`id` = pri.`revisionId` AND rev.`revisionNo` = 1
WHERE EXISTS (SELECT 1 FROM `purchaseOrderCompatibilityWrites` cw WHERE cw.`purchaseOrderId` = rev.`purchaseOrderId` AND cw.`id` > @po_compat_backfill_start AND cw.`id` <= @po_compat_replay_high_water);
--> statement-breakpoint

INSERT INTO `purchaseOrderRevisionItems` (`revisionId`,`lineNo`,`variantId`,`productUnitId`,`quantity`,`baseQuantity`,`listUnitPrice`,`unitPrice`,`lineTotal`,`usdListUnitPrice`,`usdUnitPrice`,`usdLineTotal`,`productNameSnapshot`,`variantNameSnapshot`,`skuSnapshot`,`unitNameSnapshot`)
SELECT rev.`id`, ROW_NUMBER() OVER (PARTITION BY poi.`purchaseOrderId` ORDER BY poi.`id`), poi.`variantId`, poi.`productUnitId`, poi.`quantity`, poi.`baseQuantity`, COALESCE(poi.`listUnitPrice`,poi.`unitPrice`), poi.`unitPrice`, poi.`total`, COALESCE(poi.`usdListUnitPrice`,poi.`usdUnitPrice`), poi.`usdUnitPrice`, poi.`usdTotal`, p.`name`, pv.`variantName`, pv.`sku`, pu.`unitName`
FROM `purchaseOrderItems` poi
JOIN `purchaseOrderRevisions` rev ON rev.`purchaseOrderId` = poi.`purchaseOrderId` AND rev.`revisionNo` = 1
JOIN `productVariants` pv ON pv.`id` = poi.`variantId`
JOIN `products` p ON p.`id` = pv.`productId`
LEFT JOIN `productUnits` pu ON pu.`id` = poi.`productUnitId`
WHERE EXISTS (SELECT 1 FROM `purchaseOrderCompatibilityWrites` cw WHERE cw.`purchaseOrderId` = poi.`purchaseOrderId` AND cw.`id` > @po_compat_backfill_start AND cw.`id` <= @po_compat_replay_high_water);
--> statement-breakpoint

INSERT INTO `purchaseOrderCompatibilityCheckpoints` (`id`,`replayedThroughId`) VALUES (1,@po_compat_replay_high_water)
ON DUPLICATE KEY UPDATE `replayedThroughId` = GREATEST(`replayedThroughId`,VALUES(`replayedThroughId`));
--> statement-breakpoint

SET @po_compat_missing_revision := (SELECT COUNT(DISTINCT cw.`purchaseOrderId`) FROM `purchaseOrderCompatibilityWrites` cw LEFT JOIN `purchaseOrderRevisions` rev ON rev.`purchaseOrderId` = cw.`purchaseOrderId` AND rev.`revisionNo` = 1 WHERE cw.`id` <= @po_compat_replay_high_water AND rev.`id` IS NULL);
SET @po_compat_trigger_count := (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('trg_po_compat_order_ai','trg_po_compat_order_au','trg_po_compat_item_ai','trg_po_compat_item_au','trg_po_compat_item_ad','trg_po_compat_writes_bu','trg_po_compat_writes_bd'));
SET @sql := IF(@po_compat_missing_revision = 0 AND @po_compat_trigger_count = 7, 'SELECT ''purchase compatibility high-water verified'' AS msg', 'SELECT 1 FROM `__incomplete_purchase_compatibility_replay__`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
