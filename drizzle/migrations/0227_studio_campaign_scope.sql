-- 0227 — حملة التصوير: نطاقٌ وتوجيهٌ ومصوّرون.
--
-- الحملة اليوم بلا نطاق: `createStudioCampaignBacklog` يُولّد مهمّةً لكل منتجٍ نشطٍ ناقصٍ
-- في الكتالوج كلّه بلا أيّ اختيار — فلا سبيل لحملةٍ على فئةٍ بعينها أو على مجموعةٍ
-- مختارة. وبلا مُسنَدين: الإسناد فرديّ لكل مهمة، فلا معنى لـ«حملةٌ يعمل فيها فريق».
-- وبلا توجيهٍ لعدد الصور: الشاشة تقفل على صورةٍ واحدة نصّاً.
--
-- ثلاث إضافات محروسة: أعمدة النطاق والتوجيه على الحملة، وجدولا المنتجات المختارة
-- والمصوّرين. لا مسّ لأيّ صفٍّ قائم — الحملات الحالية تبقى `scopeKind='ALL'`
-- و`requiredImages=1`، أي بسلوكها الحاليّ حرفياً.
SET NAMES utf8mb4;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioCampaigns' AND COLUMN_NAME = 'scopeKind'),
    'SELECT 1',
    'ALTER TABLE `productStudioCampaigns` ADD COLUMN `scopeKind` ENUM(''ALL'',''CATEGORY'',''PRODUCTS'') NOT NULL DEFAULT ''ALL'''
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioCampaigns' AND COLUMN_NAME = 'scopeCategoryId'),
    'SELECT 1',
    'ALTER TABLE `productStudioCampaigns` ADD COLUMN `scopeCategoryId` BIGINT NULL'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioCampaigns' AND COLUMN_NAME = 'requiredImages'),
    'SELECT 1',
    'ALTER TABLE `productStudioCampaigns` ADD COLUMN `requiredImages` INT NOT NULL DEFAULT 1'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `productStudioCampaignProducts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `campaignId` BIGINT NOT NULL,
  `productId` BIGINT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_pscp_campaign_product` (`campaignId`, `productId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `productStudioCampaignAssignees` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `campaignId` BIGINT NOT NULL,
  `userId` INT NOT NULL,
  `createdBy` INT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_psca_campaign_user` (`campaignId`, `userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- مفاتيح أجنبية بأسماء صريحة قصيرة (حدّ ٦٤ محرفاً على MySQL 8.4).
SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioCampaignProducts' AND CONSTRAINT_NAME = 'fk_pscp_campaign'),
    'SELECT 1',
    'ALTER TABLE `productStudioCampaignProducts` ADD CONSTRAINT `fk_pscp_campaign` FOREIGN KEY (`campaignId`) REFERENCES `productStudioCampaigns`(`id`) ON DELETE CASCADE'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioCampaignProducts' AND CONSTRAINT_NAME = 'fk_pscp_product'),
    'SELECT 1',
    'ALTER TABLE `productStudioCampaignProducts` ADD CONSTRAINT `fk_pscp_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioCampaignAssignees' AND CONSTRAINT_NAME = 'fk_psca_campaign'),
    'SELECT 1',
    'ALTER TABLE `productStudioCampaignAssignees` ADD CONSTRAINT `fk_psca_campaign` FOREIGN KEY (`campaignId`) REFERENCES `productStudioCampaigns`(`id`) ON DELETE CASCADE'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioCampaignAssignees' AND CONSTRAINT_NAME = 'fk_psca_user'),
    'SELECT 1',
    'ALTER TABLE `productStudioCampaignAssignees` ADD CONSTRAINT `fk_psca_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`)'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
