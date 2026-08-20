CREATE TABLE IF NOT EXISTS `loyaltyPrograms` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `status` ENUM('DRAFT','ACTIVE','PAUSED') NOT NULL DEFAULT 'DRAFT',
  `pointsPerIqd` DECIMAL(16,6) NOT NULL DEFAULT 0,
  `iqdDiscountPerPoint` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `minRedeemPoints` INT NOT NULL DEFAULT 0,
  `maxRedeemPercent` TINYINT NOT NULL DEFAULT 0,
  `expiresAfterDays` INT NULL,
  `createdBy` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_loyalty_program_status` (`status`),
  CONSTRAINT `fk_loyalty_program_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS `loyaltyAccounts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `programId` BIGINT NOT NULL,
  `customerId` BIGINT NOT NULL,
  `pointsBalance` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loyalty_program_customer` (`programId`,`customerId`),
  KEY `idx_loyalty_account_customer` (`customerId`),
  CONSTRAINT `fk_loyalty_account_program` FOREIGN KEY (`programId`) REFERENCES `loyaltyPrograms`(`id`),
  CONSTRAINT `fk_loyalty_account_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`)
);

CREATE TABLE IF NOT EXISTS `loyaltyLedgerEntries` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `accountId` BIGINT NOT NULL,
  `customerId` BIGINT NOT NULL,
  `onlineOrderId` BIGINT NULL,
  `entryType` ENUM('ORDER_EARN','ORDER_REVERSE','REDEEM','ADJUSTMENT','EXPIRE') NOT NULL,
  `pointsDelta` DECIMAL(18,2) NOT NULL,
  `balanceAfter` DECIMAL(18,2) NOT NULL,
  `note` VARCHAR(255) NULL,
  `createdBy` INT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loyalty_order_earn` (`onlineOrderId`,`entryType`),
  KEY `idx_loyalty_ledger_account_created` (`accountId`,`createdAt`),
  CONSTRAINT `fk_loyalty_ledger_account` FOREIGN KEY (`accountId`) REFERENCES `loyaltyAccounts`(`id`),
  CONSTRAINT `fk_loyalty_ledger_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
  CONSTRAINT `fk_loyalty_ledger_order` FOREIGN KEY (`onlineOrderId`) REFERENCES `onlineOrders`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_loyalty_ledger_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
