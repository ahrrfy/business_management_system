-- مسار مبيعات المتجر للطلبات الكبيرة والطباعة: يسجل نية العميل فقط. لا يوجد هنا سعر أو
-- حجز أو أثر دفتر؛ العرض الرسمي يُنشأ لاحقاً بعد مراجعة الموظف من وحدة عروض الأسعار.
CREATE TABLE `storefrontQuoteRequests` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `requestNumber` varchar(50) NOT NULL,
  `branchId` bigint NOT NULL,
  `customerId` bigint NULL,
  `requestType` enum('BULK','CUSTOM_PRINT','BUSINESS','GENERAL') NOT NULL,
  `status` enum('PENDING','CONTACTED','QUOTED','CLOSED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `companyName` varchar(255) NULL,
  `governorate` varchar(40) NULL,
  `contactPreference` enum('PHONE','WHATSAPP') NOT NULL DEFAULT 'WHATSAPP',
  `customerNote` text NOT NULL,
  `staffNote` text NULL,
  `clientRequestId` varchar(80) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `storefrontQuoteRequests_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_store_quote_request_number` UNIQUE(`requestNumber`),
  CONSTRAINT `uq_store_quote_request_client_request` UNIQUE(`clientRequestId`),
  CONSTRAINT `fk_store_quote_request_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `fk_store_quote_request_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_store_quote_request_branch_status_created`
  ON `storefrontQuoteRequests` (`branchId`,`status`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `idx_store_quote_request_customer_created`
  ON `storefrontQuoteRequests` (`customerId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `storefrontQuoteRequestItems` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `quoteRequestId` bigint NOT NULL,
  `productUnitId` bigint NULL,
  `productName` varchar(255) NOT NULL,
  `variantLabel` varchar(255) NULL,
  `unitName` varchar(40) NOT NULL,
  `quantity` int NOT NULL,
  `baseQuantity` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `storefrontQuoteRequestItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `fk_store_quote_request_item_request` FOREIGN KEY (`quoteRequestId`) REFERENCES `storefrontQuoteRequests`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_store_quote_request_item_request`
  ON `storefrontQuoteRequestItems` (`quoteRequestId`);
