-- تدقيق موظف المبيعات (٢٨/٧/٢٦):
-- لقطة تاريخية لاسم البائع + محطة/وردية البيع + منفّذ المرتجع المستقلّ.
SET NAMES utf8mb4;
--> statement-breakpoint
ALTER TABLE `invoices`
  ADD COLUMN `salespersonNameSnapshot` varchar(255) NULL AFTER `capturedAt`,
  ADD COLUMN `posDeviceId` varchar(64) NULL AFTER `salespersonNameSnapshot`,
  ADD COLUMN `cancelledBy` int NULL AFTER `createdBy`,
  ADD COLUMN `cancelledByNameSnapshot` varchar(255) NULL AFTER `cancelledBy`,
  ADD COLUMN `cancelledAt` timestamp NULL AFTER `cancelledByNameSnapshot`;
--> statement-breakpoint
UPDATE `invoices` i
LEFT JOIN `users` u ON u.`id` = i.`createdBy`
SET i.`salespersonNameSnapshot` = u.`name`
WHERE i.`salespersonNameSnapshot` IS NULL;
--> statement-breakpoint
ALTER TABLE `invoices`
  ADD CONSTRAINT `invoices_cancelledBy_users_id_fk`
  FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX `idx_invoice_salesperson_date` ON `invoices` (`createdBy`, `invoiceDate`);
--> statement-breakpoint
ALTER TABLE `accountingEntries`
  ADD COLUMN `createdBy` int NULL AFTER `dedupeKey`,
  ADD COLUMN `createdByNameSnapshot` varchar(255) NULL AFTER `createdBy`;
--> statement-breakpoint
ALTER TABLE `accountingEntries`
  ADD CONSTRAINT `accountingEntries_createdBy_users_id_fk`
  FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
