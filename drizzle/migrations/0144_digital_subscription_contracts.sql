-- دورة حياة الاشتراك: تعريف مدة لكل عرض ثم عقد غير قابل للتعديل يولّد من بيع ناجح.
ALTER TABLE `digitalOfferings`
  ADD `subscriptionDurationDays` int;
--> statement-breakpoint
CREATE TABLE `digitalSubscriptionContracts` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `offeringId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `invoiceId` bigint NOT NULL,
  `invoiceItemId` bigint NOT NULL,
  `studentCustomerId` bigint NOT NULL,
  `studentNameSnapshot` varchar(255) NOT NULL,
  `durationDays` int NOT NULL,
  `startsAt` timestamp NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `previousContractId` bigint,
  `status` enum('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `digitalSubscriptionContracts_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_dsub_invoice_item` UNIQUE(`invoiceItemId`),
  CONSTRAINT `digitalSubscriptionContracts_offeringId_digitalOfferings_id_fk`
    FOREIGN KEY (`offeringId`) REFERENCES `digitalOfferings`(`id`),
  CONSTRAINT `digitalSubscriptionContracts_branchId_branches_id_fk`
    FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `digitalSubscriptionContracts_invoiceId_invoices_id_fk`
    FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`),
  CONSTRAINT `digitalSubscriptionContracts_invoiceItemId_invoiceItems_id_fk`
    FOREIGN KEY (`invoiceItemId`) REFERENCES `invoiceItems`(`id`),
  CONSTRAINT `digitalSubscriptionContracts_studentCustomerId_customers_id_fk`
    FOREIGN KEY (`studentCustomerId`) REFERENCES `customers`(`id`),
  CONSTRAINT `digitalSubscriptionContracts_createdBy_users_id_fk`
    FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_dsub_subscriber_offering`
  ON `digitalSubscriptionContracts` (`studentCustomerId`,`offeringId`);
--> statement-breakpoint
CREATE INDEX `idx_dsub_branch_expiry`
  ON `digitalSubscriptionContracts` (`branchId`,`expiresAt`);
