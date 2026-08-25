-- productImageJobs: صور مستقلّة لكل بديل/متغيّر بباركود مستقل.
--
-- المشكلة: القيد الفريد `uq_pijob_product_active(productId, activeSlot)` يجعل مهمّةً
-- نشطةً واحدةً لكل مُنتَجٍ أمّ بلا اعتبارٍ للبديل. المصوّر يمسح بديلاً B من منتجٍ لبديلٍ A
-- الذي بيده زميلٌ ⇒ يُرفَض بـ CONFLICT رغم أنّهما مختلفان. والصورة المعتمَدة تُنشَر
-- بـ `productImages.variantId = NULL` فتُعرض لكل البدائل بوصفها صورةً موحّدة، بينما
-- كل بديل «منتجٌ حقيقيٌّ مستقلّ (ماركة/منشأ مختلف)» يستحقّ صورته (schema.ts:895).
--
-- الحلّ: مفتاح فريدٌ مركَّبٌ يميّز كل (منتج، متغيّر). NULL في MySQL لا يُعامَل كقيمةٍ
-- متساوية في الفهارس الفريدة (اثنان بـNULL يمرّان)، فنستعمل عموداً مولَّداً STORED
-- يُعوّض NULL بـ0، فيصير كلّ (productId=X, variantId=NULL) مساوياً لـ(X, 0) في المفتاح.
-- بذلك:
--   • مسحُ بديل A ⇒ (X, id(A)) — فريدٌ عن (X, id(B))
--   • مسحُ الأمّ مباشرةً ⇒ (X, 0) — واحدةٌ نشطة لمهام مستوى المنتج
--   • كلاهما يتعايشان بلا تصادم
--
-- التطبيق idempotent (فحوص INFORMATION_SCHEMA قبل كلّ تعديل)، آمنٌ للتكرار على CI
-- والإنتاج والاختبار.

SET @db := DATABASE();

-- ١) إسقاط المفتاح القديم إن وُجد
SET @drop_old := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = @db
        AND TABLE_NAME = 'productImageJobs'
        AND INDEX_NAME = 'uq_pijob_product_active'
    ),
    'ALTER TABLE `productImageJobs` DROP INDEX `uq_pijob_product_active`',
    'SELECT ''old unique already dropped'''
  )
);
PREPARE stmt FROM @drop_old;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٢) إضافة العمود المولَّد VIRTUAL إن لم يكن موجوداً.
--    STORED هنا يُسقَط بـER 1215 لأنّ `variantId` يحمل قيدَ FK إلى productVariants،
--    وMySQL 8 يمنع STORED GENERATED على عمودٍ ذي FK. VIRTUAL يعمل ويقبل الفهارس
--    (يُخزَّن الفهرسُ ذاتُه، لا العمود) — كافٍ لمفتاحٍ فريدٍ يعزل كلّ (منتج، متغيّر).
SET @add_col := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db
        AND TABLE_NAME = 'productImageJobs'
        AND COLUMN_NAME = 'variantScope'
    ),
    'SELECT ''variantScope already present''',
    'ALTER TABLE `productImageJobs` ADD COLUMN `variantScope` BIGINT AS (IFNULL(`variantId`, 0)) VIRTUAL'
  )
);
PREPARE stmt FROM @add_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٣) إضافة المفتاح الفريد المركَّب الجديد إن لم يكن موجوداً
SET @add_new := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = @db
        AND TABLE_NAME = 'productImageJobs'
        AND INDEX_NAME = 'uq_pijob_product_variant_active'
    ),
    'SELECT ''new unique already present''',
    'ALTER TABLE `productImageJobs` ADD UNIQUE KEY `uq_pijob_product_variant_active` (`productId`, `variantScope`, `activeSlot`)'
  )
);
PREPARE stmt FROM @add_new;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
