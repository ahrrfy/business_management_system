ALTER TABLE `purchaseOrders`
  ADD COLUMN `settlementType` enum('CASH','CREDIT') NOT NULL DEFAULT 'CREDIT'
  AFTER `paidAmount`;
