CREATE TABLE `accountingEntries` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceId` bigint,
	`revenue` decimal(15,2) DEFAULT '0',
	`cost` decimal(15,2) DEFAULT '0',
	`profit` decimal(15,2) DEFAULT '0',
	`taxAmount` decimal(15,2) DEFAULT '0',
	`entryDate` date NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountingEntries_id` PRIMARY KEY(`id`)
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
	`email` varchar(100),
	`phone` varchar(20),
	`address` text,
	`city` varchar(100),
	`country` varchar(100),
	`taxId` varchar(50),
	`creditLimit` decimal(15,2) DEFAULT '0',
	`currentBalance` decimal(15,2) DEFAULT '0',
	`customerType` enum('INDIVIDUAL','BUSINESS') DEFAULT 'INDIVIDUAL',
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int,
	`firstName` varchar(100) NOT NULL,
	`lastName` varchar(100) NOT NULL,
	`email` varchar(100) NOT NULL,
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
CREATE TABLE `importBatches` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`batchName` varchar(255) NOT NULL,
	`importType` enum('PRODUCTS','CUSTOMERS','SUPPLIERS') NOT NULL,
	`fileName` varchar(255),
	`totalRows` int,
	`successfulRows` int DEFAULT 0,
	`failedRows` int DEFAULT 0,
	`batchStatus` enum('PENDING','PROCESSING','COMPLETED','FAILED') DEFAULT 'PENDING',
	`errorLog` json,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `importBatches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventoryMovements` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`productId` bigint NOT NULL,
	`movementType` enum('IN','OUT','ADJUST','RETURN') NOT NULL,
	`quantity` int NOT NULL,
	`referenceType` varchar(20),
	`referenceId` bigint,
	`notes` text,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventoryMovements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoiceItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceId` bigint NOT NULL,
	`productId` bigint NOT NULL,
	`quantity` int NOT NULL,
	`unitPrice` decimal(15,2) NOT NULL,
	`discountPercent` decimal(5,2) DEFAULT '0',
	`discountAmount` decimal(15,2) DEFAULT '0',
	`taxAmount` decimal(15,2) DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoiceItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceNumber` varchar(50) NOT NULL,
	`sourceType` enum('POS','ONLINE','ORDER') NOT NULL,
	`sourceId` varchar(50),
	`customerId` bigint NOT NULL,
	`invoiceDate` timestamp NOT NULL DEFAULT (now()),
	`dueDate` date,
	`subtotal` decimal(15,2) NOT NULL,
	`taxAmount` decimal(15,2) NOT NULL,
	`discountAmount` decimal(15,2) DEFAULT '0',
	`total` decimal(15,2) NOT NULL,
	`status` enum('PENDING','CONFIRMED','PAID','PARTIALLY_PAID','CANCELLED','RETURNED') NOT NULL DEFAULT 'PENDING',
	`paidAmount` decimal(15,2) DEFAULT '0',
	`paymentMethod` varchar(20),
	`paymentDate` timestamp,
	`notes` text,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`syncedAt` timestamp,
	`syncedToServer` boolean DEFAULT false,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_invoiceNumber_unique` UNIQUE(`invoiceNumber`)
);
--> statement-breakpoint
CREATE TABLE `onlineOrderItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`onlineOrderId` bigint NOT NULL,
	`productId` bigint NOT NULL,
	`quantity` int NOT NULL,
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
	`orderDate` timestamp NOT NULL DEFAULT (now()),
	`subtotal` decimal(15,2) NOT NULL,
	`shippingCost` decimal(15,2) DEFAULT '0',
	`taxAmount` decimal(15,2) NOT NULL,
	`total` decimal(15,2) NOT NULL,
	`orderStatus` enum('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED') DEFAULT 'PENDING',
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
	`invoiceId` bigint NOT NULL,
	`printStatus` enum('PENDING','PRINTING','PRINTED','FAILED') DEFAULT 'PENDING',
	`attempts` int DEFAULT 0,
	`maxAttempts` int DEFAULT 3,
	`errorMessage` text,
	`printedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `printJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`sku` varchar(50) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`categoryId` bigint,
	`costPrice` decimal(15,2) NOT NULL,
	`salePrice` decimal(15,2) NOT NULL,
	`wholesalePrice` decimal(15,2),
	`quantityOnHand` int NOT NULL DEFAULT 0,
	`quantityReserved` int DEFAULT 0,
	`minStock` int DEFAULT 10,
	`maxStock` int DEFAULT 1000,
	`reorderPoint` int DEFAULT 50,
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `purchaseOrderItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`purchaseOrderId` bigint NOT NULL,
	`productId` bigint NOT NULL,
	`quantity` int NOT NULL,
	`unitPrice` decimal(15,2) NOT NULL,
	`total` decimal(15,2) NOT NULL,
	`receivedQuantity` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `purchaseOrderItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchaseOrders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`poNumber` varchar(50) NOT NULL,
	`supplierId` bigint NOT NULL,
	`orderDate` timestamp NOT NULL DEFAULT (now()),
	`expectedDeliveryDate` date,
	`subtotal` decimal(15,2) NOT NULL,
	`taxAmount` decimal(15,2) NOT NULL,
	`total` decimal(15,2) NOT NULL,
	`poStatus` enum('DRAFT','SENT','CONFIRMED','RECEIVED','CANCELLED') DEFAULT 'DRAFT',
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `purchaseOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchaseOrders_poNumber_unique` UNIQUE(`poNumber`)
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceId` bigint NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`paymentMethod` enum('CASH','CARD','CHECK','TRANSFER','WALLET') NOT NULL,
	`referenceNumber` varchar(100),
	`checkNumber` varchar(50),
	`cardLastFour` varchar(4),
	`receiptStatus` enum('PENDING','COMPLETED','FAILED','REVERSED') DEFAULT 'COMPLETED',
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `receipts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(100),
	`phone` varchar(20),
	`address` text,
	`city` varchar(100),
	`country` varchar(100),
	`taxId` varchar(50),
	`paymentTerms` varchar(100),
	`isActive` boolean DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `suppliers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('user','admin','manager','cashier','warehouse') NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `users` ADD `phone` varchar(20);--> statement-breakpoint
ALTER TABLE `users` ADD `isActive` boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE `accountingEntries` ADD CONSTRAINT `accountingEntries_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditLogs` ADD CONSTRAINT `auditLogs_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `importBatches` ADD CONSTRAINT `importBatches_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD CONSTRAINT `inventoryMovements_productId_products_id_fk` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD CONSTRAINT `inventoryMovements_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `invoiceItems_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD CONSTRAINT `invoiceItems_productId_products_id_fk` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrderItems` ADD CONSTRAINT `onlineOrderItems_onlineOrderId_onlineOrders_id_fk` FOREIGN KEY (`onlineOrderId`) REFERENCES `onlineOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrderItems` ADD CONSTRAINT `onlineOrderItems_productId_products_id_fk` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD CONSTRAINT `onlineOrders_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `printJobs` ADD CONSTRAINT `printJobs_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_categoryId_categories_id_fk` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `purchaseOrderItems_purchaseOrderId_purchaseOrders_id_fk` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrderItems` ADD CONSTRAINT `purchaseOrderItems_productId_products_id_fk` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `purchaseOrders_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `purchaseOrders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_accounting_invoice` ON `accountingEntries` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `idx_accounting_date` ON `accountingEntries` (`entryDate`);--> statement-breakpoint
CREATE INDEX `idx_attendance_employee` ON `attendance` (`employeeId`);--> statement-breakpoint
CREATE INDEX `idx_attendance_date` ON `attendance` (`attendanceDate`);--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `auditLogs` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `auditLogs` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_date` ON `auditLogs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_customer_name` ON `customers` (`name`);--> statement-breakpoint
CREATE INDEX `idx_customer_phone` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_customer_email` ON `customers` (`email`);--> statement-breakpoint
CREATE INDEX `idx_customer_active` ON `customers` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_employee_email` ON `employees` (`email`);--> statement-breakpoint
CREATE INDEX `idx_employee_active` ON `employees` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_import_type` ON `importBatches` (`importType`);--> statement-breakpoint
CREATE INDEX `idx_import_status` ON `importBatches` (`batchStatus`);--> statement-breakpoint
CREATE INDEX `idx_inventory_product` ON `inventoryMovements` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_inventory_type` ON `inventoryMovements` (`movementType`);--> statement-breakpoint
CREATE INDEX `idx_inventory_date` ON `inventoryMovements` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_invoice_items_invoice` ON `invoiceItems` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_items_product` ON `invoiceItems` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_number` ON `invoices` (`invoiceNumber`);--> statement-breakpoint
CREATE INDEX `idx_invoice_customer` ON `invoices` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_date` ON `invoices` (`invoiceDate`);--> statement-breakpoint
CREATE INDEX `idx_invoice_status` ON `invoices` (`status`);--> statement-breakpoint
CREATE INDEX `idx_invoice_source` ON `invoices` (`sourceType`);--> statement-breakpoint
CREATE INDEX `idx_invoice_synced` ON `invoices` (`syncedToServer`);--> statement-breakpoint
CREATE INDEX `idx_oo_order` ON `onlineOrderItems` (`onlineOrderId`);--> statement-breakpoint
CREATE INDEX `idx_oo_product` ON `onlineOrderItems` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_order_number` ON `onlineOrders` (`orderNumber`);--> statement-breakpoint
CREATE INDEX `idx_order_customer` ON `onlineOrders` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_order_status` ON `onlineOrders` (`orderStatus`);--> statement-breakpoint
CREATE INDEX `idx_order_date` ON `onlineOrders` (`orderDate`);--> statement-breakpoint
CREATE INDEX `idx_print_invoice` ON `printJobs` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `idx_print_status` ON `printJobs` (`printStatus`);--> statement-breakpoint
CREATE INDEX `idx_product_sku` ON `products` (`sku`);--> statement-breakpoint
CREATE INDEX `idx_product_name` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `idx_product_category` ON `products` (`categoryId`);--> statement-breakpoint
CREATE INDEX `idx_product_active` ON `products` (`isActive`);--> statement-breakpoint
CREATE INDEX `idx_poi_po` ON `purchaseOrderItems` (`purchaseOrderId`);--> statement-breakpoint
CREATE INDEX `idx_poi_product` ON `purchaseOrderItems` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_po_number` ON `purchaseOrders` (`poNumber`);--> statement-breakpoint
CREATE INDEX `idx_po_supplier` ON `purchaseOrders` (`supplierId`);--> statement-breakpoint
CREATE INDEX `idx_po_status` ON `purchaseOrders` (`poStatus`);--> statement-breakpoint
CREATE INDEX `idx_receipt_invoice` ON `receipts` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `idx_receipt_date` ON `receipts` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_receipt_method` ON `receipts` (`paymentMethod`);--> statement-breakpoint
CREATE INDEX `idx_supplier_name` ON `suppliers` (`name`);--> statement-breakpoint
CREATE INDEX `idx_supplier_phone` ON `suppliers` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_role` ON `users` (`role`);