-- Delivery custody and immutable document snapshots.
-- Additive only: the cut-over reconstructs open physical custody from frozen sale
-- lines without posting inventory, cash, AR, revenue or ledger entries.
CREATE TABLE IF NOT EXISTS `deliveryCustodyItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`consignmentId` bigint NOT NULL,
	`leaderConsignmentId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`sourceType` enum('INVOICE','WORK_ORDER','ONLINE_ORDER','FULFILLMENT_REQUEST','AFTERCARE_EXECUTION') NOT NULL,
	`sourceId` bigint NOT NULL,
	`sourceLineKey` varchar(120) NOT NULL,
	`itemKind` enum('STOCKED_ITEM','BUNDLE_COMPONENT','WORK_ORDER_OUTPUT','AFTERCARE_OUTPUT') NOT NULL,
	`invoiceItemId` bigint,
	`bundleComponentId` bigint,
	`variantId` bigint,
	`originalMovementId` bigint,
	`baseQuantity` int NOT NULL,
	`originalIssueUnitCost` decimal(15,2),
	`originalIssueValue` decimal(15,2),
	`preparedHeldBaseQuantity` int NOT NULL DEFAULT 0,
	`carrierCustodyBaseQuantity` int NOT NULL DEFAULT 0,
	`customerDeliveredBaseQuantity` int NOT NULL DEFAULT 0,
	`returnedPendingInspectionBaseQuantity` int NOT NULL DEFAULT 0,
	`customerOwnedHeldBaseQuantity` int NOT NULL DEFAULT 0,
	`reworkWipBaseQuantity` int NOT NULL DEFAULT 0,
	`restockedClosedBaseQuantity` int NOT NULL DEFAULT 0,
	`damagedClosedBaseQuantity` int NOT NULL DEFAULT 0,
	`reviewStatus` enum('VERIFIED','REVIEW_REQUIRED','RESOLVED') NOT NULL DEFAULT 'VERIFIED',
	`reviewReason` text,
	`version` int NOT NULL DEFAULT 1,
	`createdBy` int,
	`updatedBy` int,
	`closedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deliveryCustodyItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dci_source_line` UNIQUE(`consignmentId`,`sourceLineKey`),
	KEY `idx_dci_shipment` (`leaderConsignmentId`,`reviewStatus`),
	KEY `idx_dci_source` (`sourceType`,`sourceId`),
	KEY `idx_dci_variant` (`variantId`),
	KEY `idx_dci_movement` (`originalMovementId`),
	CONSTRAINT `chk_dci_quantity_conservation` CHECK(
		`baseQuantity` > 0
		AND `preparedHeldBaseQuantity` >= 0
		AND `carrierCustodyBaseQuantity` >= 0
		AND `customerDeliveredBaseQuantity` >= 0
		AND `returnedPendingInspectionBaseQuantity` >= 0
		AND `customerOwnedHeldBaseQuantity` >= 0
		AND `reworkWipBaseQuantity` >= 0
		AND `restockedClosedBaseQuantity` >= 0
		AND `damagedClosedBaseQuantity` >= 0
		AND `preparedHeldBaseQuantity` + `carrierCustodyBaseQuantity`
			+ `customerDeliveredBaseQuantity` + `returnedPendingInspectionBaseQuantity`
			+ `customerOwnedHeldBaseQuantity` + `reworkWipBaseQuantity`
			+ `restockedClosedBaseQuantity` + `damagedClosedBaseQuantity` = `baseQuantity`
	),
	CONSTRAINT `chk_dci_historical_value` CHECK(
		(`originalIssueUnitCost` IS NULL AND `originalIssueValue` IS NULL)
		OR (`originalIssueUnitCost` >= 0 AND `originalIssueValue` >= 0)
	),
	CONSTRAINT `chk_dci_review_reason` CHECK(
		`reviewStatus` <> 'REVIEW_REQUIRED'
		OR (`reviewReason` IS NOT NULL AND CHAR_LENGTH(TRIM(`reviewReason`)) >= 3)
	),
	CONSTRAINT `chk_dci_item_shape` CHECK(
		(`itemKind` = 'STOCKED_ITEM' AND `invoiceItemId` IS NOT NULL AND `bundleComponentId` IS NULL AND `variantId` IS NOT NULL)
		OR (`itemKind` = 'BUNDLE_COMPONENT' AND `invoiceItemId` IS NOT NULL AND `bundleComponentId` IS NOT NULL AND `variantId` IS NOT NULL)
		OR (`itemKind` = 'WORK_ORDER_OUTPUT' AND `bundleComponentId` IS NULL AND `variantId` IS NULL AND `originalMovementId` IS NULL)
		OR (`itemKind` = 'AFTERCARE_OUTPUT' AND `bundleComponentId` IS NULL)
	),
	CONSTRAINT `chk_dci_version` CHECK(`version` > 0),
	CONSTRAINT `fk_dci_consignment` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_leader` FOREIGN KEY (`leaderConsignmentId`) REFERENCES `deliveryConsignments`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_invoice_item` FOREIGN KEY (`invoiceItemId`) REFERENCES `invoiceItems`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_bundle_component` FOREIGN KEY (`bundleComponentId`) REFERENCES `invoiceItemBundleComponents`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_movement` FOREIGN KEY (`originalMovementId`) REFERENCES `inventoryMovements`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dci_updater` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deliveryCustodyEvents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`eventKey` varchar(160) NOT NULL,
	`custodyItemId` bigint NOT NULL,
	`consignmentId` bigint NOT NULL,
	`operationId` varchar(100) NOT NULL,
	`eventType` varchar(60) NOT NULL,
	`fromState` enum('PREPARED_HELD','CARRIER_CUSTODY','CUSTOMER_DELIVERED','RETURNED_PENDING_INSPECTION','CUSTOMER_OWNED_HELD','REWORK_WIP','RESTOCKED_CLOSED','DAMAGED_CLOSED'),
	`toState` enum('PREPARED_HELD','CARRIER_CUSTODY','CUSTOMER_DELIVERED','RETURNED_PENDING_INSPECTION','CUSTOMER_OWNED_HELD','REWORK_WIP','RESTOCKED_CLOSED','DAMAGED_CLOSED') NOT NULL,
	`baseQuantity` int NOT NULL,
	`evidence` json NOT NULL,
	`actorUserId` int,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deliveryCustodyEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dce_event_key` UNIQUE(`eventKey`),
	KEY `idx_dce_item_time` (`custodyItemId`,`occurredAt`),
	KEY `idx_dce_consignment` (`consignmentId`),
	CONSTRAINT `chk_dce_quantity` CHECK(`baseQuantity` > 0),
	CONSTRAINT `chk_dce_transition` CHECK(`fromState` IS NULL OR `fromState` <> `toState`),
	CONSTRAINT `fk_dce_item` FOREIGN KEY (`custodyItemId`) REFERENCES `deliveryCustodyItems`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dce_consignment` FOREIGN KEY (`consignmentId`) REFERENCES `deliveryConsignments`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dce_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deliveryDocumentSnapshots` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`documentNumber` varchar(80) NOT NULL,
	`documentType` enum('INVOICE','SHIPPING_LABEL','DISPATCH_SLIP','DELIVERY_MANIFEST','REMITTANCE_RECEIPT','PARTY_SETTLEMENT','PHYSICAL_RETURN_RECEIPT','SALE_RETURN_RECEIPT','SHORTFALL_VOUCHER','OVERAGE_REFUND','DELIVERY_FEE_REFUND','DELIVERY_FEE_PAYMENT','AFTERCARE_SETTLEMENT','AFTERCARE_WAYBILL') NOT NULL,
	`layout` enum('A4_12MM','THERMAL_80_CONTENT_72','LABEL_80X120_SAFE_3','LABEL_100X150_SAFE_3','MULTIPAGE_PACK') NOT NULL,
	`sourceType` enum('INVOICE','CONSIGNMENT','SHIPMENT','REMITTANCE','RETURN_RECEIPT','AFTERCARE_EXECUTION','AFTERCARE_SETTLEMENT','PARTY_SETTLEMENT') NOT NULL,
	`sourceId` bigint NOT NULL,
	`sourceVersion` varchar(128) NOT NULL,
	`branchId` bigint NOT NULL,
	`shiftId` bigint,
	`eventKey` varchar(160) NOT NULL,
	`eventOccurredAt` timestamp NOT NULL,
	`payload` json NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deliveryDocumentSnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dds_number` UNIQUE(`documentNumber`),
	CONSTRAINT `uq_dds_event_document` UNIQUE(`eventKey`,`documentType`),
	KEY `idx_dds_source` (`sourceType`,`sourceId`,`documentType`),
	KEY `idx_dds_branch_time` (`branchId`,`createdAt`),
	CONSTRAINT `fk_dds_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dds_shift` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_dds_actor` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deliveryDocumentPrints` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`snapshotId` bigint NOT NULL,
	`clientRequestId` varchar(80) NOT NULL,
	`requestHash` char(64) NOT NULL,
	`copyType` enum('ORIGINAL','REPRINT') NOT NULL DEFAULT 'ORIGINAL',
	`reason` varchar(500),
	`printerKey` varchar(120),
	`status` enum('REQUESTED','SENT','FAILED','CANCELLED') NOT NULL DEFAULT 'REQUESTED',
	`requestedBy` int NOT NULL,
	`requestedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`errorMessage` varchar(500),
	CONSTRAINT `deliveryDocumentPrints_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ddp_request` UNIQUE(`clientRequestId`),
	KEY `idx_ddp_snapshot` (`snapshotId`,`requestedAt`),
	CONSTRAINT `chk_ddp_copy_reason` CHECK(`copyType` = 'ORIGINAL' OR (`copyType` = 'REPRINT' AND `reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`reason`)) >= 3)),
	CONSTRAINT `chk_ddp_result` CHECK((`status` = 'FAILED' AND `errorMessage` IS NOT NULL) OR (`status` <> 'FAILED' AND `errorMessage` IS NULL)),
	CONSTRAINT `fk_ddp_snapshot` FOREIGN KEY (`snapshotId`) REFERENCES `deliveryDocumentSnapshots`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `fk_ddp_actor` FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint

-- A return declaration does not move physical custody.  Only the immutable,
-- source-bound receipt event proves that the shop actually received and
-- inspected the parcel.  Aftercare has its own equally definitive writer/event.
DROP TEMPORARY TABLE IF EXISTS `_delivery0405PhysicalReturnReceipt`;
--> statement-breakpoint
CREATE TEMPORARY TABLE `_delivery0405PhysicalReturnReceipt` AS
SELECT DISTINCT cn.`id` AS `consignmentId`
FROM `deliveryConsignments` cn
JOIN `deliveryEvents` receipt ON receipt.`consignmentId`=cn.`id`
WHERE cn.`parcelStatus`='RETURNED' AND cn.`returnedAt` IS NOT NULL AND (
	(receipt.`eventType`='WORKFLOW_RETURN_RECEIVED'
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.version'))='1'
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.inspected'))='true'
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.branchId'))=CAST(cn.`branchId` AS CHAR)
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.sourceType'))=cn.`sourceType`
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.sourceId'))=CAST(cn.`sourceId` AS CHAR)
		AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.invoiceId')), 'null') <=> CAST(cn.`invoiceId` AS CHAR)
		AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.workOrderId')), 'null') <=> CAST(cn.`workOrderId` AS CHAR)
		AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.fulfillmentRequestId')), 'null') <=> CAST(cn.`fulfillmentRequestId` AS CHAR)
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.claimVersion'))=CAST(cn.`codClaimVersion` AS CHAR)
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.dispatchedAt'))=DATE_FORMAT(cn.`dispatchedAt`, '%Y-%m-%dT%H:%i:%s.000Z')
		AND CHAR_LENGTH(TRIM(JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.evidence')))) >= 5)
	OR (receipt.`eventType`='AFTERCARE_RETURNED'
		AND cn.`sourceType`='AFTERCARE_EXECUTION'
		AND JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.aftercareExecutionId'))=CAST(cn.`aftercareExecutionId` AS CHAR)
		AND CHAR_LENGTH(TRIM(JSON_UNQUOTE(JSON_EXTRACT(receipt.`payload`, '$.proof')))) > 0)
)
	AND NOT EXISTS (
		SELECT 1 FROM `deliveryEvents` later
		WHERE later.`consignmentId`=cn.`id` AND later.`id`>receipt.`id`
			AND later.`eventType` IN ('PICKED_UP','OUT_FOR_DELIVERY','REASSIGNED','ASSIGNMENT_REACTIVATED','DELIVERED','AFTERCARE_DELIVERED','WORKFLOW_RETURN_RECEIVED','AFTERCARE_RETURNED')
	);
--> statement-breakpoint
ALTER TABLE `_delivery0405PhysicalReturnReceipt` ADD PRIMARY KEY (`consignmentId`);
--> statement-breakpoint

-- The writers aggregate every physical use of one variant (plain lines plus
-- frozen bundle components) into the first OUT movement, then write one later
-- aggregate movement for service materials.  Match that structural contract;
-- notes are display text and are deliberately not used as evidence.
DROP TEMPORARY TABLE IF EXISTS `_delivery0405PhysicalMovementEvidence`;
--> statement-breakpoint
CREATE TEMPORARY TABLE `_delivery0405PhysicalMovementEvidence` AS
SELECT physical.`invoiceId`, physical.`variantId`,
	CASE WHEN movements.`movementCount` = CASE WHEN COALESCE(service.`serviceBaseQuantity`,0)>0 THEN 2 ELSE 1 END
		AND movements.`referenceTypeCount`=1
		AND firstMovement.`branchId`=inv.`branchId`
		AND firstMovement.`quantity`=physical.`physicalBaseQuantity`
		AND (COALESCE(service.`serviceBaseQuantity`,0)=0 OR (
			movements.`firstMovementId`<>movements.`lastMovementId`
			AND lastMovement.`branchId`=inv.`branchId`
			AND lastMovement.`quantity`=service.`serviceBaseQuantity`
		)) THEN movements.`firstMovementId` ELSE NULL END AS `originalMovementId`,
	CASE WHEN movements.`movementCount` = CASE WHEN COALESCE(service.`serviceBaseQuantity`,0)>0 THEN 2 ELSE 1 END
		AND movements.`referenceTypeCount`=1
		AND firstMovement.`branchId`=inv.`branchId`
		AND firstMovement.`quantity`=physical.`physicalBaseQuantity`
		AND (COALESCE(service.`serviceBaseQuantity`,0)=0 OR (
			movements.`firstMovementId`<>movements.`lastMovementId`
			AND lastMovement.`branchId`=inv.`branchId`
			AND lastMovement.`quantity`=service.`serviceBaseQuantity`
		)) THEN 'VERIFIED' ELSE 'REVIEW_REQUIRED' END AS `reviewStatus`,
	CASE WHEN movements.`movementCount` = CASE WHEN COALESCE(service.`serviceBaseQuantity`,0)>0 THEN 2 ELSE 1 END
		AND movements.`referenceTypeCount`=1
		AND firstMovement.`branchId`=inv.`branchId`
		AND firstMovement.`quantity`=physical.`physicalBaseQuantity`
		AND (COALESCE(service.`serviceBaseQuantity`,0)=0 OR (
			movements.`firstMovementId`<>movements.`lastMovementId`
			AND lastMovement.`branchId`=inv.`branchId`
			AND lastMovement.`quantity`=service.`serviceBaseQuantity`
		)) THEN NULL ELSE 'لا تطابق بنية حركات الصرف المجمعة لقطة البنود ومكوّنات البكج ومواد الخدمة؛ يلزم تدقيق قبل أي إرجاع مخزني' END AS `reviewReason`
FROM (
	SELECT physicalLines.`invoiceId`, physicalLines.`variantId`, SUM(physicalLines.`baseQuantity`) AS `physicalBaseQuantity`
	FROM (
		SELECT ii.`invoiceId`, ii.`variantId`, ii.`baseQuantity`
		FROM `invoiceItems` ii
		JOIN `productVariants` pv ON pv.`id`=ii.`variantId`
		JOIN `products` p ON p.`id`=pv.`productId`
		WHERE p.`isService`=0 AND p.`isBundle`=0 AND COALESCE(p.`productType`,'')<>'DIGITAL_CARD'
		UNION ALL
		SELECT ii.`invoiceId`, bc.`componentVariantId`, bc.`componentBaseQuantity`*ii.`baseQuantity`
		FROM `invoiceItems` ii
		JOIN `invoiceItemBundleComponents` bc ON bc.`invoiceItemId`=ii.`id`
	) physicalLines
	JOIN (SELECT DISTINCT `invoiceId` FROM `deliveryConsignments` WHERE `invoiceId` IS NOT NULL AND `consignmentStatus` IN ('DISPATCHED','DELIVERED','PARTIAL')) openInvoices ON openInvoices.`invoiceId`=physicalLines.`invoiceId`
	GROUP BY physicalLines.`invoiceId`, physicalLines.`variantId`
) physical
JOIN `invoices` inv ON inv.`id`=physical.`invoiceId`
LEFT JOIN (
	SELECT ii.`invoiceId`, ism.`materialVariantId` AS `variantId`, SUM(ism.`baseQuantity`) AS `serviceBaseQuantity`
	FROM `invoiceItemServiceMaterials` ism
	JOIN `invoiceItems` ii ON ii.`id`=ism.`invoiceItemId`
	GROUP BY ii.`invoiceId`, ism.`materialVariantId`
) service ON service.`invoiceId`=physical.`invoiceId` AND service.`variantId`=physical.`variantId`
LEFT JOIN (
	SELECT im.`referenceId` AS `invoiceId`, im.`variantId`, COUNT(*) AS `movementCount`,
		COUNT(DISTINCT im.`referenceType`) AS `referenceTypeCount`, MIN(im.`id`) AS `firstMovementId`, MAX(im.`id`) AS `lastMovementId`
	FROM `inventoryMovements` im
	WHERE im.`referenceType` IN ('INVOICE','PRINT_SALE') AND im.`movementType`='OUT'
	GROUP BY im.`referenceId`, im.`variantId`
) movements ON movements.`invoiceId`=physical.`invoiceId` AND movements.`variantId`=physical.`variantId`
LEFT JOIN `inventoryMovements` firstMovement ON firstMovement.`id`=movements.`firstMovementId`
LEFT JOIN `inventoryMovements` lastMovement ON lastMovement.`id`=movements.`lastMovementId`;
--> statement-breakpoint
ALTER TABLE `_delivery0405PhysicalMovementEvidence` ADD PRIMARY KEY (`invoiceId`,`variantId`);
--> statement-breakpoint

-- Plain stocked invoice lines.  Existing returns are represented only as closed
-- quantity buckets; this migration never creates a RETURN movement.
INSERT IGNORE INTO `deliveryCustodyItems` (
	`consignmentId`,`leaderConsignmentId`,`branchId`,`sourceType`,`sourceId`,`sourceLineKey`,`itemKind`,
	`invoiceItemId`,`variantId`,`originalMovementId`,`baseQuantity`,`originalIssueUnitCost`,`originalIssueValue`,
	`preparedHeldBaseQuantity`,`carrierCustodyBaseQuantity`,`customerDeliveredBaseQuantity`,
	`customerOwnedHeldBaseQuantity`,`restockedClosedBaseQuantity`,`damagedClosedBaseQuantity`,`reviewStatus`,`reviewReason`,`createdBy`,`updatedBy`
)
SELECT
	cn.`id`, COALESCE(sm.`leaderConsignmentId`, cn.`id`), cn.`branchId`, cn.`sourceType`, cn.`sourceId`,
	CONCAT('II:', ii.`id`), 'STOCKED_ITEM', ii.`id`, ii.`variantId`,
	evidence.`originalMovementId`,
	ii.`baseQuantity`, ii.`unitCost`, ii.`lineCost`,
	CASE WHEN receipt.`consignmentId` IS NULL AND cn.`parcelStatus` IN ('ASSIGNED','ACCEPTED','FAILED') AND cn.`pickedUpAt` IS NULL AND cn.`outForDeliveryAt` IS NULL THEN ii.`baseQuantity`-ii.`returnedBaseQuantity` ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus` NOT IN ('ASSIGNED','ACCEPTED','FAILED','DELIVERED') OR cn.`pickedUpAt` IS NOT NULL OR cn.`outForDeliveryAt` IS NOT NULL) AND cn.`parcelStatus` <> 'DELIVERED' AND cn.`courierDeliveredAt` IS NULL THEN ii.`baseQuantity`-ii.`returnedBaseQuantity` ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus`='DELIVERED' OR cn.`courierDeliveredAt` IS NOT NULL) THEN ii.`baseQuantity`-ii.`returnedBaseQuantity` ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NOT NULL THEN ii.`baseQuantity`-ii.`returnedBaseQuantity` ELSE 0 END,
	ii.`returnedRestockedBaseQuantity`, ii.`returnedBaseQuantity`-ii.`returnedRestockedBaseQuantity`,
	COALESCE(evidence.`reviewStatus`,'REVIEW_REQUIRED'),
	CASE WHEN evidence.`reviewStatus`='VERIFIED' THEN NULL ELSE COALESCE(evidence.`reviewReason`,'تعذر إثبات حركة الصرف المجمعة للبند؛ يمنع أي إرجاع مخزني آلي') END,
	cn.`dispatchedBy`, cn.`dispatchedBy`
FROM `deliveryConsignments` cn
LEFT JOIN `deliveryShipmentMembers` sm ON sm.`consignmentId`=cn.`id`
LEFT JOIN `_delivery0405PhysicalReturnReceipt` receipt ON receipt.`consignmentId`=cn.`id`
JOIN `invoiceItems` ii ON ii.`invoiceId`=cn.`invoiceId`
JOIN `productVariants` pv ON pv.`id`=ii.`variantId`
JOIN `products` p ON p.`id`=pv.`productId`
LEFT JOIN `_delivery0405PhysicalMovementEvidence` evidence ON evidence.`invoiceId`=ii.`invoiceId` AND evidence.`variantId`=ii.`variantId`
WHERE cn.`consignmentStatus` IN ('DISPATCHED','DELIVERED','PARTIAL')
	AND p.`isService`=0 AND p.`isBundle`=0 AND COALESCE(p.`productType`,'') <> 'DIGITAL_CARD';
--> statement-breakpoint

-- Frozen bundle components, not the bundle header.
INSERT IGNORE INTO `deliveryCustodyItems` (
	`consignmentId`,`leaderConsignmentId`,`branchId`,`sourceType`,`sourceId`,`sourceLineKey`,`itemKind`,
	`invoiceItemId`,`bundleComponentId`,`variantId`,`originalMovementId`,`baseQuantity`,`originalIssueUnitCost`,`originalIssueValue`,
	`preparedHeldBaseQuantity`,`carrierCustodyBaseQuantity`,`customerDeliveredBaseQuantity`,
	`customerOwnedHeldBaseQuantity`,`restockedClosedBaseQuantity`,`damagedClosedBaseQuantity`,`reviewStatus`,`reviewReason`,`createdBy`,`updatedBy`
)
SELECT
	cn.`id`, COALESCE(sm.`leaderConsignmentId`, cn.`id`), cn.`branchId`, cn.`sourceType`, cn.`sourceId`,
	CONCAT('BC:', bc.`id`), 'BUNDLE_COMPONENT', ii.`id`, bc.`id`, bc.`componentVariantId`,
	evidence.`originalMovementId`,
	bc.`componentBaseQuantity`*ii.`baseQuantity`, bc.`issueUnitCost`, bc.`issueLineCost`,
	CASE WHEN receipt.`consignmentId` IS NULL AND cn.`parcelStatus` IN ('ASSIGNED','ACCEPTED','FAILED') AND cn.`pickedUpAt` IS NULL AND cn.`outForDeliveryAt` IS NULL THEN bc.`componentBaseQuantity`*(ii.`baseQuantity`-ii.`returnedBaseQuantity`) ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus` NOT IN ('ASSIGNED','ACCEPTED','FAILED','DELIVERED') OR cn.`pickedUpAt` IS NOT NULL OR cn.`outForDeliveryAt` IS NOT NULL) AND cn.`parcelStatus` <> 'DELIVERED' AND cn.`courierDeliveredAt` IS NULL THEN bc.`componentBaseQuantity`*(ii.`baseQuantity`-ii.`returnedBaseQuantity`) ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus`='DELIVERED' OR cn.`courierDeliveredAt` IS NOT NULL) THEN bc.`componentBaseQuantity`*(ii.`baseQuantity`-ii.`returnedBaseQuantity`) ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NOT NULL THEN bc.`componentBaseQuantity`*(ii.`baseQuantity`-ii.`returnedBaseQuantity`) ELSE 0 END,
	bc.`componentBaseQuantity`*ii.`returnedRestockedBaseQuantity`, bc.`componentBaseQuantity`*(ii.`returnedBaseQuantity`-ii.`returnedRestockedBaseQuantity`),
	CASE WHEN bc.`issueUnitCost` IS NOT NULL AND bc.`issueLineCost` IS NOT NULL
		AND evidence.`reviewStatus`='VERIFIED'
		THEN 'VERIFIED' ELSE 'REVIEW_REQUIRED' END,
	CASE WHEN bc.`issueUnitCost` IS NULL OR bc.`issueLineCost` IS NULL THEN 'لقطة تكلفة مكوّن البكج التاريخية مفقودة؛ يمنع التخمين بسعر اليوم' WHEN evidence.`reviewStatus`='VERIFIED' THEN NULL ELSE COALESCE(evidence.`reviewReason`,'تعذر إثبات حركة الصرف المجمعة لمكوّن البكج؛ يلزم تدقيق') END,
	cn.`dispatchedBy`, cn.`dispatchedBy`
FROM `deliveryConsignments` cn
LEFT JOIN `deliveryShipmentMembers` sm ON sm.`consignmentId`=cn.`id`
LEFT JOIN `_delivery0405PhysicalReturnReceipt` receipt ON receipt.`consignmentId`=cn.`id`
JOIN `invoiceItems` ii ON ii.`invoiceId`=cn.`invoiceId`
JOIN `invoiceItemBundleComponents` bc ON bc.`invoiceItemId`=ii.`id`
LEFT JOIN `_delivery0405PhysicalMovementEvidence` evidence ON evidence.`invoiceId`=ii.`invoiceId` AND evidence.`variantId`=bc.`componentVariantId`
WHERE cn.`consignmentStatus` IN ('DISPATCHED','DELIVERED','PARTIAL');
--> statement-breakpoint

DROP TEMPORARY TABLE IF EXISTS `_delivery0405PhysicalMovementEvidence`;
--> statement-breakpoint

-- Customized work-order output is custody only; it never enters branchStock as a finished SKU.
INSERT IGNORE INTO `deliveryCustodyItems` (
	`consignmentId`,`leaderConsignmentId`,`branchId`,`sourceType`,`sourceId`,`sourceLineKey`,`itemKind`,
	`baseQuantity`,`originalIssueUnitCost`,`originalIssueValue`,`preparedHeldBaseQuantity`,
	`carrierCustodyBaseQuantity`,`customerDeliveredBaseQuantity`,`customerOwnedHeldBaseQuantity`,`reviewStatus`,`createdBy`,`updatedBy`
)
SELECT cn.`id`, COALESCE(sm.`leaderConsignmentId`, cn.`id`), cn.`branchId`, cn.`sourceType`, cn.`sourceId`,
	CONCAT('WO:', wo.`id`, ':OUTPUT'), 'WORK_ORDER_OUTPUT', GREATEST(wo.`quantity`,1),
	ROUND(COALESCE(inv.`costTotal`,0)/GREATEST(wo.`quantity`,1),2), COALESCE(inv.`costTotal`,0),
	CASE WHEN receipt.`consignmentId` IS NULL AND cn.`parcelStatus` IN ('ASSIGNED','ACCEPTED','FAILED') AND cn.`pickedUpAt` IS NULL AND cn.`outForDeliveryAt` IS NULL THEN GREATEST(wo.`quantity`,1) ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus` NOT IN ('ASSIGNED','ACCEPTED','FAILED','DELIVERED') OR cn.`pickedUpAt` IS NOT NULL OR cn.`outForDeliveryAt` IS NOT NULL) AND cn.`parcelStatus` <> 'DELIVERED' AND cn.`courierDeliveredAt` IS NULL THEN GREATEST(wo.`quantity`,1) ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus`='DELIVERED' OR cn.`courierDeliveredAt` IS NOT NULL) THEN GREATEST(wo.`quantity`,1) ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NOT NULL THEN GREATEST(wo.`quantity`,1) ELSE 0 END,
	'VERIFIED', cn.`dispatchedBy`, cn.`dispatchedBy`
FROM `deliveryConsignments` cn
LEFT JOIN `deliveryShipmentMembers` sm ON sm.`consignmentId`=cn.`id`
LEFT JOIN `_delivery0405PhysicalReturnReceipt` receipt ON receipt.`consignmentId`=cn.`id`
JOIN `workOrders` wo ON wo.`id`=cn.`workOrderId`
LEFT JOIN `invoices` inv ON inv.`id`=cn.`invoiceId`
WHERE cn.`sourceType`='WORK_ORDER' AND cn.`consignmentStatus` IN ('DISPATCHED','DELIVERED','PARTIAL');
--> statement-breakpoint

-- Aftercare output may be a replacement issue or customer-owned held output.
INSERT IGNORE INTO `deliveryCustodyItems` (
	`consignmentId`,`leaderConsignmentId`,`branchId`,`sourceType`,`sourceId`,`sourceLineKey`,`itemKind`,
	`variantId`,`originalMovementId`,`baseQuantity`,`originalIssueUnitCost`,`originalIssueValue`,
	`preparedHeldBaseQuantity`,`carrierCustodyBaseQuantity`,`customerDeliveredBaseQuantity`,
	`returnedPendingInspectionBaseQuantity`,`customerOwnedHeldBaseQuantity`,`reviewStatus`,`reviewReason`,`createdBy`,`updatedBy`
)
SELECT cn.`id`, COALESCE(sm.`leaderConsignmentId`, cn.`id`), cn.`branchId`, cn.`sourceType`, cn.`sourceId`,
	CONCAT('AE:', ael.`id`), 'AFTERCARE_OUTPUT', ael.`variantId`, ael.`movementId`, ael.`baseQuantity`,
	ael.`unitCost`, ael.`lineCost`,
	CASE WHEN receipt.`consignmentId` IS NULL AND cn.`parcelStatus` IN ('ASSIGNED','ACCEPTED','FAILED') AND cn.`pickedUpAt` IS NULL AND cn.`outForDeliveryAt` IS NULL THEN ael.`baseQuantity`-ael.`returnedBaseQuantity` ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus` NOT IN ('ASSIGNED','ACCEPTED','FAILED','DELIVERED') OR cn.`pickedUpAt` IS NOT NULL OR cn.`outForDeliveryAt` IS NOT NULL) AND cn.`parcelStatus` <> 'DELIVERED' AND cn.`courierDeliveredAt` IS NULL THEN ael.`baseQuantity`-ael.`returnedBaseQuantity` ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL AND (cn.`parcelStatus`='DELIVERED' OR cn.`courierDeliveredAt` IS NOT NULL) THEN ael.`baseQuantity`-ael.`returnedBaseQuantity` ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NULL THEN ael.`returnedBaseQuantity` ELSE 0 END,
	CASE WHEN receipt.`consignmentId` IS NOT NULL THEN ael.`baseQuantity` ELSE 0 END,
	CASE WHEN ael.`variantId` IS NULL OR ael.`lineCost`=0 OR ael.`movementId` IS NOT NULL THEN 'VERIFIED' ELSE 'REVIEW_REQUIRED' END,
	CASE WHEN ael.`variantId` IS NOT NULL AND ael.`lineCost`>0 AND ael.`movementId` IS NULL THEN 'دفعة معالجة مادية بلا حركة صرف أصلية؛ يلزم تدقيق قبل الإرجاع' ELSE NULL END,
	cn.`dispatchedBy`, cn.`dispatchedBy`
FROM `deliveryConsignments` cn
LEFT JOIN `deliveryShipmentMembers` sm ON sm.`consignmentId`=cn.`id`
LEFT JOIN `_delivery0405PhysicalReturnReceipt` receipt ON receipt.`consignmentId`=cn.`id`
JOIN `aftercareExecutionLines` ael ON ael.`executionId`=cn.`aftercareExecutionId` AND ael.`kind`='OUTPUT'
JOIN `aftercareExecutions` ae ON ae.`id`=cn.`aftercareExecutionId`
JOIN `aftercareCases` ac ON ac.`id`=ae.`caseId`
WHERE cn.`sourceType`='AFTERCARE_EXECUTION' AND (
	cn.`consignmentStatus` IN ('DISPATCHED','DELIVERED','PARTIAL')
	OR (cn.`consignmentStatus`='RETURNED' AND receipt.`consignmentId` IS NOT NULL
		AND ae.`status`='RETURNED' AND ac.`status`='IN_PROGRESS'
		AND ael.`returnedBaseQuantity`=ael.`baseQuantity` AND ael.`settledBaseQuantity`=0
		AND NOT EXISTS (SELECT 1 FROM `aftercareExecutionLines` reused WHERE reused.`reusedFromLineId`=ael.`id`))
);
--> statement-breakpoint

DROP TEMPORARY TABLE IF EXISTS `_delivery0405PhysicalReturnReceipt`;
--> statement-breakpoint

-- One immutable cut-over event per non-zero quantity bucket.
INSERT IGNORE INTO `deliveryCustodyEvents`
	(`eventKey`,`custodyItemId`,`consignmentId`,`operationId`,`eventType`,`fromState`,`toState`,`baseQuantity`,`evidence`,`actorUserId`,`occurredAt`)
SELECT CONCAT('0405-MIGRATED-', x.`id`, '-', x.`state`), x.`id`, x.`consignmentId`, 'migration-0405',
	'MIGRATED_OPEN', NULL, x.`state`, x.`qty`, JSON_OBJECT('migration','0405','reviewStatus',x.`reviewStatus`), NULL, x.`createdAt`
FROM (
	SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'PREPARED_HELD' state,`preparedHeldBaseQuantity` qty FROM `deliveryCustodyItems`
	UNION ALL SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'CARRIER_CUSTODY',`carrierCustodyBaseQuantity` FROM `deliveryCustodyItems`
	UNION ALL SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'CUSTOMER_DELIVERED',`customerDeliveredBaseQuantity` FROM `deliveryCustodyItems`
	UNION ALL SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'RETURNED_PENDING_INSPECTION',`returnedPendingInspectionBaseQuantity` FROM `deliveryCustodyItems`
	UNION ALL SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'CUSTOMER_OWNED_HELD',`customerOwnedHeldBaseQuantity` FROM `deliveryCustodyItems`
	UNION ALL SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'REWORK_WIP',`reworkWipBaseQuantity` FROM `deliveryCustodyItems`
	UNION ALL SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'RESTOCKED_CLOSED',`restockedClosedBaseQuantity` FROM `deliveryCustodyItems`
	UNION ALL SELECT `id`,`consignmentId`,`reviewStatus`,`createdAt`,'DAMAGED_CLOSED',`damagedClosedBaseQuantity` FROM `deliveryCustodyItems`
) x
WHERE x.`qty` > 0;
--> statement-breakpoint

-- New service charges accrue to deferred revenue and become revenue only when
-- completion is evidenced. Existing approved rows are stamped as legacy-posted
-- so the completion command never posts their historical revenue/cost twice.
ALTER TABLE `fulfillmentCharges` MODIFY COLUMN `status` enum('DRAFT','APPROVED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT';
--> statement-breakpoint
SET @delivery_0405_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND COLUMN_NAME='completedBy'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD COLUMN `completedBy` int NULL AFTER `approvedAt`');
--> statement-breakpoint
PREPARE delivery_0405_stmt FROM @delivery_0405_ddl;
--> statement-breakpoint
EXECUTE delivery_0405_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_0405_stmt;
--> statement-breakpoint
SET @delivery_0405_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND COLUMN_NAME='completedAt'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD COLUMN `completedAt` timestamp NULL AFTER `completedBy`');
--> statement-breakpoint
PREPARE delivery_0405_stmt FROM @delivery_0405_ddl;
--> statement-breakpoint
EXECUTE delivery_0405_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_0405_stmt;
--> statement-breakpoint
SET @delivery_0405_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND COLUMN_NAME='completionEvidence'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD COLUMN `completionEvidence` text NULL AFTER `completedAt`');
--> statement-breakpoint
PREPARE delivery_0405_stmt FROM @delivery_0405_ddl;
--> statement-breakpoint
EXECUTE delivery_0405_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_0405_stmt;
--> statement-breakpoint
SET @delivery_0405_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND COLUMN_NAME='legacyPostedAt'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD COLUMN `legacyPostedAt` timestamp NULL AFTER `completionEvidence`');
--> statement-breakpoint
PREPARE delivery_0405_stmt FROM @delivery_0405_ddl;
--> statement-breakpoint
EXECUTE delivery_0405_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_0405_stmt;
--> statement-breakpoint
UPDATE `fulfillmentCharges`
SET `legacyPostedAt` = COALESCE(`approvedAt`,`updatedAt`)
WHERE `status`='APPROVED' AND `legacyPostedAt` IS NULL;
--> statement-breakpoint
SET @delivery_0405_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='fk_fc_completer'), 'SELECT 1', 'ALTER TABLE `fulfillmentCharges` ADD CONSTRAINT `fk_fc_completer` FOREIGN KEY (`completedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action');
--> statement-breakpoint
PREPARE delivery_0405_stmt FROM @delivery_0405_ddl;
--> statement-breakpoint
EXECUTE delivery_0405_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_0405_stmt;
--> statement-breakpoint
SET @delivery_0405_ddl = CONCAT('ALTER TABLE `fulfillmentCharges` ', IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_customer'), 'DROP CHECK `chk_fc_customer`, ', ''), 'ADD CONSTRAINT `chk_fc_customer` CHECK(`fulfillmentCharges`.`amount` = 0 OR `fulfillmentCharges`.`customerId` IS NOT NULL OR (`fulfillmentCharges`.`category` = ''SERVICE'' AND `fulfillmentCharges`.`status` IN (''APPROVED'',''COMPLETED'') AND `fulfillmentCharges`.`externalCost` = 0 AND `fulfillmentCharges`.`paidAmount` = `fulfillmentCharges`.`amount` AND `fulfillmentCharges`.`payeeSupplierId` IS NULL AND `fulfillmentCharges`.`payeePartyId` IS NULL AND `fulfillmentCharges`.`payeeUserId` IS NULL AND `fulfillmentCharges`.`payeeName` IS NULL))');
--> statement-breakpoint
PREPARE delivery_0405_stmt FROM @delivery_0405_ddl;
--> statement-breakpoint
EXECUTE delivery_0405_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_0405_stmt;
--> statement-breakpoint
SET @delivery_0405_ddl = CONCAT('ALTER TABLE `fulfillmentCharges` ', IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='fulfillmentCharges' AND CONSTRAINT_NAME='chk_fc_lifecycle'), 'DROP CHECK `chk_fc_lifecycle`, ', ''), 'ADD CONSTRAINT `chk_fc_lifecycle` CHECK((`fulfillmentCharges`.`status` = ''DRAFT'' AND `fulfillmentCharges`.`approvedBy` IS NULL AND `fulfillmentCharges`.`approvedAt` IS NULL AND `fulfillmentCharges`.`completedBy` IS NULL AND `fulfillmentCharges`.`completedAt` IS NULL) OR (`fulfillmentCharges`.`status` = ''APPROVED'' AND `fulfillmentCharges`.`approvedBy` IS NOT NULL AND `fulfillmentCharges`.`approvedAt` IS NOT NULL AND `fulfillmentCharges`.`completedBy` IS NULL AND `fulfillmentCharges`.`completedAt` IS NULL) OR (`fulfillmentCharges`.`status` = ''COMPLETED'' AND `fulfillmentCharges`.`approvedBy` IS NOT NULL AND `fulfillmentCharges`.`approvedAt` IS NOT NULL AND `fulfillmentCharges`.`completedBy` IS NOT NULL AND `fulfillmentCharges`.`completedAt` IS NOT NULL AND `fulfillmentCharges`.`completionEvidence` IS NOT NULL) OR (`fulfillmentCharges`.`status` = ''CANCELLED''))');
--> statement-breakpoint
PREPARE delivery_0405_stmt FROM @delivery_0405_ddl;
--> statement-breakpoint
EXECUTE delivery_0405_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_0405_stmt;
--> statement-breakpoint
INSERT INTO `accounts` (`code`,`name`,`type`,`parentId`,`systemRole`,`isActive`,`sortOrder`,`notes`)
SELECT '2910','إيراد خدمات مؤجل','LIABILITY',parent.`id`,'DEFERRED_REVENUE',1,291,'يُحوّل إلى إيراد خدمات عند إثبات الإكمال فقط'
FROM `accounts` parent
WHERE parent.`code`='2000'
  AND NOT EXISTS (SELECT 1 FROM `accounts` existing WHERE existing.`systemRole`='DEFERRED_REVENUE')
LIMIT 1;
