ALTER TABLE `workOrders` ADD `deliveryPhone` varchar(20);
--> statement-breakpoint
CREATE INDEX `idx_consignment_workorder` ON `deliveryConsignments` (`workOrderId`);
