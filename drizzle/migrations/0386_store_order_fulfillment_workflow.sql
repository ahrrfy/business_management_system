ALTER TABLE `onlineOrders` ADD COLUMN `claimedByUserId` int;
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD COLUMN `claimedAt` timestamp;
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD COLUMN `preparedByUserId` int;
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD COLUMN `preparedAt` timestamp;
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD COLUMN `fulfillmentDurationMinutes` int;
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD COLUMN `contactStatus` enum('NOT_CONTACTED','WHATSAPP_SENT','CALLED_CONFIRMED','NO_ANSWER','RETRY') NOT NULL DEFAULT 'NOT_CONTACTED';
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD COLUMN `contactNotes` varchar(500);
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD CONSTRAINT `onlineOrders_claimedByUserId_users_id_fk` FOREIGN KEY (`claimedByUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD CONSTRAINT `onlineOrders_preparedByUserId_users_id_fk` FOREIGN KEY (`preparedByUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX `idx_online_order_claimed_by` ON `onlineOrders` (`claimedByUserId`);
--> statement-breakpoint
CREATE INDEX `idx_online_order_prepared_by` ON `onlineOrders` (`preparedByUserId`);
