ALTER TABLE `workOrders`
  MODIFY COLUMN `paymentMethod` enum('CASH','CARD','TRANSFER') DEFAULT 'CASH';
