ALTER TABLE `onlineOrders`
  ADD COLUMN `couponCode` varchar(64) NULL,
  ADD COLUMN `couponDiscount` decimal(15,2) NOT NULL DEFAULT '0';

