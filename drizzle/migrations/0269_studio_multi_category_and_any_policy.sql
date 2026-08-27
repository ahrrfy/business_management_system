-- productStudioCampaigns: توسيعُ الحملة على محورين — سياسة الصور، وتعدّد الفئات.
--
-- **السياسة `imagesPolicy`**: كانت الحملة تفلتر تلقائياً المنتجات التي بلغَت
-- `requiredImages` — لا وسيلةَ لإضافة صورةٍ ثالثة لمنتجٍ بصورتين مثلاً. المالك يريد
-- وضعاً يستهدف كل المنتجات ضمن النطاق «بغض النظر عن أنّها تحمل صوراً أم لا». الوضعان:
--   ONLY_MISSING (افتراضيّ، متوافق) — السلوك القائم.
--   ANY_REGARDLESS               — يشمل كل منتجات النطاق بلا فحص الاكتمال.
--
-- **تعدّد الفئات**: `scopeKind='CATEGORY'` كان يقبل فئةً واحدة عبر `scopeCategoryId`.
-- المالك يريد اختيار **عدّة فئات** لحملةٍ واحدة. الحلّ:
--   • قيمة enum جديدة `CATEGORIES` (متعدّد) — القديمة `CATEGORY` تبقى للتوافق.
--   • جدول جانبيّ `productStudioCampaignCategories` (بنفس نمط `…CampaignProducts`).
--
-- التطبيق idempotent — فحوص INFORMATION_SCHEMA قبل كل تعديل.

SET @db := DATABASE();

-- ١) عمود `imagesPolicy` إن لم يوجد
SET @add_policy := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db
        AND TABLE_NAME = 'productStudioCampaigns'
        AND COLUMN_NAME = 'imagesPolicy'
    ),
    'SELECT ''imagesPolicy already present''',
    'ALTER TABLE `productStudioCampaigns` ADD COLUMN `imagesPolicy` ENUM(''ONLY_MISSING'', ''ANY_REGARDLESS'') NOT NULL DEFAULT ''ONLY_MISSING'''
  )
);
PREPARE stmt FROM @add_policy;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٢) توسيع enum لـ`scopeKind` بإضافة CATEGORIES
--    ALTER … MODIFY يُعيد تعريف العمود كاملاً بالقيمة الجديدة مضافةً. القيم القائمة
--    والافتراضيّ يُصانان (لا صفوفٌ فيها CATEGORIES بعد، فلا خطر).
ALTER TABLE `productStudioCampaigns`
  MODIFY COLUMN `scopeKind` ENUM('ALL', 'CATEGORY', 'CATEGORIES', 'PRODUCTS')
  NOT NULL DEFAULT 'ALL';
--> statement-breakpoint

-- ٣) جدول علاقة الحملة بفئاتها المتعدّدة (بنفس نمط `…CampaignProducts`)
CREATE TABLE IF NOT EXISTS `productStudioCampaignCategories` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `campaignId` BIGINT NOT NULL,
  `categoryId` BIGINT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_pscc_campaign_category` (`campaignId`, `categoryId`),
  KEY `idx_pscc_category` (`categoryId`),
  CONSTRAINT `fk_pscc_campaign` FOREIGN KEY (`campaignId`)
    REFERENCES `productStudioCampaigns`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pscc_category` FOREIGN KEY (`categoryId`)
    REFERENCES `categories`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
