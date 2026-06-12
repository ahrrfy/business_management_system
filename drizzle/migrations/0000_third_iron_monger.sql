CREATE TABLE `accountingEntries` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING') NOT NULL,
	`branchId` bigint,
	`invoiceId` bigint,
	`purchaseOrderId` bigint,
	`receiptId` bigint,
	`customerId` bigint,
	`supplierId` bigint,
	`revenue` decimal(15,2) NOT NULL DEFAULT '0',
	`cost` decimal(15,2) NOT NULL DEFAULT '0',
	`profit` decimal(15,2) NOT NULL DEFAULT '0',
	`taxAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`amount` decimal(15,2) NOT NULL DEFAULT '0',
	`entryDate` date NOT NULL,
	`notes` text,
	`dedupeKey` varchar(80),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountingEntries_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_entry_dedupe` UNIQUE(`dedupeKey`)
);
--> statement-breakpoint
CREATE TABLE `attendance` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`employeeId` bigint NOT NULL,
	`attendanceDate` date NOT NULL,
	`checkIn` timestamp,
	`checkOut` timestamp,
	`attendanceStatus` enum('PRESENT','ABSENT','LATE','LEAVE') NOT NULL,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attendance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auditLogs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int,
	`branchId` bigint,
	`action` varchar(100) NOT NULL,
	`entityType` varchar(50) NOT NULL,
	`entityId` varchar(50),
	`oldValue` json,
	`newValue` json,
	`ipAddress` varchar(45),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `branchStock` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`variantId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`quantity` int NOT NULL DEFAULT 0,
	`lastCountedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `branchStock_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stock_variant_branch` UNIQUE(`variantId`,`branchId`)
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`code` varchar(30) NOT NULL,
	`branchType` enum('MAIN','SALES') NOT NULL DEFAULT 'SALES',
	`address` text,
	`phone` varchar(20),
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `branches_id` PRIMARY KEY(`id`),
	CONSTRAINT `branches_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `categories_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`phone` varchar(20),
	`phone2` varchar(20),
	`phone3` varchar(20),
	`whatsapp` varchar(20),
	`address` text,
	`city` varchar(100),
	`district` varchar(100),
	`customerType` enum('فرد','تاجر','مؤسسة','شركة','حكومي') DEFAULT 'فرد',
	`defaultPriceTier` enum('RETAIL','WHOLESALE','GOVERNMENT') NOT NULL DEFAULT 'RETAIL',
	`notes` text,
	`creditLimit` decimal(15,2) DEFAULT '0',
	`currentBalance` decimal(15,2) NOT NULL DEFAULT '0',
	`legacyCode` varchar(40),
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_customer_legacy` UNIQUE(`legacyCode`)
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int,
	`branchId` bigint,
	`firstName` varchar(100) NOT NULL,
	`lastName` varchar(100) NOT NULL,
	`email` varchar(100),
	`phone` varchar(20),
	`position` varchar(100),
	`department` varchar(100),
	`salary` decimal(15,2),
	`hireDate` date,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employees_id` PRIMARY KEY(`id`),
	CONSTRAINT `employees_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`shiftId` bigint,
	`expenseDate` date NOT NULL,
	`expenseCategory` enum('RENT','UTILITIES','SUPPLIES','SALARY','TRANSPORT','MAINTENANCE','MARKETING','OTHER') NOT NULL DEFAULT 'OTHER',
	`amount` decimal(15,2) NOT NULL,
	`expensePaymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET') NOT NULL DEFAULT 'CASH',
	`description` text,
	`referenceNumber` varchar(100),
	`payee` varchar(200),
	`costCenter` varchar(80),
	`isRecurring` boolean DEFAULT false,
	`recurringFrequency` enum('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY'),
	`receiptId` bigint,
	`expenseStatus` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `idempotencyKeys` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`operation` varchar(40) NOT NULL,
	`clientRequestId` varchar(64) NOT NULL,
	`refId` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `idempotencyKeys_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_idempotency_op_key` UNIQUE(`operation`,`clientRequestId`)
);
--> statement-breakpoint
CREATE TABLE `importBatches` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`batchName` varchar(255) NOT NULL,
	`importType` enum('PRODUCTS','CUSTOMERS','SUPPLIERS') NOT NULL,
	`fileName` varchar(255),
	`totalRows` int,
	`successfulRows` int DEFAULT 0,
	`failedRows` int DEFAULT 0,
	`batchStatus` enum('PENDING','PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
	`errorLog` json,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `importBatches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventoryMovements` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`variantId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`movementType` enum('IN','OUT','ADJUST','RETURN','TRANSFER_IN','TRANSFER_OUT') NOT NULL,
	`quantity` int NOT NULL,
	`referenceType` varchar(24),
	`referenceId` bigint,
	`relatedBranchId` bigint,
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventoryMovements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoiceItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint,
	`workOrderId` bigint,
	`quantity` decimal(15,3) NOT NULL,
	`baseQuantity` int NOT NULL,
	`returnedBaseQuantity` int NOT NULL DEFAULT 0,
	`unitPrice` decimal(15,2) NOT NULL,
	`unitCost` decimal(15,2) NOT NULL DEFAULT '0',
	`discountPercent` decimal(5,2) DEFAULT '0',
	`discountAmount` decimal(15,2) DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoiceItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceNumber` varchar(50) NOT NULL,
	`sourceType` enum('POS','ONLINE','ORDER','WORKORDER') NOT NULL,
	`sourceId` varchar(50),
	`branchId` bigint NOT NULL,
	`shiftId` bigint,
	`customerId` bigint,
	`priceTier` enum('RETAIL','WHOLESALE','GOVERNMENT') NOT NULL DEFAULT 'RETAIL',
	`invoiceDate` timestamp NOT NULL DEFAULT (now()),
	`dueDate` date,
	`subtotal` decimal(15,2) NOT NULL,
	`taxAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`discountAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`costTotal` decimal(15,2) NOT NULL DEFAULT '0',
	`cashRoundingAdjustment` decimal(15,2) NOT NULL DEFAULT '0',
	`invoiceStatus` enum('PENDING','CONFIRMED','PAID','PARTIALLY_PAID','CANCELLED','RETURNED') NOT NULL DEFAULT 'PENDING',
	`paidAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`returnedTotal` decimal(15,2) NOT NULL DEFAULT '0',
	`paymentMethod` varchar(20),
	`paymentDate` timestamp,
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_invoiceNumber_unique` UNIQUE(`invoiceNumber`),
	CONSTRAINT `uq_invoice_source` UNIQUE(`sourceType`,`sourceId`)
);
--> statement-breakpoint
CREATE TABLE `onlineOrderItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`onlineOrderId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint,
	`quantity` decimal(15,3) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitPrice` decimal(15,2) NOT NULL,
	`total` decimal(15,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `onlineOrderItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `onlineOrders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`orderNumber` varchar(50) NOT NULL,
	`customerId` bigint NOT NULL,
	`branchId` bigint,
	`invoiceId` bigint,
	`orderDate` timestamp NOT NULL DEFAULT (now()),
	`subtotal` decimal(15,2) NOT NULL,
	`shippingCost` decimal(15,2) NOT NULL DEFAULT '0',
	`taxAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`orderStatus` enum('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`shippingAddress` text,
	`trackingNumber` varchar(100),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `onlineOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `onlineOrders_orderNumber_unique` UNIQUE(`orderNumber`)
);
--> statement-breakpoint
CREATE TABLE `printJobs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`printJobType` enum('INVOICE','SHIFT_REPORT','OPENING_BALANCE','RECEIPT','WORK_ORDER') NOT NULL DEFAULT 'INVOICE',
	`invoiceId` bigint,
	`referenceId` bigint,
	`payload` json,
	`printStatus` enum('PENDING','PRINTING','PRINTED','FAILED') NOT NULL DEFAULT 'PENDING',
	`attempts` int DEFAULT 0,
	`maxAttempts` int DEFAULT 3,
	`errorMessage` text,
	`printedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `printJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `productImages` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`productId` bigint NOT NULL,
	`url` mediumtext NOT NULL,
	`isPrimary` boolean NOT NULL DEFAULT false,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `productImages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `productPrices` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`productUnitId` bigint NOT NULL,
	`priceTier` enum('RETAIL','WHOLESALE','GOVERNMENT') NOT NULL,
	`price` decimal(15,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productPrices_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_price_unit_tier` UNIQUE(`productUnitId`,`priceTier`)
);
--> statement-breakpoint
CREATE TABLE `productUnits` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`variantId` bigint NOT NULL,
	`unitName` varchar(40) NOT NULL,
	`conversionFactor` decimal(15,4) NOT NULL DEFAULT '1',
	`barcode` varchar(64),
	`isBaseUnit` boolean NOT NULL DEFAULT false,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `productUnits_id` PRIMARY KEY(`id`),
	CONSTRAINT `productUnits_barcode_unique` UNIQUE(`barcode`)
);
--> statement-breakpoint
CREATE TABLE `productVariants` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`productId` bigint NOT NULL,
	`sku` varchar(60) NOT NULL,
	`variantName` varchar(255),
	`color` varchar(60),
	`size` varchar(60),
	`costPrice` decimal(15,2) NOT NULL DEFAULT '0',
	`minStock` int DEFAULT 0,
	`reorderPoint` int DEFAULT 0,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productVariants_id` PRIMARY KEY(`id`),
	CONSTRAINT `productVariants_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`productType` varchar(80),
	`brand` varchar(80),
	`modelName` varchar(80),
	`description` text,
	`categoryId` bigint,
	`parentProductId` bigint,
	`isCustomizable` boolean DEFAULT false,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchaseOrderItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`purchaseOrderId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint,
	`quantity` decimal(15,3) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitPrice` decimal(15,2) NOT NULL,
	`total` decimal(15,2) NOT NULL,
	`receivedBaseQuantity` int DEFAULT 0,
	`receivedNet` decimal(15,2) NOT NULL DEFAULT '0',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `purchaseOrderItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchaseOrders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`poNumber` varchar(50) NOT NULL,
	`supplierId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`orderDate` timestamp NOT NULL DEFAULT (now()),
	`expectedDeliveryDate` date,
	`subtotal` decimal(15,2) NOT NULL,
	`taxAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`paidAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`poStatus` enum('DRAFT','SENT','CONFIRMED','RECEIVED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `purchaseOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchaseOrders_poNumber_unique` UNIQUE(`poNumber`)
);
--> statement-breakpoint
CREATE TABLE `quotationItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`quotationId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint NOT NULL,
	`quantity` decimal(15,3) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitPrice` decimal(15,2) NOT NULL,
	`discountAmount` decimal(15,2) DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `quotationItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `quotations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`quoteNumber` varchar(50) NOT NULL,
	`branchId` bigint NOT NULL,
	`customerId` bigint,
	`quotePriceTier` enum('RETAIL','WHOLESALE','GOVERNMENT') NOT NULL DEFAULT 'RETAIL',
	`quoteDate` timestamp NOT NULL DEFAULT (now()),
	`validUntil` date,
	`subtotal` decimal(15,2) NOT NULL,
	`taxAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`discountAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`quoteStatus` enum('DRAFT','SENT','ACCEPTED','REJECTED','CONVERTED','EXPIRED') NOT NULL DEFAULT 'DRAFT',
	`convertedInvoiceId` bigint,
	`notes` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `quotations_id` PRIMARY KEY(`id`),
	CONSTRAINT `quotations_quoteNumber_unique` UNIQUE(`quoteNumber`)
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceId` bigint,
	`workOrderId` bigint,
	`branchId` bigint,
	`shiftId` bigint,
	`direction` enum('IN','OUT') NOT NULL DEFAULT 'IN',
	`amount` decimal(15,2) NOT NULL,
	`paymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET') NOT NULL,
	`referenceNumber` varchar(100),
	`checkNumber` varchar(50),
	`cardLastFour` varchar(4),
	`receiptStatus` enum('PENDING','COMPLETED','FAILED','REVERSED') NOT NULL DEFAULT 'COMPLETED',
	`voucherNumber` varchar(50),
	`voucherPartyType` enum('CUSTOMER','SUPPLIER','OTHER'),
	`partyId` bigint,
	`description` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `receipts_voucherNumber_unique` UNIQUE(`voucherNumber`)
);
--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`userId` int NOT NULL,
	`openingBalance` decimal(15,2) NOT NULL DEFAULT '0',
	`expectedCash` decimal(15,2),
	`countedCash` decimal(15,2),
	`variance` decimal(15,2),
	`shiftStatus` enum('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
	`openGuard` varchar(64),
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`closedAt` timestamp,
	`notes` text,
	CONSTRAINT `shifts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shift_open_guard` UNIQUE(`openGuard`)
);
--> statement-breakpoint
CREATE TABLE `stocktakeAssignments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`sessionId` bigint NOT NULL,
	`name` varchar(120) NOT NULL,
	`method` enum('PIN','USER') NOT NULL,
	`userId` int,
	`pinHash` varchar(255),
	`zone` varchar(120),
	`assignmentStatus` enum('ACTIVE','SUBMITTED') NOT NULL DEFAULT 'ACTIVE',
	`failedPinAttempts` int NOT NULL DEFAULT 0,
	`lockedUntil` timestamp,
	`lastActivityAt` timestamp,
	`submittedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stocktakeAssignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stocktakeCounts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`sessionId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`assignmentId` bigint NOT NULL,
	`kind` enum('FIRST','RECOUNT','VERIFY') NOT NULL,
	`qty` int NOT NULL,
	`unitBreakdown` text,
	`countedByName` varchar(120) NOT NULL,
	`countedByUserId` int,
	`countedAt` timestamp NOT NULL DEFAULT (now()),
	`isConflict` boolean NOT NULL DEFAULT false,
	`resolvedBy` int,
	`resolvedPick` enum('FIRST','VERIFY'),
	`resolvedAt` timestamp,
	`clientRequestId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stocktakeCounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stkcount_request` UNIQUE(`sessionId`,`clientRequestId`)
);
--> statement-breakpoint
CREATE TABLE `stocktakeDecisions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`sessionId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`action` enum('ADJUST','KEEP') NOT NULL,
	`finalQty` int,
	`diffQty` int,
	`value` decimal(15,2),
	`reason` enum('UNSPECIFIED','DAMAGE','LOSS_THEFT','ENTRY_ERROR','PRINT_WASTE') NOT NULL DEFAULT 'UNSPECIFIED',
	`note` text,
	`decidedBy` int,
	`autoApplied` boolean NOT NULL DEFAULT false,
	`decidedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `stocktakeDecisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stkdecision_session_variant` UNIQUE(`sessionId`,`variantId`)
);
--> statement-breakpoint
CREATE TABLE `stocktakeItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`sessionId` bigint NOT NULL,
	`assignmentId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`expectedQty` int NOT NULL,
	`unitCost` decimal(15,2) NOT NULL,
	`recountStatus` enum('PENDING','DONE'),
	`recountRequestedBy` int,
	`recountReason` varchar(255),
	`recountRequestedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stocktakeItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stkitem_session_variant` UNIQUE(`sessionId`,`variantId`)
);
--> statement-breakpoint
CREATE TABLE `stocktakeSessions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`code` varchar(30) NOT NULL,
	`name` varchar(255) NOT NULL,
	`branchId` bigint NOT NULL,
	`scopeType` enum('FULL','MOVING','CATEGORY','MANUAL') NOT NULL,
	`scopeDetail` text,
	`stocktakeStatus` enum('COUNTING','REVIEW','APPROVED','CANCELLED') NOT NULL DEFAULT 'COUNTING',
	`blind` boolean NOT NULL DEFAULT true,
	`thresholdPct` decimal(5,2) NOT NULL DEFAULT '5.00',
	`thresholdValue` decimal(15,2) NOT NULL DEFAULT '25000.00',
	`dualThreshold` decimal(15,2) NOT NULL DEFAULT '150000.00',
	`directUnderThreshold` boolean NOT NULL DEFAULT true,
	`waNotify` boolean NOT NULL DEFAULT true,
	`dupPolicy` enum('VERIFY','BLOCK') NOT NULL DEFAULT 'VERIFY',
	`notes` text,
	`createdBy` int,
	`submittedAt` timestamp,
	`firstSignBy` int,
	`firstSignAt` timestamp,
	`approvedBy` int,
	`approvedAt` timestamp,
	`cancelledBy` int,
	`cancelledAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `stocktakeSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `stocktakeSessions_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`phone` varchar(20),
	`phone2` varchar(20),
	`phone3` varchar(20),
	`email` varchar(320),
	`whatsapp` varchar(20),
	`address` text,
	`city` varchar(100),
	`taxId` varchar(50),
	`productTypes` text,
	`paymentTerms` varchar(100),
	`supplierCategory` varchar(40),
	`leadTimeDays` int,
	`minOrderAmount` decimal(15,2),
	`rating` int,
	`iban` varchar(64),
	`bankName` varchar(120),
	`notes` text,
	`currentBalance` decimal(15,2) NOT NULL DEFAULT '0',
	`legacyCode` varchar(40),
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `suppliers_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_supplier_legacy` UNIQUE(`legacyCode`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`passwordHash` varchar(255),
	`phone` varchar(20),
	`loginMethod` varchar(64) DEFAULT 'local',
	`role` enum('user','admin','manager','cashier','warehouse','accountant','print_operator','sales_rep','purchasing','auditor') NOT NULL DEFAULT 'user',
	`branchId` bigint,
	`isActive` boolean DEFAULT true,
	`jobTitle` varchar(120),
	`hiredAt` date,
	`permissionsOverride` json,
	`mustChangePassword` boolean NOT NULL DEFAULT false,
	`tempPasswordExpiresAt` timestamp,
	`sessionsValidFrom` timestamp NOT NULL DEFAULT (now()),
	`failedLoginAttempts` int NOT NULL DEFAULT 0,
	`lockedUntil` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `workOrderImages` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`workOrderId` bigint NOT NULL,
	`url` mediumtext NOT NULL,
	`caption` varchar(255),
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workOrderImages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workOrderItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`workOrderId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint,
	`quantity` decimal(15,3) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitPrice` decimal(15,2) NOT NULL,
	`discountAmount` decimal(15,2) DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workOrderItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workOrderMaterials` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`workOrderId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitCost` decimal(15,2) NOT NULL DEFAULT '0',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workOrderMaterials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workOrders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`orderNumber` varchar(50) NOT NULL,
	`branchId` bigint NOT NULL,
	`customerId` bigint,
	`baseVariantId` bigint,
	`title` varchar(255) NOT NULL,
	`customizationText` text,
	`quantity` int NOT NULL DEFAULT 1,
	`materialsCost` decimal(15,2) NOT NULL DEFAULT '0',
	`laborCost` decimal(15,2) NOT NULL DEFAULT '0',
	`salePrice` decimal(15,2) NOT NULL DEFAULT '0',
	`receptionChannel` enum('WALK_IN','WHATSAPP','INSTAGRAM','TIKTOK','PHONE','OTHER') DEFAULT 'WALK_IN',
	`channelHandle` varchar(120),
	`woPriority` enum('LOW','NORMAL','URGENT') DEFAULT 'NORMAL',
	`deposit` decimal(15,2) DEFAULT '0',
	`woPaymentMethod` enum('CASH','CARD') DEFAULT 'CASH',
	`paymentReference` varchar(100),
	`paymentReceiptUrl` text,
	`hasDelivery` boolean DEFAULT false,
	`deliveryAddress` text,
	`deliveryCost` decimal(15,2) DEFAULT '0',
	`workOrderStatus` enum('RECEIVED','IN_PROGRESS','READY','DELIVERED','CANCELLED') NOT NULL DEFAULT 'RECEIVED',
	`invoiceId` bigint,
	`assignedTo` int,
	`dueDate` date,
	`deliveredAt` timestamp,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `workOrders_orderNumber_unique` UNIQUE(`orderNumber`)
);
--> statement-breakpoint
ALTER TABLE `accountingEntries` ADD CONSTRAINT `accountingEntries_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountingEntries` ADD CONSTRAINT `accountingEntries_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountingEntries` ADD CONSTRAINT `accountingEntries_receiptId_receipts_id_fk` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountingEntries` ADD CONSTRAINT `accountingEntries_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountingEntries` ADD CONSTRAINT `accountingEntries_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditLogs` ADD CONSTRAINT `auditLogs_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `branchStock` ADD CONSTRAINT `branchStock_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `branchStock` ADD CONSTRAINT `branchStock_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_shiftId_shifts_id_fk` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_receiptId_receipts_id_fk` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `importBatches` ADD CONSTRAINT `importBatches_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD CONSTRAINT `inventoryMovements_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD CONSTRAINT `inventoryMovements_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD CONSTRAINT `inventoryMovements_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `invoiceItems_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `invoiceItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `invoiceItems_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_shiftId_shifts_id_fk` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrderItems` ADD CONSTRAINT `onlineOrderItems_onlineOrderId_onlineOrders_id_fk` FOREIGN KEY (`onlineOrderId`) REFERENCES `onlineOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrderItems` ADD CONSTRAINT `onlineOrderItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrderItems` ADD CONSTRAINT `onlineOrderItems_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD CONSTRAINT `onlineOrders_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD CONSTRAINT `onlineOrders_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD CONSTRAINT `onlineOrders_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `printJobs` ADD CONSTRAINT `printJobs_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productImages` ADD CONSTRAINT `productImages_productId_products_id_fk` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productPrices` ADD CONSTRAINT `productPrices_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productUnits` ADD CONSTRAINT `productUnits_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productVariants` ADD CONSTRAINT `productVariants_productId_products_id_fk` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_categoryId_categories_id_fk` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `purchaseOrderItems_purchaseOrderId_purchaseOrders_id_fk` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `purchaseOrderItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `purchaseOrderItems_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `purchaseOrders_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `purchaseOrders_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `purchaseOrders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotationItems` ADD CONSTRAINT `quotationItems_quotationId_quotations_id_fk` FOREIGN KEY (`quotationId`) REFERENCES `quotations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotationItems` ADD CONSTRAINT `quotationItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotationItems` ADD CONSTRAINT `quotationItems_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotations` ADD CONSTRAINT `quotations_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotations` ADD CONSTRAINT `quotations_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotations` ADD CONSTRAINT `quotations_convertedInvoiceId_invoices_id_fk` FOREIGN KEY (`convertedInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quotations` ADD CONSTRAINT `quotations_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_shiftId_shifts_id_fk` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shifts` ADD CONSTRAINT `shifts_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shifts` ADD CONSTRAINT `shifts_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeAssignments` ADD CONSTRAINT `stocktakeAssignments_sessionId_stocktakeSessions_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `stocktakeSessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeAssignments` ADD CONSTRAINT `stocktakeAssignments_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeCounts` ADD CONSTRAINT `stocktakeCounts_sessionId_stocktakeSessions_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `stocktakeSessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeCounts` ADD CONSTRAINT `stocktakeCounts_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeCounts` ADD CONSTRAINT `stocktakeCounts_assignmentId_stocktakeAssignments_id_fk` FOREIGN KEY (`assignmentId`) REFERENCES `stocktakeAssignments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeCounts` ADD CONSTRAINT `stocktakeCounts_countedByUserId_users_id_fk` FOREIGN KEY (`countedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeCounts` ADD CONSTRAINT `stocktakeCounts_resolvedBy_users_id_fk` FOREIGN KEY (`resolvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeDecisions` ADD CONSTRAINT `stocktakeDecisions_sessionId_stocktakeSessions_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `stocktakeSessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeDecisions` ADD CONSTRAINT `stocktakeDecisions_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeDecisions` ADD CONSTRAINT `stocktakeDecisions_decidedBy_users_id_fk` FOREIGN KEY (`decidedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeItems` ADD CONSTRAINT `stocktakeItems_sessionId_stocktakeSessions_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `stocktakeSessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeItems` ADD CONSTRAINT `stocktakeItems_assignmentId_stocktakeAssignments_id_fk` FOREIGN KEY (`assignmentId`) REFERENCES `stocktakeAssignments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeItems` ADD CONSTRAINT `stocktakeItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeItems` ADD CONSTRAINT `stocktakeItems_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeItems` ADD CONSTRAINT `stocktakeItems_recountRequestedBy_users_id_fk` FOREIGN KEY (`recountRequestedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeSessions` ADD CONSTRAINT `stocktakeSessions_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeSessions` ADD CONSTRAINT `stocktakeSessions_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeSessions` ADD CONSTRAINT `stocktakeSessions_firstSignBy_users_id_fk` FOREIGN KEY (`firstSignBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeSessions` ADD CONSTRAINT `stocktakeSessions_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakeSessions` ADD CONSTRAINT `stocktakeSessions_cancelledBy_users_id_fk` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrderImages` ADD CONSTRAINT `workOrderImages_workOrderId_workOrders_id_fk` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrderItems` ADD CONSTRAINT `workOrderItems_workOrderId_workOrders_id_fk` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrderItems` ADD CONSTRAINT `workOrderItems_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrderItems` ADD CONSTRAINT `workOrderItems_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrderMaterials` ADD CONSTRAINT `workOrderMaterials_workOrderId_workOrders_id_fk` FOREIGN KEY (`workOrderId`) REFERENCES `workOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrderMaterials` ADD CONSTRAINT `workOrderMaterials_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrders` ADD CONSTRAINT `workOrders_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrders` ADD CONSTRAINT `workOrders_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrders` ADD CONSTRAINT `workOrders_baseVariantId_productVariants_id_fk` FOREIGN KEY (`baseVariantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrders` ADD CONSTRAINT `workOrders_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrders` ADD CONSTRAINT `workOrders_assignedTo_users_id_fk` FOREIGN KEY (`assignedTo`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workOrders` ADD CONSTRAINT `workOrders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_entry_type` ON `accountingEntries` (`entryType`);--> statement-breakpoint
CREATE INDEX `idx_entry_invoice` ON `accountingEntries` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `idx_entry_date` ON `accountingEntries` (`entryDate`);--> statement-breakpoint
CREATE INDEX `idx_entry_supplier` ON `accountingEntries` (`supplierId`);--> statement-breakpoint
CREATE INDEX `idx_entry_customer` ON `accountingEntries` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_att_employee` ON `attendance` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_att_date` ON `attendance` (`attendanceDate`);--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `auditLogs` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_audit_branch` ON `auditLogs` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `auditLogs` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_date` ON `auditLogs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_stock_branch` ON `branchStock` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_branch_code` ON `branches` (`code`);--> statement-breakpoint
CREATE INDEX `idx_customer_name` ON `customers` (`name`);--> statement-breakpoint
CREATE INDEX `idx_customer_phone` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_emp_branch` ON `employees` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_emp_active` ON `employees` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_expense_branch` ON `expenses` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_expense_date` ON `expenses` (`expenseDate`);--> statement-breakpoint
CREATE INDEX `idx_expense_category` ON `expenses` (`expenseCategory`);--> statement-breakpoint
CREATE INDEX `idx_expense_status` ON `expenses` (`expenseStatus`);--> statement-breakpoint
CREATE INDEX `idx_import_type` ON `importBatches` (`importType`);--> statement-breakpoint
CREATE INDEX `idx_move_variant` ON `inventoryMovements` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_move_branch` ON `inventoryMovements` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_move_type` ON `inventoryMovements` (`movementType`);--> statement-breakpoint
CREATE INDEX `idx_move_ref` ON `inventoryMovements` (`referenceType`,`referenceId`);--> statement-breakpoint
CREATE INDEX `idx_move_date` ON `inventoryMovements` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_item_invoice` ON `invoiceItems` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `idx_item_variant` ON `invoiceItems` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_item_productUnit` ON `invoiceItems` (`productUnitId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_number` ON `invoices` (`invoiceNumber`);--> statement-breakpoint
CREATE INDEX `idx_invoice_branch` ON `invoices` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_customer` ON `invoices` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_date` ON `invoices` (`invoiceDate`);--> statement-breakpoint
CREATE INDEX `idx_invoice_status` ON `invoices` (`invoiceStatus`);--> statement-breakpoint
CREATE INDEX `idx_invoice_source` ON `invoices` (`sourceType`);--> statement-breakpoint
CREATE INDEX `idx_ooi_order` ON `onlineOrderItems` (`onlineOrderId`);--> statement-breakpoint
CREATE INDEX `idx_order_number` ON `onlineOrders` (`orderNumber`);--> statement-breakpoint
CREATE INDEX `idx_order_customer` ON `onlineOrders` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_order_status` ON `onlineOrders` (`orderStatus`);--> statement-breakpoint
CREATE INDEX `idx_print_status` ON `printJobs` (`printStatus`);--> statement-breakpoint
CREATE INDEX `idx_pimg_product` ON `productImages` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_unit_variant` ON `productUnits` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_unit_barcode` ON `productUnits` (`barcode`);--> statement-breakpoint
CREATE INDEX `idx_variant_product` ON `productVariants` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_variant_sku` ON `productVariants` (`sku`);--> statement-breakpoint
CREATE INDEX `idx_product_name` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `idx_product_category` ON `products` (`categoryId`);--> statement-breakpoint
CREATE INDEX `idx_product_parent` ON `products` (`parentProductId`);--> statement-breakpoint
CREATE INDEX `idx_poi_po` ON `purchaseOrderItems` (`purchaseOrderId`);--> statement-breakpoint
CREATE INDEX `idx_poi_variant` ON `purchaseOrderItems` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_po_number` ON `purchaseOrders` (`poNumber`);--> statement-breakpoint
CREATE INDEX `idx_po_supplier` ON `purchaseOrders` (`supplierId`);--> statement-breakpoint
CREATE INDEX `idx_po_branch` ON `purchaseOrders` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_po_status` ON `purchaseOrders` (`poStatus`);--> statement-breakpoint
CREATE INDEX `idx_qitem_quote` ON `quotationItems` (`quotationId`);--> statement-breakpoint
CREATE INDEX `idx_qitem_variant` ON `quotationItems` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_quote_number` ON `quotations` (`quoteNumber`);--> statement-breakpoint
CREATE INDEX `idx_quote_branch` ON `quotations` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_quote_customer` ON `quotations` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_quote_status` ON `quotations` (`quoteStatus`);--> statement-breakpoint
CREATE INDEX `idx_receipt_invoice` ON `receipts` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `idx_receipt_wo` ON `receipts` (`workOrderId`);--> statement-breakpoint
CREATE INDEX `idx_receipt_branch` ON `receipts` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_receipt_date` ON `receipts` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_receipt_voucher` ON `receipts` (`voucherNumber`);--> statement-breakpoint
CREATE INDEX `idx_receipt_party` ON `receipts` (`voucherPartyType`,`partyId`);--> statement-breakpoint
CREATE INDEX `idx_shift_branch` ON `shifts` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_shift_user` ON `shifts` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_shift_status` ON `shifts` (`shiftStatus`);--> statement-breakpoint
CREATE INDEX `idx_stkassign_session` ON `stocktakeAssignments` (`sessionId`);--> statement-breakpoint
CREATE INDEX `idx_stkcount_session_variant` ON `stocktakeCounts` (`sessionId`,`variantId`);--> statement-breakpoint
CREATE INDEX `idx_stkcount_assignment` ON `stocktakeCounts` (`assignmentId`);--> statement-breakpoint
CREATE INDEX `idx_stkdecision_session` ON `stocktakeDecisions` (`sessionId`);--> statement-breakpoint
CREATE INDEX `idx_stkitem_session` ON `stocktakeItems` (`sessionId`);--> statement-breakpoint
CREATE INDEX `idx_stkitem_assignment` ON `stocktakeItems` (`assignmentId`);--> statement-breakpoint
CREATE INDEX `idx_stocktake_status` ON `stocktakeSessions` (`stocktakeStatus`);--> statement-breakpoint
CREATE INDEX `idx_stocktake_branch` ON `stocktakeSessions` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_supplier_name` ON `suppliers` (`name`);--> statement-breakpoint
CREATE INDEX `idx_supplier_phone` ON `suppliers` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_user_role` ON `users` (`role`);--> statement-breakpoint
CREATE INDEX `idx_woimg_wo` ON `workOrderImages` (`workOrderId`);--> statement-breakpoint
CREATE INDEX `idx_woi_wo` ON `workOrderItems` (`workOrderId`);--> statement-breakpoint
CREATE INDEX `idx_woi_variant` ON `workOrderItems` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_wom_wo` ON `workOrderMaterials` (`workOrderId`);--> statement-breakpoint
CREATE INDEX `idx_wom_variant` ON `workOrderMaterials` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_wo_number` ON `workOrders` (`orderNumber`);--> statement-breakpoint
CREATE INDEX `idx_wo_branch` ON `workOrders` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_wo_customer` ON `workOrders` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_wo_status` ON `workOrders` (`workOrderStatus`);