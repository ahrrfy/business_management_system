-- 0359 — وصفة فعّالة واحدة لكل ناتج، بلا نافذة سباق مع عمال الإصدار السابق.
--
-- MySQL لا يوفّر partial unique index. لذلك activeSlot=1 للنشط وNULL للخامل، وUNIQUE
-- يسمح بعدة NULL: يبقى أرشيف الوصفات الخاملة غير محدود، ويُمنع رأسان فعّالان للناتج نفسه.
-- نبقي أعلى id فعّالاً عند تنظيف الإرث لأنه يطابق سياسة القراءة السابقة (ORDER BY id DESC).
-- لا يُحذف رأس أو سطر؛ الإنتاج والتدقيق التاريخي يبقيان صالحين.
--
-- DDL في MySQL ذو implicit commit، والنشر يطبّق الهجرة قبل إعادة تحميل العمال. لذلك لا تكفي
-- معاملة أو LOCK TABLES بين UPDATE التنظيف وADD UNIQUE. نركّب أولاً حارسي DML انتقاليين:
-- كل كتابة بدأت قبل اكتمال CREATE TRIGGER تنتهي قبل حيازة metadata lock ثم يراها التنظيف،
-- وكل INSERT/تفعيل/إعادة توجيه فعّالة بعدها تُرفض حتى يثبت القيد. التعطيل والحذف وتعديل رأس
-- فعّال من دون تغيير ناتجه تبقى مسموحة. إن فشلت الهجرة يبقى الحارس fail-closed لإعادة آمنة.
--
-- الملف idempotent للمهاجر الحاكم ولمرآة ci-apply-extra-migrations بعد db:push. نمط pre→final
-- يمنع لحظةً بلا حارس عند إعادة تشغيل هجرة منقطعة، وهو نفس نمط حارس حجز طلب المتجر 0208.

SET @db := DATABASE();
SET @recipe_old_lock_wait_timeout := @@SESSION.lock_wait_timeout;
SET SESSION lock_wait_timeout = 60;
--> statement-breakpoint

-- ── 1) بوابة انتقالية لكتابات المفتاح الفعّال ────────────────────────────────

DROP TRIGGER IF EXISTS `trg_0359_recipe_active_pre_bi`;
--> statement-breakpoint

CREATE TRIGGER `trg_0359_recipe_active_pre_bi`
BEFORE INSERT ON `productionRecipes`
FOR EACH ROW
BEGIN
  IF NEW.`isActive` = 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'recipe activation paused during migration 0359';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_0359_recipe_active_pre_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_0359_recipe_active_pre_bu`
BEFORE UPDATE ON `productionRecipes`
FOR EACH ROW
BEGIN
  IF NEW.`isActive` = 1
    AND (
      NOT (OLD.`isActive` <=> 1)
      OR NOT (NEW.`outputVariantId` <=> OLD.`outputVariantId`)
    ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'recipe activation paused during migration 0359';
  END IF;
END;
--> statement-breakpoint

-- استبدل final تحت pre؛ عند إعادة التشغيل لا توجد لحظة تسمح بإضافة مفتاح فعّال.
DROP TRIGGER IF EXISTS `trg_0359_recipe_active_bi`;
--> statement-breakpoint

CREATE TRIGGER `trg_0359_recipe_active_bi`
BEFORE INSERT ON `productionRecipes`
FOR EACH ROW
BEGIN
  IF NEW.`isActive` = 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'recipe activation paused during migration 0359';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_0359_recipe_active_bu`;
--> statement-breakpoint

CREATE TRIGGER `trg_0359_recipe_active_bu`
BEFORE UPDATE ON `productionRecipes`
FOR EACH ROW
BEGIN
  IF NEW.`isActive` = 1
    AND (
      NOT (OLD.`isActive` <=> 1)
      OR NOT (NEW.`outputVariantId` <=> OLD.`outputVariantId`)
    ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'recipe activation paused during migration 0359';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_0359_recipe_active_pre_bi`;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_0359_recipe_active_pre_bu`;
--> statement-breakpoint

-- ── 2) افحص دلالة العمود والفهرس، لا مجرد اسميهما ───────────────────────────

SET @recipe_active_col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND COLUMN_NAME = 'activeSlot'
);

SET @recipe_active_col_ok := (
  SELECT IF(
    COUNT(*) = 1
      AND SUM(
        LOWER(DATA_TYPE) = 'tinyint'
        AND LOWER(COLUMN_TYPE) NOT LIKE '%unsigned%'
        AND IS_NULLABLE = 'YES'
        AND UPPER(EXTRA) LIKE '%VIRTUAL GENERATED%'
        AND REGEXP_REPLACE(
          LOWER(COALESCE(GENERATION_EXPRESSION, '')),
          '[[:space:]`()]+',
          ''
        ) = 'casewhenisactive=1then1elsenullend'
      ) = 1,
    1,
    0
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND COLUMN_NAME = 'activeSlot'
);

SET @recipe_active_idx_rows := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND INDEX_NAME = 'uq_recipe_active_output'
);

SET @recipe_active_idx_ok := (
  SELECT IF(
    COUNT(*) = 2
      AND GROUP_CONCAT(
        CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
        ORDER BY SEQ_IN_INDEX SEPARATOR ','
      ) = '1:outputVariantId,2:activeSlot'
      AND SUM(NON_UNIQUE = 0) = 2
      AND SUM(SUB_PART IS NULL) = 2
      AND SUM(UPPER(INDEX_TYPE) = 'BTREE') = 2
      AND SUM(UPPER(IS_VISIBLE) = 'YES') = 2
      AND SUM(UPPER(COLLATION) = 'A') = 2,
    1,
    0
  )
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND INDEX_NAME = 'uq_recipe_active_output'
);
--> statement-breakpoint

-- الاسم الصحيح مع بنية خاطئة ليس حارساً. أسقطه قبل إصلاح العمود أو إعادة بنائه.
SET @repair_recipe_active_index := IF(
  @recipe_active_idx_rows > 0
    AND (@recipe_active_idx_ok = 0 OR @recipe_active_col_ok = 0),
  'ALTER TABLE `productionRecipes` DROP INDEX `uq_recipe_active_output`',
  'SELECT ''uq_recipe_active_output shape already valid'''
);
PREPARE stmt FROM @repair_recipe_active_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- إن كان activeSlot خاطئاً، أسقط أي فهرس آخر يعتمد عليه قبل إسقاط العمود. العمود مساعد
-- مملوك لهذه الهجرة ولا يحمل بيانات مجال؛ إعادة بنائه لا تحذف وصفة أو سطر وصفة.
SET @recipe_active_dependent_index_drops := (
  SELECT GROUP_CONCAT(
    DISTINCT CONCAT(
      'DROP INDEX `',
      REPLACE(INDEX_NAME, '`', '``'),
      '`'
    )
    ORDER BY INDEX_NAME
    SEPARATOR ', '
  )
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND COLUMN_NAME = 'activeSlot'
    AND INDEX_NAME <> 'PRIMARY'
);

SET @repair_recipe_active_dependencies := IF(
  @recipe_active_col_exists = 1
    AND @recipe_active_col_ok = 0
    AND @recipe_active_dependent_index_drops IS NOT NULL,
  CONCAT(
    'ALTER TABLE `productionRecipes` ',
    @recipe_active_dependent_index_drops
  ),
  'SELECT ''activeSlot has no dependent indexes to repair'''
);
PREPARE stmt FROM @repair_recipe_active_dependencies;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @drop_bad_recipe_active_slot := IF(
  @recipe_active_col_exists = 1 AND @recipe_active_col_ok = 0,
  'ALTER TABLE `productionRecipes` DROP COLUMN `activeSlot`',
  'SELECT ''activeSlot does not require replacement'''
);
PREPARE stmt FROM @drop_bad_recipe_active_slot;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @recipe_active_col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND COLUMN_NAME = 'activeSlot'
);

SET @add_recipe_active_slot := IF(
  @recipe_active_col_exists = 0,
  'ALTER TABLE `productionRecipes` ADD COLUMN `activeSlot` TINYINT GENERATED ALWAYS AS (CASE WHEN `isActive` = 1 THEN 1 ELSE NULL END) VIRTUAL',
  'SELECT ''productionRecipes.activeSlot shape already valid'''
);
PREPARE stmt FROM @add_recipe_active_slot;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ── 3) تنظيف الإرث تحت الحارس ثم إنشاء القيد online ────────────────────────

UPDATE `productionRecipes` AS older
INNER JOIN `productionRecipes` AS newer
  ON newer.`outputVariantId` = older.`outputVariantId`
  AND newer.`isActive` = 1
  AND newer.`id` > older.`id`
SET older.`isActive` = 0
WHERE older.`isActive` = 1;
--> statement-breakpoint

SET @recipe_active_idx_rows := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND INDEX_NAME = 'uq_recipe_active_output'
);

SET @add_recipe_active_unique := IF(
  @recipe_active_idx_rows = 0,
  'ALTER TABLE `productionRecipes` ADD UNIQUE KEY `uq_recipe_active_output` (`outputVariantId`, `activeSlot`), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT ''uq_recipe_active_output shape already valid'''
);
PREPARE stmt FROM @add_recipe_active_unique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ── 4) postconditions: لا تفتح الكتابة ما لم تثبت الدلالة كاملة ─────────────

SET @recipe_active_col_ok := (
  SELECT IF(
    COUNT(*) = 1
      AND SUM(
        LOWER(DATA_TYPE) = 'tinyint'
        AND LOWER(COLUMN_TYPE) NOT LIKE '%unsigned%'
        AND IS_NULLABLE = 'YES'
        AND UPPER(EXTRA) LIKE '%VIRTUAL GENERATED%'
        AND REGEXP_REPLACE(
          LOWER(COALESCE(GENERATION_EXPRESSION, '')),
          '[[:space:]`()]+',
          ''
        ) = 'casewhenisactive=1then1elsenullend'
      ) = 1,
    1,
    0
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND COLUMN_NAME = 'activeSlot'
);

SET @recipe_active_idx_ok := (
  SELECT IF(
    COUNT(*) = 2
      AND GROUP_CONCAT(
        CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
        ORDER BY SEQ_IN_INDEX SEPARATOR ','
      ) = '1:outputVariantId,2:activeSlot'
      AND SUM(NON_UNIQUE = 0) = 2
      AND SUM(SUB_PART IS NULL) = 2
      AND SUM(UPPER(INDEX_TYPE) = 'BTREE') = 2
      AND SUM(UPPER(IS_VISIBLE) = 'YES') = 2
      AND SUM(UPPER(COLLATION) = 'A') = 2,
    1,
    0
  )
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productionRecipes'
    AND INDEX_NAME = 'uq_recipe_active_output'
);

SET @recipe_active_duplicate_groups := (
  SELECT COUNT(*)
  FROM (
    SELECT `outputVariantId`
    FROM `productionRecipes`
    WHERE `isActive` = 1
    GROUP BY `outputVariantId`
    HAVING COUNT(*) > 1
  ) AS duplicate_active_outputs
);

-- SIGNAL غير مسموح كـprepared statement في MySQL؛ اسم الجدول المتعمّد الغياب يجعل
-- الإخفاق صريحاً ويبقي final triggers مثبتة إن انكسر أي postcondition.
SET @assert_recipe_active_contract := IF(
  @recipe_active_col_ok = 1
    AND @recipe_active_idx_ok = 1
    AND @recipe_active_duplicate_groups = 0,
  'SELECT ''0359 recipe active contract verified''',
  'SELECT * FROM `__0359_RECIPE_ACTIVE_CONTRACT_FAILED__`'
);
PREPARE stmt FROM @assert_recipe_active_contract;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- القيد المثبت صار الحارس الدائم؛ الآن فقط أزل بوابة النشر الانتقالية.
DROP TRIGGER IF EXISTS `trg_0359_recipe_active_bi`;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_0359_recipe_active_bu`;
--> statement-breakpoint

SET SESSION lock_wait_timeout = @recipe_old_lock_wait_timeout;
