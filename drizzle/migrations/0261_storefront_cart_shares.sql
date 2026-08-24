CREATE TABLE IF NOT EXISTS `storefrontCartShares` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `token` varchar(32) NOT NULL,
  `lines` json NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_storefront_cart_share_token` (`token`),
  KEY `idx_storefront_cart_share_expiry` (`expiresAt`)
) ENGINE=InnoDB;
