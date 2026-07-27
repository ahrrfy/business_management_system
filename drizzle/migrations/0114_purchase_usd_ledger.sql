ALTER TABLE `suppliers`
  ADD `currentBalanceUsd` decimal(15,2) DEFAULT '0.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE `purchaseOrders`
  ADD `paidUsd` decimal(15,2) DEFAULT '0.00' NOT NULL,
  ADD `returnedUsd` decimal(15,2) DEFAULT '0.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE `purchaseOrderItems`
  ADD `usdUnitPrice` decimal(15,4),
  ADD `usdTotal` decimal(15,2),
  ADD `receivedUsd` decimal(15,2) DEFAULT '0.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE `exchangeTransactions`
  ADD `purchaseOrderId` bigint,
  ADD `settledUsd` decimal(15,2) DEFAULT '0.00' NOT NULL,
  ADD `settledIqd` decimal(15,2) DEFAULT '0.00' NOT NULL,
  ADD CONSTRAINT `exchangeTransactions_purchaseOrderId_purchaseOrders_id_fk`
    FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchaseOrders`(`id`);
--> statement-breakpoint
CREATE INDEX `idx_exchange_txn_po` ON `exchangeTransactions` (`purchaseOrderId`);
