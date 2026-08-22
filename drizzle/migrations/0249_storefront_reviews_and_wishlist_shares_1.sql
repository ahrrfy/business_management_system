CREATE TABLE IF NOT EXISTS `storefrontProductReviews` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `productId` BIGINT NOT NULL,
  `customerId` BIGINT NOT NULL,
  `onlineOrderId` BIGINT NOT NULL,
  `rating` INT NOT NULL,
  `comment` VARCHAR(1000) NOT NULL,
  `status` ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `moderatedAt` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_storefront_review_order_product` (`onlineOrderId`,`productId`),
  KEY `idx_storefront_review_product_status_created` (`productId`,`status`,`createdAt`),
  KEY `idx_storefront_review_customer` (`customerId`),
  CONSTRAINT `fk_storefront_review_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_storefront_review_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_storefront_review_order` FOREIGN KEY (`onlineOrderId`) REFERENCES `onlineOrders`(`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_storefront_review_rating` CHECK (`rating` BETWEEN 1 AND 5)
);
