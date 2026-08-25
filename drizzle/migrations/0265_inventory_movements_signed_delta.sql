-- 0265_inventory_movements_signed_delta: signed delta column + backfill
--
-- الغرض (P1-#3-أ، تقرير المراجعة ٢٥/٨): `inventoryMovements.quantity` تُخزَّن مطلقةً دائماً،
-- والاتجاهُ يُشتقّ من `movementType` — إلّا ADJUST الذي يخزّن `Math.abs(delta)` وتحصل الإشارة
-- من قراءةِ نصّ notes بـregex (`signedMoveQty` / `adjustSignedDelta`). ذلك يجعل بناءَ تقرير
-- مطابقةٍ SQL خامّاً (`opening + Σ signed = closing`) مستحيلاً بلا استدعاء JS، وأمسكه تعليقُ
-- `reconcileInventory` صراحةً: «لا يمكن إعادة بناء الرصيد بجمع الحركات».
--
-- الحلّ:
-- 1) عمودُ `signedDelta INT NULL` — writers جدد يعبّئونه (`applyMovement` + `setStock`).
-- 2) Backfill يُعبّئ كلّ الصفوف القائمة:
--    - IN/RETURN/TRANSFER_IN ⇒ +quantity
--    - OUT/TRANSFER_OUT      ⇒ -quantity
--    - ADJUST                 ⇒ SIGN(regex) × quantity  (يقرأ «(فرق ±N)» من notes)
--      * إن غاب النصّ (صفوف قديمة جداً): يبقى NULL — القرّاء يعرفون كيف يعالجونها.
--
-- ⚠️ لا FK هنا؛ ALTER + UPDATE بلا statement-breakpoint خاصّ.
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+). قد تُعاد عبر ci-apply-extra-migrations
-- أو migration-dry-run.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventoryMovements'
    AND COLUMN_NAME = 'signedDelta'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE `inventoryMovements` ADD COLUMN `signedDelta` INT NULL AFTER `quantity`',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- Backfill الحركاتِ الموجَّهة (IN/RETURN/TRANSFER_IN ⇒ + ; OUT/TRANSFER_OUT ⇒ -).
-- الشرطُ `signedDelta IS NULL` يجعل التكرارَ آمناً (لا نُعيد الكتابة على قيمٍ عبّأها writer جديد).
UPDATE `inventoryMovements`
SET `signedDelta` = CASE
  WHEN `movementType` IN ('IN','RETURN','TRANSFER_IN') THEN `quantity`
  WHEN `movementType` IN ('OUT','TRANSFER_OUT')        THEN -`quantity`
  ELSE `signedDelta`
END
WHERE `signedDelta` IS NULL
  AND `movementType` IN ('IN','RETURN','TRANSFER_IN','OUT','TRANSFER_OUT');
--> statement-breakpoint

-- Backfill ADJUST من الوسم النصّيّ `(فرق ±N)` الذي يُلحقه setStock دائماً في نهاية notes.
-- المطابقة على النهاية `$` وعلى وجود القوسين حصراً — كي لا نلتقط قيمةً من نصّ المستخدم الحرّ
-- (نفس منطق `adjustSignedDelta` في التطبيق).
--
-- ملاحظة: التطبيق يكتب ASCII `-` أو `+` أو بدون علامة (موجب). لا نُعالج علامةَ Unicode Minus
-- هنا لأنّها لم تُكتَب أبداً من مسار المنتج؛ لو ظهرت في بياناتٍ مستوردة قديمة تبقى الحركةُ
-- بـNULL ولا نُخمّن. القارئُ الجديد يعامل NULL كحركةٍ لا تدخل المجموع (والتقرير يُظهرها).
UPDATE `inventoryMovements`
SET `signedDelta` = CASE
  WHEN `notes` REGEXP '\\(فرق[[:space:]]*-[[:space:]]*[0-9]+\\)[[:space:]]*$' THEN -`quantity`
  WHEN `notes` REGEXP '\\(فرق[[:space:]]*\\+?[[:space:]]*[0-9]+\\)[[:space:]]*$' THEN `quantity`
  ELSE `signedDelta`
END
WHERE `signedDelta` IS NULL AND `movementType` = 'ADJUST';
