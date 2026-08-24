-- 0262_show_in_print_pos: designation column for print/copy POS grid visibility
--
-- المشكلة: `listPrintServices` كان يُصفّي بـ`productType='PRINT_SERVICE'` STRICT ⇒ خدماتٌ
-- مُنشأةٌ قبل توفّر التبديل، أو المُستوردة، أو المُنشأة عبر مسارٍ آخر (بلا productType) —
-- **كلُّها تختفي** من شبكة كاشير الطباعة رغم كونها `isService=true`. النتيجة عند المالك:
-- «لماذا خدمتان فقط؟» رغم أن الكتالوج يحوي عشرات الخدمات المؤهَّلة.
--
-- الحل: عمود `showInPrintPos` صريحٌ ومستقلٌّ عن `productType` — مرآةً لـ`showInReception`
-- (نمط تصميم قائم). التعبئة الخلفيّة تُبقي كلّ خدمةٍ مؤهَّلة ظاهرة:
--   showInPrintPos = TRUE  حيث  productType='PRINT_SERVICE'  فقط.
-- بضاعة رقميّة (DIGITAL_CARD) وسلعٌ ملموسة (isService=false) تبقى FALSE.
--
-- ⚠️ Codex P1 (٢٤/٨ على PR #757): كانت التعبئةُ تُغطّي أيضاً `isService=TRUE AND productType IS NULL`،
-- بادّعاء «خدمات قديمة». لكنّ ServiceForm.createProduct يخزّن هذه الحالةَ **بالضبط** حين يعطّل
-- المدير تبديل «نقطة الطباعة» عمداً عند الإنشاء (`printService: false` ⇒ `productType: null`)،
-- فالتعبئةُ كانت تعكس اختيارَه صامتاً — يظهر البند فجأةً في شبكة الطباعة بعد نشر الهجرة. ضيّقنا
-- الفلترَ إلى `productType='PRINT_SERVICE'` فقط: هويّةٌ تشغيليّة صريحة لا يُلبس بها اختيارُ رؤية.
-- الأثر على prod الذي طبّق النسخة الأوسع بالفعل: لا شيء (drizzle يتخطّى بحسب `when`)؛ لكن أيّ
-- بيئةٍ جديدة/دورةِ اختبار CI تُطبّقها بالنسخة الضيّقة الصحيحة. المدير يستطيع تحرير الرؤية يدوياً
-- بعد الآن عبر تبديلَي ProductEdit (شريحة PR #757).
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+ في هذا المستودع) — الهجرة قد تُعاد
-- تشغيلاً عبر ci-apply-extra-migrations أو migration-dry-run.
--
-- ⚠️ لا FK هنا؛ لا حاجة statement-breakpoint خاصّ بين ALTER وUPDATE (كلاهما DDL/DML مستقل).

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'showInPrintPos'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE `products` ADD COLUMN `showInPrintPos` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- التعبئة الخلفيّة: تُنفَّذ دائماً حتى على قواعدَ سبق تطبيق الـALTER فيها بلا تعبئة (idempotent).
-- الشرط `= FALSE` يحمي من طمس تحرير المدير اليدويّ اللاحق حين تُعاد الهجرة. النطاقُ ضيّق: فقط
-- ما يحمل `productType='PRINT_SERVICE'` صراحةً — لا اجتهادَ في تفسير `productType IS NULL`.
UPDATE `products`
SET `showInPrintPos` = TRUE
WHERE `showInPrintPos` = FALSE
  AND `productType` = 'PRINT_SERVICE';
