-- معالجة العمليات الرقمية غير المكتملة بقرارٍ واضح واعتماد مدير ثانٍ.
-- الطلب بلا أثر مالي؛ الاعتماد وحده يختار الإلغاء أو إكمال البيع أو إثبات الخسارة.

CREATE TABLE IF NOT EXISTS `digitalSaleReviewResolutions` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `intentId` bigint NOT NULL,
  `decision` enum('CANCEL_NO_ISSUE','FINALIZE_SALE','WRITEOFF_LOSS') NOT NULL,
  `status` enum('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `reason` varchar(500) NOT NULL,
  `requestedBy` int NOT NULL,
  `requestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewedBy` int,
  `reviewedAt` timestamp NULL,
  `reviewReason` varchar(500),
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `digitalSaleReviewResolutions_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_dsrr_intent` UNIQUE(`intentId`),
  CONSTRAINT `fk_dsrr_intent` FOREIGN KEY (`intentId`) REFERENCES `digitalSaleIntents`(`id`),
  CONSTRAINT `fk_dsrr_requested_by` FOREIGN KEY (`requestedBy`) REFERENCES `users`(`id`),
  CONSTRAINT `fk_dsrr_reviewed_by` FOREIGN KEY (`reviewedBy`) REFERENCES `users`(`id`),
  INDEX `idx_dsrr_status` (`status`)
);

CREATE TABLE IF NOT EXISTS `digitalSaleReviewResolutionItems` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `resolutionId` bigint NOT NULL,
  `intentItemId` bigint NOT NULL,
  `outcome` enum('ISSUED','NOT_ISSUED') NOT NULL,
  `providerReference` varchar(120),
  CONSTRAINT `digitalSaleReviewResolutionItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_dsrri_item` UNIQUE(`intentItemId`),
  CONSTRAINT `fk_dsrri_resolution` FOREIGN KEY (`resolutionId`) REFERENCES `digitalSaleReviewResolutions`(`id`),
  CONSTRAINT `fk_dsrri_intent_item` FOREIGN KEY (`intentItemId`) REFERENCES `digitalSaleIntentItems`(`id`),
  INDEX `idx_dsrri_resolution` (`resolutionId`)
);
