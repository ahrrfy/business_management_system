-- ش٢ (٥/٨/٢٦) — مسوّدة طلب محطة خدمة الزبائن (م١: تعديل حرّ قبل التثبيت بصفر أثر ماليّ).
-- الوثيقة الحاكمة: docs/reception-cashier-system-design-2026-08-05.md §٥.١-٥.٢.
CREATE TABLE `receptionDrafts` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `draftNumber` varchar(40) NOT NULL,
  `branchId` bigint NOT NULL,
  `createdByShiftId` bigint,
  `draftStatus` enum('OPEN','COMMITTED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'OPEN',
  `version` int NOT NULL DEFAULT 0,
  `commitRequestId` char(36) NOT NULL,
  `moneyLocked` boolean NOT NULL DEFAULT false,
  `customerId` bigint,
  `contactName` varchar(255),
  `contactPhone` varchar(32),
  `draftPriceTier` enum('RETAIL','WHOLESALE','GOVERNMENT') NOT NULL DEFAULT 'RETAIL',
  `channel` varchar(20),
  `notes` text,
  `dueDate` date,
  `subtotal` decimal(15,2) NOT NULL DEFAULT '0',
  `discountTotal` decimal(15,2) NOT NULL DEFAULT '0',
  `total` decimal(15,2) NOT NULL DEFAULT '0',
  `committedInvoiceId` bigint,
  `committedPrintInvoiceId` bigint,
  `expiresAt` timestamp NULL,
  `committedAt` timestamp NULL,
  `cancelledAt` timestamp NULL,
  `cancelReason` varchar(500),
  `createdBy` int NOT NULL,
  `updatedBy` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `receptionDrafts_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_draft_number` UNIQUE(`draftNumber`),
  CONSTRAINT `uq_draft_commit_request` UNIQUE(`commitRequestId`),
  CONSTRAINT `uq_draft_committed_invoice` UNIQUE(`committedInvoiceId`)
);--> statement-breakpoint
CREATE TABLE `receptionDraftLines` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `draftId` bigint NOT NULL,
  `draftLineKind` enum('GOODS','PRINT','CUSTOM') NOT NULL,
  `sortOrder` int NOT NULL DEFAULT 0,
  `variantId` bigint,
  `productUnitId` bigint,
  `quantity` decimal(15,3) NOT NULL DEFAULT '1',
  `unitPrice` decimal(15,2) NOT NULL DEFAULT '0',
  `discountAmount` decimal(15,2) NOT NULL DEFAULT '0',
  `lineTotal` decimal(15,2) NOT NULL DEFAULT '0',
  `title` varchar(255),
  `customizationText` text,
  `designImages` mediumtext,
  `printSpec` text,
  `dueDate` date,
  `assignedTo` int,
  `priceOverride` boolean NOT NULL DEFAULT false,
  `priceApprovedBy` bigint,
  `lineRequestId` varchar(64),
  CONSTRAINT `receptionDraftLines_id` PRIMARY KEY(`id`)
);--> statement-breakpoint
ALTER TABLE `receptionDrafts` ADD CONSTRAINT `fk_draft_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receptionDrafts` ADD CONSTRAINT `fk_draft_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receptionDrafts` ADD CONSTRAINT `fk_draft_committed_inv` FOREIGN KEY (`committedInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receptionDrafts` ADD CONSTRAINT `fk_draft_committed_print` FOREIGN KEY (`committedPrintInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receptionDrafts` ADD CONSTRAINT `fk_draft_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receptionDraftLines` ADD CONSTRAINT `fk_dline_draft` FOREIGN KEY (`draftId`) REFERENCES `receptionDrafts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receptionDraftLines` ADD CONSTRAINT `fk_dline_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receptionDraftLines` ADD CONSTRAINT `fk_dline_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_draft_branch_status_id` ON `receptionDrafts` (`branchId`,`draftStatus`,`id`);--> statement-breakpoint
CREATE INDEX `idx_draft_creator` ON `receptionDrafts` (`createdBy`,`draftStatus`);--> statement-breakpoint
CREATE INDEX `idx_draft_phone` ON `receptionDrafts` (`contactPhone`);--> statement-breakpoint
CREATE INDEX `idx_draft_customer` ON `receptionDrafts` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_dline_draft` ON `receptionDraftLines` (`draftId`,`sortOrder`);