-- S2: البطاقات الرقمية والاشتراكات — 15 جدولاً + توسعة entryType + digitalWalletId
CREATE TABLE `digitalProviders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`supplierId` bigint NOT NULL,
	`providerType` enum('TELECOM','GLOBAL_CARDS','EDUCATIONAL','OTHER') NOT NULL,
	`settlementMode` enum('PREPAID','POSTPAID') NOT NULL,
	`recognitionMode` enum('PRINCIPAL_GROSS') NOT NULL,
	`referencePolicy` enum('REQUIRED','OPTIONAL','NONE') NOT NULL,
	`settlementCycle` enum('DAILY','WEEKLY','BIWEEKLY','MONTHLY','ON_DEMAND') NOT NULL,
	`lowBalanceThreshold` decimal(15,2) NOT NULL DEFAULT '0',
	`isActive` boolean NOT NULL DEFAULT true,
	`notes` text,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `digitalProviders_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_digital_provider_supplier` UNIQUE(`supplierId`)
);
--> statement-breakpoint
CREATE TABLE `digitalWallets` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`providerId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`code` varchar(40) NOT NULL,
	`name` varchar(120) NOT NULL,
	`currency` enum('IQD') NOT NULL,
	`currentBalance` decimal(15,2) NOT NULL DEFAULT '0',
	`reservedBalance` decimal(15,2) NOT NULL DEFAULT '0',
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `digitalWallets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wallet_provider_branch_code` UNIQUE(`providerId`,`branchId`,`code`)
);
--> statement-breakpoint
CREATE TABLE `digitalWalletTransactions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`transactionNumber` varchar(40) NOT NULL,
	`walletId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`type` enum('OPENING','DEPOSIT','SALE_CONSUMPTION','SALE_REVERSAL','WITHDRAWAL','ADJUSTMENT') NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`direction` enum('IN','OUT') NOT NULL,
	`balanceAfter` decimal(15,2) NOT NULL,
	`invoiceId` bigint,
	`invoiceItemId` bigint,
	`receiptId` bigint,
	`status` enum('ACTIVE','PENDING_APPROVAL','REVERSED') NOT NULL DEFAULT 'ACTIVE',
	`clientRequestId` varchar(80),
	`notes` text,
	`createdBy` int NOT NULL,
	`approvedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`approvedAt` timestamp,
	CONSTRAINT `digitalWalletTransactions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dwt_number` UNIQUE(`transactionNumber`),
	CONSTRAINT `uq_dwt_wallet_client` UNIQUE(`walletId`,`clientRequestId`)
);
--> statement-breakpoint
CREATE TABLE `digitalOfferings` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`providerId` bigint NOT NULL,
	`productId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint NOT NULL,
	`offeringType` enum('TELECOM_CARD','GLOBAL_CARD','EDUCATIONAL_SUBSCRIPTION','OTHER') NOT NULL,
	`requiresStudentData` boolean NOT NULL DEFAULT false,
	`faceValue` decimal(15,2),
	`faceCurrency` varchar(3),
	`pricingMode` enum('FIXED_MARGIN','PERCENT_MARGIN','FIXED_PLUS_PERCENT','FIXED_SELL_PRICE') NOT NULL,
	`fixedMargin` decimal(15,2) NOT NULL DEFAULT '0',
	`marginPercent` decimal(5,2) NOT NULL DEFAULT '0',
	`minimumMargin` decimal(15,2) NOT NULL DEFAULT '0',
	`roundingStep` decimal(15,2) NOT NULL DEFAULT '250',
	`priceValidityHours` int,
	`cardColorToken` varchar(30),
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `digitalOfferings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_doffering_variant` UNIQUE(`variantId`),
	CONSTRAINT `uq_doffering_unit` UNIQUE(`productUnitId`)
);
--> statement-breakpoint
CREATE TABLE `digitalOfferingBranches` (
	`offeringId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`walletId` bigint,
	`isActive` boolean NOT NULL DEFAULT true,
	`isFavorite` boolean NOT NULL DEFAULT false,
	`displayOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pk_doffering_branch` PRIMARY KEY(`offeringId`,`branchId`)
);
--> statement-breakpoint
CREATE TABLE `digitalPriceBatches` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`providerId` bigint NOT NULL,
	`businessDate` date NOT NULL,
	`status` enum('DRAFT','PUBLISHED','SUPERSEDED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`copiedFromBatchId` bigint,
	`createdBy` int NOT NULL,
	`publishedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`publishedAt` timestamp,
	CONSTRAINT `digitalPriceBatches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `digitalPriceVersions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`batchId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`offeringId` bigint NOT NULL,
	`providerShare` decimal(15,2) NOT NULL,
	`sellPrice` decimal(15,2) NOT NULL,
	`marginAmount` decimal(15,2) NOT NULL,
	`validFrom` timestamp NOT NULL,
	`validUntil` timestamp,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `digitalPriceVersions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dpv_batch_offering` UNIQUE(`batchId`,`offeringId`)
);
--> statement-breakpoint
CREATE TABLE `digitalCurrentPrices` (
	`branchId` bigint NOT NULL,
	`offeringId` bigint NOT NULL,
	`priceVersionId` bigint NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pk_dcurrent_price` PRIMARY KEY(`branchId`,`offeringId`)
);
--> statement-breakpoint
CREATE TABLE `digitalPriceChangeReports` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`offeringId` bigint NOT NULL,
	`providerId` bigint NOT NULL,
	`currentPriceVersionId` bigint NOT NULL,
	`reportedProviderShare` decimal(15,2) NOT NULL,
	`status` enum('OPEN','APPROVED','REJECTED','RESOLVED') NOT NULL DEFAULT 'OPEN',
	`reportedBy` int NOT NULL,
	`resolvedBy` int,
	`resolutionPriceVersionId` bigint,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	CONSTRAINT `digitalPriceChangeReports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `studentProfiles` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`customerId` bigint NOT NULL,
	`studentPhone` varchar(20) NOT NULL,
	`guardianPhone` varchar(20) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `studentProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_student_customer` UNIQUE(`customerId`),
	CONSTRAINT `uq_student_phone` UNIQUE(`studentPhone`)
);
--> statement-breakpoint
CREATE TABLE `digitalSaleIntents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`clientRequestId` varchar(80) NOT NULL,
	`branchId` bigint NOT NULL,
	`shiftId` bigint NOT NULL,
	`createdBy` int NOT NULL,
	`status` enum('PREPARED','EXECUTING','EXECUTED','FINALIZED','CANCELLED','EXPIRED','NEEDS_REVIEW') NOT NULL DEFAULT 'PREPARED',
	`cartFingerprint` varchar(64) NOT NULL,
	`paymentMethod` varchar(20) NOT NULL,
	`expectedTotal` decimal(15,2) NOT NULL,
	`invoiceId` bigint,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `digitalSaleIntents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dsi_client_request` UNIQUE(`clientRequestId`),
	CONSTRAINT `uq_dsi_invoice` UNIQUE(`invoiceId`)
);
--> statement-breakpoint
CREATE TABLE `digitalWalletReservations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`walletId` bigint NOT NULL,
	`intentId` bigint NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`status` enum('ACTIVE','CONSUMED','RELEASED') NOT NULL DEFAULT 'ACTIVE',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`consumedAt` timestamp,
	`releasedAt` timestamp,
	CONSTRAINT `digitalWalletReservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dwr_wallet_intent` UNIQUE(`walletId`,`intentId`)
);
--> statement-breakpoint
CREATE TABLE `digitalSaleIntentItems` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`intentId` bigint NOT NULL,
	`lineKey` varchar(64) NOT NULL,
	`offeringId` bigint NOT NULL,
	`priceVersionId` bigint NOT NULL,
	`sellPriceSnapshot` decimal(15,2) NOT NULL,
	`providerShareSnapshot` decimal(15,2) NOT NULL,
	`marginSnapshot` decimal(15,2) NOT NULL,
	`fulfillmentStatus` enum('PENDING','SUCCESS','FAILED','UNKNOWN') NOT NULL DEFAULT 'PENDING',
	`providerReference` varchar(120),
	`confirmedBy` int,
	`confirmedAt` timestamp,
	`studentCustomerId` bigint,
	`studentNameSnapshot` varchar(255),
	`studentPhoneSnapshot` varchar(20),
	`guardianPhoneSnapshot` varchar(20),
	`studentAddressSnapshot` text,
	CONSTRAINT `digitalSaleIntentItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dsii_intent_line` UNIQUE(`intentId`,`lineKey`)
);
--> statement-breakpoint
CREATE TABLE `digitalSaleDetails` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`invoiceId` bigint NOT NULL,
	`invoiceItemId` bigint NOT NULL,
	`intentItemId` bigint NOT NULL,
	`offeringId` bigint NOT NULL,
	`providerId` bigint NOT NULL,
	`priceVersionId` bigint NOT NULL,
	`settlementModeSnapshot` enum('PREPAID','POSTPAID') NOT NULL,
	`sellPriceSnapshot` decimal(15,2) NOT NULL,
	`providerShareSnapshot` decimal(15,2) NOT NULL,
	`profitSnapshot` decimal(15,2) NOT NULL,
	`providerReference` varchar(120),
	`fulfillmentStatus` enum('ISSUED','REVERSAL_PENDING','REVERSED','LOSS_REFUND') NOT NULL DEFAULT 'ISSUED',
	`studentCustomerId` bigint,
	`studentNameSnapshot` varchar(255),
	`studentPhoneSnapshot` varchar(20),
	`guardianPhoneSnapshot` varchar(20),
	`studentAddressSnapshot` text,
	`walletTransactionId` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `digitalSaleDetails_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dsd_invoice_item` UNIQUE(`invoiceItemId`),
	CONSTRAINT `uq_dsd_intent_item` UNIQUE(`intentItemId`)
);
--> statement-breakpoint
CREATE TABLE `digitalWalletReconciliations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`walletId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`businessDate` date NOT NULL,
	`expectedBalance` decimal(15,2) NOT NULL,
	`actualBalance` decimal(15,2) NOT NULL,
	`variance` decimal(15,2) NOT NULL,
	`status` enum('MATCHED','VARIANCE_OPEN','RESOLVED') NOT NULL DEFAULT 'MATCHED',
	`countedBy` int NOT NULL,
	`reviewedBy` int,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`reviewedAt` timestamp,
	CONSTRAINT `digitalWalletReconciliations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dwrecon_wallet_date` UNIQUE(`walletId`,`businessDate`)
);
--> statement-breakpoint
ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN','DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_WRITEOFF','EXCHANGE_DEPOSIT','EXCHANGE_WITHDRAW','EXCHANGE_FX_BUY','EXCHANGE_SETTLE','EXCHANGE_FEE','EXCHANGE_FX_DIFF','GIFT_OUT','SHIFT_FLOAT_OUT','TREASURY_FUNDING','DIGITAL_WALLET_DEPOSIT','DIGITAL_WALLET_WITHDRAWAL','DIGITAL_WALLET_CONSUMPTION','DIGITAL_WALLET_REVERSAL','DIGITAL_WALLET_ADJUSTMENT') NOT NULL;
--> statement-breakpoint
ALTER TABLE `accountingEntries` ADD `digitalWalletId` bigint;
--> statement-breakpoint
ALTER TABLE `digitalProviders` ADD CONSTRAINT `digitalProviders_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalProviders` ADD CONSTRAINT `digitalProviders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWallets` ADD CONSTRAINT `digitalWallets_providerId_digitalProviders_id_fk` FOREIGN KEY (`providerId`) REFERENCES `digitalProviders`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWallets` ADD CONSTRAINT `digitalWallets_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletTransactions` ADD CONSTRAINT `digitalWalletTransactions_walletId_digitalWallets_id_fk` FOREIGN KEY (`walletId`) REFERENCES `digitalWallets`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletTransactions` ADD CONSTRAINT `digitalWalletTransactions_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletTransactions` ADD CONSTRAINT `digitalWalletTransactions_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletTransactions` ADD CONSTRAINT `digitalWalletTransactions_invoiceItemId_invoiceItems_id_fk` FOREIGN KEY (`invoiceItemId`) REFERENCES `invoiceItems`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletTransactions` ADD CONSTRAINT `digitalWalletTransactions_receiptId_receipts_id_fk` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletTransactions` ADD CONSTRAINT `digitalWalletTransactions_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletTransactions` ADD CONSTRAINT `digitalWalletTransactions_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalOfferings` ADD CONSTRAINT `digitalOfferings_providerId_digitalProviders_id_fk` FOREIGN KEY (`providerId`) REFERENCES `digitalProviders`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalOfferings` ADD CONSTRAINT `digitalOfferings_productId_products_id_fk` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalOfferings` ADD CONSTRAINT `digitalOfferings_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalOfferings` ADD CONSTRAINT `digitalOfferings_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalOfferingBranches` ADD CONSTRAINT `digitalOfferingBranches_offeringId_digitalOfferings_id_fk` FOREIGN KEY (`offeringId`) REFERENCES `digitalOfferings`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalOfferingBranches` ADD CONSTRAINT `digitalOfferingBranches_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalOfferingBranches` ADD CONSTRAINT `digitalOfferingBranches_walletId_digitalWallets_id_fk` FOREIGN KEY (`walletId`) REFERENCES `digitalWallets`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceBatches` ADD CONSTRAINT `digitalPriceBatches_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceBatches` ADD CONSTRAINT `digitalPriceBatches_providerId_digitalProviders_id_fk` FOREIGN KEY (`providerId`) REFERENCES `digitalProviders`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceBatches` ADD CONSTRAINT `digitalPriceBatches_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceBatches` ADD CONSTRAINT `digitalPriceBatches_publishedBy_users_id_fk` FOREIGN KEY (`publishedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceVersions` ADD CONSTRAINT `digitalPriceVersions_batchId_digitalPriceBatches_id_fk` FOREIGN KEY (`batchId`) REFERENCES `digitalPriceBatches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceVersions` ADD CONSTRAINT `digitalPriceVersions_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceVersions` ADD CONSTRAINT `digitalPriceVersions_offeringId_digitalOfferings_id_fk` FOREIGN KEY (`offeringId`) REFERENCES `digitalOfferings`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceVersions` ADD CONSTRAINT `digitalPriceVersions_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalCurrentPrices` ADD CONSTRAINT `digitalCurrentPrices_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalCurrentPrices` ADD CONSTRAINT `digitalCurrentPrices_offeringId_digitalOfferings_id_fk` FOREIGN KEY (`offeringId`) REFERENCES `digitalOfferings`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalCurrentPrices` ADD CONSTRAINT `digitalCurrentPrices_priceVersionId_digitalPriceVersions_id_fk` FOREIGN KEY (`priceVersionId`) REFERENCES `digitalPriceVersions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceChangeReports` ADD CONSTRAINT `digitalPriceChangeReports_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceChangeReports` ADD CONSTRAINT `digitalPriceChangeReports_offeringId_digitalOfferings_id_fk` FOREIGN KEY (`offeringId`) REFERENCES `digitalOfferings`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceChangeReports` ADD CONSTRAINT `digitalPriceChangeReports_providerId_digitalProviders_id_fk` FOREIGN KEY (`providerId`) REFERENCES `digitalProviders`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceChangeReports` ADD CONSTRAINT `fk_dpcr_curr_pv` FOREIGN KEY (`currentPriceVersionId`) REFERENCES `digitalPriceVersions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceChangeReports` ADD CONSTRAINT `digitalPriceChangeReports_reportedBy_users_id_fk` FOREIGN KEY (`reportedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceChangeReports` ADD CONSTRAINT `digitalPriceChangeReports_resolvedBy_users_id_fk` FOREIGN KEY (`resolvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalPriceChangeReports` ADD CONSTRAINT `fk_dpcr_res_pv` FOREIGN KEY (`resolutionPriceVersionId`) REFERENCES `digitalPriceVersions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `studentProfiles` ADD CONSTRAINT `studentProfiles_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntents` ADD CONSTRAINT `digitalSaleIntents_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntents` ADD CONSTRAINT `digitalSaleIntents_shiftId_shifts_id_fk` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntents` ADD CONSTRAINT `digitalSaleIntents_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntents` ADD CONSTRAINT `digitalSaleIntents_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletReservations` ADD CONSTRAINT `digitalWalletReservations_walletId_digitalWallets_id_fk` FOREIGN KEY (`walletId`) REFERENCES `digitalWallets`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletReservations` ADD CONSTRAINT `digitalWalletReservations_intentId_digitalSaleIntents_id_fk` FOREIGN KEY (`intentId`) REFERENCES `digitalSaleIntents`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntentItems` ADD CONSTRAINT `digitalSaleIntentItems_intentId_digitalSaleIntents_id_fk` FOREIGN KEY (`intentId`) REFERENCES `digitalSaleIntents`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntentItems` ADD CONSTRAINT `digitalSaleIntentItems_offeringId_digitalOfferings_id_fk` FOREIGN KEY (`offeringId`) REFERENCES `digitalOfferings`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntentItems` ADD CONSTRAINT `fk_dsii_pv` FOREIGN KEY (`priceVersionId`) REFERENCES `digitalPriceVersions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntentItems` ADD CONSTRAINT `digitalSaleIntentItems_confirmedBy_users_id_fk` FOREIGN KEY (`confirmedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleIntentItems` ADD CONSTRAINT `digitalSaleIntentItems_studentCustomerId_customers_id_fk` FOREIGN KEY (`studentCustomerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `digitalSaleDetails_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `digitalSaleDetails_invoiceItemId_invoiceItems_id_fk` FOREIGN KEY (`invoiceItemId`) REFERENCES `invoiceItems`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `digitalSaleDetails_intentItemId_digitalSaleIntentItems_id_fk` FOREIGN KEY (`intentItemId`) REFERENCES `digitalSaleIntentItems`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `digitalSaleDetails_offeringId_digitalOfferings_id_fk` FOREIGN KEY (`offeringId`) REFERENCES `digitalOfferings`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `digitalSaleDetails_providerId_digitalProviders_id_fk` FOREIGN KEY (`providerId`) REFERENCES `digitalProviders`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `digitalSaleDetails_priceVersionId_digitalPriceVersions_id_fk` FOREIGN KEY (`priceVersionId`) REFERENCES `digitalPriceVersions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `digitalSaleDetails_studentCustomerId_customers_id_fk` FOREIGN KEY (`studentCustomerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalSaleDetails` ADD CONSTRAINT `fk_dsd_wallet_tx` FOREIGN KEY (`walletTransactionId`) REFERENCES `digitalWalletTransactions`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletReconciliations` ADD CONSTRAINT `digitalWalletReconciliations_walletId_digitalWallets_id_fk` FOREIGN KEY (`walletId`) REFERENCES `digitalWallets`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletReconciliations` ADD CONSTRAINT `digitalWalletReconciliations_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletReconciliations` ADD CONSTRAINT `digitalWalletReconciliations_countedBy_users_id_fk` FOREIGN KEY (`countedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `digitalWalletReconciliations` ADD CONSTRAINT `digitalWalletReconciliations_reviewedBy_users_id_fk` FOREIGN KEY (`reviewedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_dprovider_supplier` ON `digitalProviders` (`supplierId`);
--> statement-breakpoint
CREATE INDEX `idx_wallet_branch` ON `digitalWallets` (`branchId`);
--> statement-breakpoint
CREATE INDEX `idx_dwt_wallet` ON `digitalWalletTransactions` (`walletId`);
--> statement-breakpoint
CREATE INDEX `idx_doffering_provider` ON `digitalOfferings` (`providerId`);
--> statement-breakpoint
CREATE INDEX `idx_dob_branch` ON `digitalOfferingBranches` (`branchId`);
--> statement-breakpoint
CREATE INDEX `idx_dpbatch_branch_provider` ON `digitalPriceBatches` (`branchId`,`providerId`);
--> statement-breakpoint
CREATE INDEX `idx_dpbatch_status` ON `digitalPriceBatches` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_dpv_offering` ON `digitalPriceVersions` (`offeringId`);
--> statement-breakpoint
CREATE INDEX `idx_dpv_branch` ON `digitalPriceVersions` (`branchId`);
--> statement-breakpoint
CREATE INDEX `idx_dpcr_status` ON `digitalPriceChangeReports` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_dpcr_provider` ON `digitalPriceChangeReports` (`providerId`);
--> statement-breakpoint
CREATE INDEX `idx_student_guardian` ON `studentProfiles` (`guardianPhone`);
--> statement-breakpoint
CREATE INDEX `idx_dsi_status` ON `digitalSaleIntents` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_dsi_branch` ON `digitalSaleIntents` (`branchId`);
--> statement-breakpoint
CREATE INDEX `idx_dwr_intent` ON `digitalWalletReservations` (`intentId`);
--> statement-breakpoint
CREATE INDEX `idx_dsii_offering` ON `digitalSaleIntentItems` (`offeringId`);
--> statement-breakpoint
CREATE INDEX `idx_dsd_invoice` ON `digitalSaleDetails` (`invoiceId`);
--> statement-breakpoint
CREATE INDEX `idx_dsd_provider` ON `digitalSaleDetails` (`providerId`);
--> statement-breakpoint
CREATE INDEX `idx_dwrecon_branch` ON `digitalWalletReconciliations` (`branchId`);
--> statement-breakpoint
CREATE INDEX `idx_entry_digital_wallet_date` ON `accountingEntries` (`digitalWalletId`,`entryDate`);
