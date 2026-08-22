-- **هوية البدائل — نوع المتغيّر** (وثيقة «الجرد بالباركود» ٢٢/٨، م٣).
--
-- عمودٌ إضافيّ محضٌ لا يمسّ أي بيانات قائمة: `productVariants.variantKind` بقيمتين
-- VARIANT (تنويعة لون/قياس) و ALTERNATIVE (منتجٌ حقيقيٌّ مستقلّ تحت الاسم الجامع). الافتراض
-- VARIANT ⇒ كل المتغيّرات القائمة تبقى كما هي بلا أثرٍ سلوكيّ، والعرض لا يتغيّر حتى يُنشأ بديلٌ
-- فعليّ. اسمُ البديل في variantName القائم؛ ولا بديلَ بلا باركود (يُفرَض في طبقة الخدمة).
--
-- idempotent محروسٌ بـ information_schema.

SET NAMES utf8mb4;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productVariants'
    AND COLUMN_NAME = 'variantKind'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `productVariants` ADD COLUMN `variantKind` enum(''VARIANT'',''ALTERNATIVE'') NOT NULL DEFAULT ''VARIANT''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
