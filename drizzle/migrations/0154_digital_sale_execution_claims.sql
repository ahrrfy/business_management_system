-- One live execution lease per digital-sale intent item.
-- providerIdempotencyKey stays stable across lease expiry/reclaim so a provider
-- integration can safely retry without issuing the same card twice.
CREATE TABLE IF NOT EXISTS `digitalSaleExecutionClaims` (
  `intentItemId` BIGINT NOT NULL,
  `claimToken` VARCHAR(80) NOT NULL,
  `claimedBy` INT NOT NULL,
  `claimedAt` TIMESTAMP(3) NOT NULL,
  `expiresAt` TIMESTAMP(3) NOT NULL,
  `providerIdempotencyKey` VARCHAR(120) NOT NULL,
  `completedAt` TIMESTAMP(3) NULL,
  PRIMARY KEY (`intentItemId`),
  UNIQUE KEY `uq_dsec_claim_token` (`claimToken`),
  UNIQUE KEY `uq_dsec_provider_idempotency_key` (`providerIdempotencyKey`),
  KEY `idx_dsec_expires_at` (`expiresAt`),
  KEY `idx_dsec_claimed_by` (`claimedBy`),
  CONSTRAINT `fk_dsec_intent_item`
    FOREIGN KEY (`intentItemId`) REFERENCES `digitalSaleIntentItems` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dsec_claimed_by`
    FOREIGN KEY (`claimedBy`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
