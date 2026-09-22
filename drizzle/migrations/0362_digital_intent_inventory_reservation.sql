-- 0362 — حجز مخزون السلة الرقمية المختلطة طوال نافذة الإصدار الخارجي.
--
-- الفحص اللحظي في prepare لا يكفي: قد يبيع كاشير آخر المادة قبل finalize بعد أن يكون
-- جهاز المزوّد أصدر الكرت. الصفوف الموجبة تدخل عدّاد reservationStock، والصفوف الصفرية
-- تقفل معنى المصدر (الوحدة/وصفة الخدمة/تعريف البكج) حتى تنتهي النية.

CREATE TABLE IF NOT EXISTS `digitalIntentInventoryReservations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `intentId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `sourceVariantId` BIGINT NOT NULL,
  `stockVariantId` BIGINT NOT NULL,
  `reservedBase` INT NOT NULL DEFAULT 0,
  `status` ENUM('ACTIVE','CONSUMED','RELEASED') NOT NULL DEFAULT 'ACTIVE',
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `consumedAt` TIMESTAMP NULL,
  `releasedAt` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_diir_intent_source_stock` (`intentId`, `sourceVariantId`, `stockVariantId`),
  KEY `idx_diir_intent_status` (`intentId`, `status`),
  KEY `idx_diir_source_status` (`sourceVariantId`, `status`),
  KEY `idx_diir_stock_branch_status` (`stockVariantId`, `branchId`, `status`),
  CONSTRAINT `fk_diir_intent`
    FOREIGN KEY (`intentId`) REFERENCES `digitalSaleIntents` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_diir_branch`
    FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_diir_source_variant`
    FOREIGN KEY (`sourceVariantId`) REFERENCES `productVariants` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_diir_stock_variant`
    FOREIGN KEY (`stockVariantId`) REFERENCES `productVariants` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_diir_reserved_nonnegative` CHECK (`reservedBase` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
