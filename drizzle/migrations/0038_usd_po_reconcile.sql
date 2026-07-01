ALTER TABLE `purchaseOrders` ADD `poCurrency` enum('IQD','USD') DEFAULT 'IQD' NOT NULL;--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD `usdTotal` decimal(15,2);--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD `agreedRate` decimal(15,4);
