CREATE TABLE IF NOT EXISTS `storefrontWishlistShares` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `token` VARCHAR(32) NOT NULL,
  `productIds` JSON NOT NULL,
  `expiresAt` TIMESTAMP NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_storefront_wishlist_share_token` (`token`),
  KEY `idx_storefront_wishlist_share_expiry` (`expiresAt`)
);
