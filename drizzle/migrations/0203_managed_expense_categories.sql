-- 0203 — فئات المصروفات المُدارة: طبقةٌ تشغيلية فوق الدلو المحاسبيّ، لا بديلٌ عنه.
--
-- `expenses.expenseCategory` عمود ENUM بثمانية بنود **يقود المحاسبة فعلياً**: `expenseRole()`
-- يشتقّ منه حساب الدفتر، وملفّ الترحيل يفرّق PAYMENT_OUT_SALARY عن PAYMENT_OUT_EXPENSE،
-- واستعلامات جاهزية الإقفال تطابق 'TRANSPORT'/'MAINTENANCE' نصّاً. توسيعه يمسّ الثلاثة معاً.
-- لذلك يبقى دلواً ثابتاً، ويُبنى فوقه جدولٌ **يديره المالك** بتصنيفٍ دقيق (وقود/أحبار/مولّدة…)
-- يُعلن كلُّ بندٍ فيه دلوَه، فيكتب المصروف الفئةَ ودلوَها معاً ⇒ صفر تغيير في الدفتر والتقارير.
--
-- idempotent بالكامل: إنشاءٌ محروس، إدراجٌ مشروط بـLEFT JOIN، وردمٌ رجعيّ على NULL فقط.
-- لا حذف صفّ ولا مسّ مبلغٍ ولا قيد.
SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `expenseCategories` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `expenseCategoryBucket` ENUM('RENT','UTILITIES','SUPPLIES','SALARY','TRANSPORT','MAINTENANCE','MARKETING','OTHER') NOT NULL,
  `description` VARCHAR(300) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
  `isBucketDefault` BOOLEAN NOT NULL DEFAULT FALSE,
  `sortOrder` INT NOT NULL DEFAULT 0,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_expcat_name` (`name`),
  KEY `idx_expcat_active` (`isActive`),
  KEY `idx_expcat_bucket` (`expenseCategoryBucket`, `isBucketDefault`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- (١) الكتالوج الافتراضي (shared/expenseCategories.ts — يحرس التطابق اختبار وحدة).
-- LEFT JOIN بدل INSERT IGNORE: الأخير يبتلع خرق القيود صامتاً فيترك دلواً بلا فئة احتياطية.
-- COLLATE صريح على طرف الجدول المشتقّ: حرفيّات الاستعلام تأخذ collation_connection بينما
-- أعمدة الجدول utf8mb4_unicode_ci، وUNION ALL يمنع الدمج ⇒ «Illegal mix of collations» (1267).
INSERT INTO `expenseCategories`
  (`name`, `expenseCategoryBucket`, `description`, `sortOrder`, `isBucketDefault`, `isActive`)
SELECT d.`name`, d.`bucket`, d.`descr`, d.`ord`, d.`isDefault`, TRUE
FROM (
    SELECT 'إيجار المحل والمخزن' AS `name`, 'RENT' AS `bucket`, 'إيجار المعرض أو المخزن أو الورشة' AS `descr`, 10 AS `ord`, 1 AS `isDefault`
    UNION ALL SELECT 'إيجار سكن ومرافق', 'RENT', 'إيجار سكن الموظفين أو مرافق مساندة', 15, 0
    UNION ALL SELECT 'خدمات وفواتير (ماء وكهرباء وإنترنت)', 'UTILITIES', 'فواتير الماء والكهرباء الوطنية والإنترنت', 20, 1
    UNION ALL SELECT 'اشتراك مولّدة كهرباء', 'UTILITIES', 'اشتراك المولّدة الأهلية الشهري', 25, 0
    UNION ALL SELECT 'هاتف واتصالات', 'UTILITIES', 'أرصدة الهاتف وخطوط الاتصال', 30, 0
    UNION ALL SELECT 'لوازم ومستهلكات', 'SUPPLIES', 'لوازم تشغيلية عامة تُصرف مباشرةً بلا إدخال مخزني', 40, 1
    UNION ALL SELECT 'مستلزمات طباعة (أحبار وتونر وورق)', 'SUPPLIES', 'مستهلكات المطبعة التي لا تدخل المخزن', 45, 0
    UNION ALL SELECT 'قرطاسية إدارية', 'SUPPLIES', 'قرطاسية الإدارة والدفاتر والنماذج', 50, 0
    UNION ALL SELECT 'مواد نظافة وضيافة', 'SUPPLIES', 'مواد التنظيف وضيافة الزبائن', 55, 0
    UNION ALL SELECT 'أكياس ومواد تغليف', 'SUPPLIES', 'أكياس وكراتين ومواد تغليف الطلبات', 60, 0
    UNION ALL SELECT 'مرتبات الموظفين', 'SALARY', 'الرواتب الشهرية المدفوعة نقداً خارج مسير الأجور', 70, 1
    UNION ALL SELECT 'أجور عمّال يومية', 'SALARY', 'أجور المياومة والعمل الإضافي', 75, 0
    UNION ALL SELECT 'مكافآت وحوافز', 'SALARY', 'مكافآت وحوافز خارج الراتب الأساسي', 80, 0
    UNION ALL SELECT 'مواصلات وشحن', 'TRANSPORT', 'أجور التنقّل والشحن الداخلي', 90, 1
    UNION ALL SELECT 'وقود ومحروقات', 'TRANSPORT', 'وقود المركبات والمولّدة', 95, 0
    UNION ALL SELECT 'أجور توصيل الطلبات', 'TRANSPORT', 'أجور مندوبي التوصيل وشركات النقل', 100, 0
    UNION ALL SELECT 'صيانة وإصلاح', 'MAINTENANCE', 'صيانة عامة للمحل والأثاث والأجهزة', 110, 1
    UNION ALL SELECT 'صيانة مكائن الطباعة', 'MAINTENANCE', 'صيانة وقطع غيار مكائن الطباعة والقصّ', 115, 0
    UNION ALL SELECT 'صيانة مركبات', 'MAINTENANCE', 'صيانة سيارات التوصيل والدرّاجات', 120, 0
    UNION ALL SELECT 'تسويق وإعلان', 'MARKETING', 'حملات التسويق والإعلان الرقمي واللوحات', 130, 1
    UNION ALL SELECT 'طباعة مواد دعائية', 'MARKETING', 'بروشورات وكروت وستاندات دعائية للمكتبة', 135, 0
    UNION ALL SELECT 'رعاية ومناسبات', 'MARKETING', 'رعاية فعاليات ومعارض ومناسبات التخرّج', 140, 0
    UNION ALL SELECT 'مصروفات أخرى', 'OTHER', 'مصروف لا تشمله الفئات أعلاه', 150, 1
    UNION ALL SELECT 'رسوم حكومية وإجازات', 'OTHER', 'رسوم الدوائر الحكومية وإجازة العمل', 155, 0
    UNION ALL SELECT 'عمولات وأتعاب مهنية', 'OTHER', 'أتعاب المحاسب والمحامي وعمولات الوسطاء', 160, 0
    UNION ALL SELECT 'مصاريف بنكية وحوالات', 'OTHER', 'رسوم الحوالات وعمولات البنك والمحافظ', 165, 0
    UNION ALL SELECT 'تبرّعات ومساعدات', 'OTHER', 'تبرّعات ومساعدات اجتماعية', 170, 0
) AS d
LEFT JOIN `expenseCategories` c
  ON c.`name` COLLATE utf8mb4_unicode_ci = d.`name` COLLATE utf8mb4_unicode_ci
WHERE c.`id` IS NULL;
--> statement-breakpoint

-- (٢) عمود الربط على المصروف + فهرسه + قيد المفتاح الأجنبي — كلّها محروسة idempotently
-- (نمط 0036) لأن db:push/الهجرات الجزئية قد تكون سبقتنا إلى بعضها.
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expenses' AND COLUMN_NAME = 'expenseCategoryId') = 0,
  'ALTER TABLE `expenses` ADD COLUMN `expenseCategoryId` BIGINT NULL AFTER `expenseCategory`',
  'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expenses' AND INDEX_NAME = 'idx_expense_managed_category') = 0,
  'ALTER TABLE `expenses` ADD INDEX `idx_expense_managed_category` (`expenseCategoryId`)',
  'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
--> statement-breakpoint

-- (٣) الردم الرجعيّ: كل مصروفٍ قائم يُسنَد إلى فئة دلوه الاحتياطية. الدلو نفسه لا يُمَسّ
-- إطلاقاً ⇒ لا حساب يتغيّر ولا تقرير ينحرف؛ الإسناد إثراءُ تصنيفٍ لا إعادةُ تصنيف.
-- COLLATE صريح على طرفٍ واحد يكفي (الصريح يفوز على الضمنيّ): العمودان ENUM في جدولين
-- قد يختلف ترتيبهما (‏expenses أقدم من هذا الجدول) ⇒ بلا ذلك يُحتمل خطأ 1267.
UPDATE `expenses` e
JOIN `expenseCategories` c
  ON c.`expenseCategoryBucket` COLLATE utf8mb4_unicode_ci = e.`expenseCategory`
 AND c.`isBucketDefault` = TRUE
SET e.`expenseCategoryId` = c.`id`
WHERE e.`expenseCategoryId` IS NULL;
--> statement-breakpoint

-- (٤) قيد المفتاح الأجنبي بعد الردم (يفشل قبله لو بقيت قيمة يتيمة). RESTRICT عمداً:
-- الفئة لا تُحذف أبداً بل تُعطَّل، والقيد يجعل ذلك حقيقةً في القاعدة لا اتفاقاً في الكود.
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expenses'
      AND COLUMN_NAME = 'expenseCategoryId' AND REFERENCED_TABLE_NAME = 'expenseCategories') = 0,
  'ALTER TABLE `expenses` ADD CONSTRAINT `fk_expenses_expcat` FOREIGN KEY (`expenseCategoryId`) REFERENCES `expenseCategories`(`id`)',
  'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
