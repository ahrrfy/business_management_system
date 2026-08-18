-- 0202 — كتالوج فئات السندات الافتراضي: بذرٌ مكتمل + حسمُ ما تركته 0190 بلا تعيين.
--
-- البلاغ (١٧/٨/٢٦): «عند إنشاء سند قبض يطلب اختيار الفئة إلزامياً ولا أستطيع إنشاء الفئة».
-- الجذر بيانيّ لا برمجيّ: 0036 بذرت ١٧ فئة بلا حسابٍ مقابل، و0190 عيّنت ١٣ منها فتركت ٤ معطّلةً
-- عملياً. وعلى **سند القبض** لم يبقَ صالحاً سوى «إيرادات متفرّقة» و«فوائد بنكية» — بينما أدوار
-- القبض المتاحة خمسة (إيراد آخر/رأس مال/جاري المالك/قرض/أمانة) بلا مدخلٍ واحدٍ لثلاثةٍ منها.
--
-- هذه الهجرة idempotent بالكامل (INSERT مشروط بـLEFT JOIN، وUPDATE محصور بـNULL) وآمنة للتكرار:
--   ١) تُدخل الفئات الناقصة من الكتالوج (shared/voucherCategoryDefaults.ts — يحرس التطابق اختبار).
--   ٢) تملأ postingRole **للفارغ فقط** ومتى طابق الاتجاهُ الكتالوج (لا تُعيد تصنيف ما عيّنه المالك).
--   ٣) تُعطّل الفئات الغامضة بنيوياً **إن لم تُستعمل في أي سند** — «إيداع نقدي بنكي» تحويلُ خزينة
--      لا سند، و«ردّ مَردودات/استرداد» مساره مرتجع البيع، و«أخرى» تخفي المصروف والإيراد معاً.
--      المستعمَل منها يبقى كما هو ليقرّره المالك من شاشة المعالجة — لا نُعيد تصنيف تاريخٍ صامتاً.
-- لا حذف صفّ ولا مسّ لسند: الفئات المرتبطة بسندات تحتفظ بربطها كاملاً.
SET NAMES utf8mb4;
--> statement-breakpoint

-- (١) الفئات الناقصة. LEFT JOIN بدل INSERT IGNORE عمداً: IGNORE يبتلع خرق CHECK صامتاً
-- (نفس فخّ بذر شجرة الحسابات المذكور في ci-apply-extra-migrations) بينما هذا يُفشل الهجرة بصوتٍ عالٍ.
INSERT INTO `voucherCategories`
  (`name`, `voucherCategoryDirection`, `postingRole`, `description`, `sortOrder`, `isActive`)
SELECT d.`name`, d.`dir`, d.`role`, d.`descr`, d.`ord`, TRUE
FROM (
    SELECT 'إيجار' AS `name`, 'OUT' AS `dir`, 'RENT' AS `role`, 'إيجار المحل أو المخزن أو المعرض' AS `descr`, 10 AS `ord`
    UNION ALL SELECT 'رواتب', 'OUT', 'SALARIES', 'رواتب الموظفين الشهرية', 20
    UNION ALL SELECT 'أجور عمّال يومية', 'OUT', 'SALARIES', 'أجور المياومة والعمل الإضافي المدفوعة نقداً', 25
    UNION ALL SELECT 'مكافآت وحوافز الموظفين', 'OUT', 'SALARIES', 'مكافآت وحوافز خارج الراتب الأساسي', 28
    UNION ALL SELECT 'خدمات (ماء/كهرباء/إنترنت)', 'OUT', 'UTILITIES', 'فواتير الماء والكهرباء والإنترنت والهاتف', 30
    UNION ALL SELECT 'اشتراك مولّدة كهرباء', 'OUT', 'UTILITIES', 'اشتراك المولّدة الأهلية الشهري', 35
    UNION ALL SELECT 'صيانة وإصلاح', 'OUT', 'OPERATING_EXPENSE', 'صيانة المكائن والأجهزة والمحل', 40
    UNION ALL SELECT 'مستلزمات طباعة (أحبار وتونر وورق)', 'OUT', 'OPERATING_EXPENSE', 'مستهلكات الطباعة التي تُصرف مباشرةً بلا إدخال مخزني', 45
    UNION ALL SELECT 'مواصلات ووقود', 'OUT', 'OPERATING_EXPENSE', 'وقود المركبات وأجور التنقّل', 50
    UNION ALL SELECT 'أجور توصيل ونقل', 'OUT', 'DELIVERY_EXPENSE', 'أجور مندوبي التوصيل وشركات النقل', 55
    UNION ALL SELECT 'قرطاسية ونثريات', 'OUT', 'OPERATING_EXPENSE', 'قرطاسية الإدارة والمصاريف النثرية الصغيرة', 60
    UNION ALL SELECT 'ضيافة ونظافة', 'OUT', 'OPERATING_EXPENSE', 'ضيافة الزبائن ومواد النظافة', 65
    UNION ALL SELECT 'إعلانات وتسويق', 'OUT', 'OPERATING_EXPENSE', 'إعلانات ولوحات ورعاية وتسويق رقمي', 70
    UNION ALL SELECT 'هدايا وترويج للزبائن', 'OUT', 'GIFTS_PROMO', 'هدايا ترويجية للزبائن والمناسبات', 75
    UNION ALL SELECT 'تبرّعات ومساعدات', 'OUT', 'OTHER_EXPENSE', 'تبرّعات ومساعدات اجتماعية', 80
    UNION ALL SELECT 'اشتراكات وتراخيص برامج', 'OUT', 'OPERATING_EXPENSE', 'اشتراكات البرامج والتصاميم والخدمات السحابية', 85
    UNION ALL SELECT 'ضرائب ورسوم حكومية', 'OUT', 'OTHER_EXPENSE', 'رسوم الدوائر الحكومية وإجازة العمل والضرائب', 90
    UNION ALL SELECT 'سحب شخصي/مالك', 'OUT', 'OWNER_CURRENT', 'سحب المالك لحسابه الجاري (لا مصروف)', 100
    UNION ALL SELECT 'عُمولات وأتعاب', 'OUT', 'OPERATING_EXPENSE', 'عمولات الوسطاء وأتعاب المحاسب والمحامي', 110
    UNION ALL SELECT 'مصاريف بنكية', 'OUT', 'OPERATING_EXPENSE', 'رسوم الحوالات وعمولات البنك والمحافظ', 120
    UNION ALL SELECT 'تسديد قرض', 'OUT', 'LOAN_PAYABLE', 'تسديد أقساط القروض (يُنقص التزام القرض لا مصروفاً)', 135
    UNION ALL SELECT 'ردّ أمانات وتأمينات', 'OUT', 'OTHER_LIABILITY', 'إعادة أمانة أو تأمين محتجز إلى صاحبه', 145
    UNION ALL SELECT 'خسائر وتلف', 'OUT', 'LOSSES', 'تلف أو ضياع أو خسارة تشغيلية مثبتة', 155
    UNION ALL SELECT 'نقص/عجز صندوق', 'OUT', 'LOSSES', 'عجز نقدي مثبت بعد تسوية الدرج', 165
    UNION ALL SELECT 'مصروفات أخرى', 'OUT', 'OTHER_EXPENSE', 'مصروف تشغيلي لا تشمله الفئات أعلاه', 175
    UNION ALL SELECT 'إيرادات متفرّقة', 'IN', 'OTHER_REVENUE', 'إيراد نقدي متفرّق خارج فواتير البيع', 140
    UNION ALL SELECT 'فوائد بنكية', 'IN', 'OTHER_REVENUE', 'فوائد وأرباح حسابات بنكية', 150
    UNION ALL SELECT 'رأس مال — إيداع المالك', 'IN', 'CAPITAL', 'زيادة رأس المال بإيداع من المالك (حقوق ملكية)', 210
    UNION ALL SELECT 'إيداع من المالك (حساب جاري)', 'IN', 'OWNER_CURRENT', 'دعم نقدي مؤقّت من المالك يُردّ لاحقاً', 220
    UNION ALL SELECT 'قرض مستلم', 'IN', 'LOAN_PAYABLE', 'قرض وارد ينشئ التزاماً يُسدَّد لاحقاً', 230
    UNION ALL SELECT 'أمانات وتأمينات مستلمة', 'IN', 'OTHER_LIABILITY', 'مبلغ محتجز لصالح الغير له مسار خروجٍ دائماً', 240
    UNION ALL SELECT 'إيراد تأجير معدات أو خدمات', 'IN', 'OTHER_REVENUE', 'تأجير ماكنة أو مساحة أو خدمة خارج المبيعات', 250
    UNION ALL SELECT 'بيع مخلفات وورق تالف', 'IN', 'OTHER_REVENUE', 'بيع الكرتون والورق التالف والمخلفات', 260
    UNION ALL SELECT 'تعويضات ومطالبات مستلمة', 'IN', 'OTHER_REVENUE', 'تعويض من مورّد أو شركة تأمين أو ناقل', 270
    UNION ALL SELECT 'استرداد مصروفات سابقة', 'IN', 'OTHER_REVENUE', 'استرجاع مبلغ صُرف سابقاً (يُعترف إيراداً آخر بالمعالجة المبسّطة)', 280
) AS d
LEFT JOIN `voucherCategories` c
  ON c.`name` COLLATE utf8mb4_unicode_ci = d.`name` COLLATE utf8mb4_unicode_ci
WHERE c.`id` IS NULL;
--> statement-breakpoint

-- (٢) تعيين الحساب المقابل للفئات القديمة التي بقيت NULL — بشرط تطابق الاتجاه مع الكتالوج.
-- COLLATE صريحٌ على طرف الجدول المشتقّ في كل مقارنة: أعمدة الجدول utf8mb4_unicode_ci (هجرة 0036)
-- بينما حرفيّات الاستعلام تأخذ collation_connection (‏utf8mb4_0900_ai_ci بعد SET NAMES على MySQL 8)،
-- وUNION ALL يمنع دمج الجدول المشتقّ فيُماثَل عموداً بقابلية إكراهٍ مساوية ⇒ «Illegal mix of
-- collations» (1267). الطرف الصريح يفوز دائماً على الضمنيّ فتنضبط المقارنة أياً كان ترتيب القاعدة.
UPDATE `voucherCategories` c
JOIN (
    SELECT 'إيجار' AS `name`, 'OUT' AS `dir`, 'RENT' AS `role`, 'إيجار المحل أو المخزن أو المعرض' AS `descr`, 10 AS `ord`
    UNION ALL SELECT 'رواتب', 'OUT', 'SALARIES', 'رواتب الموظفين الشهرية', 20
    UNION ALL SELECT 'أجور عمّال يومية', 'OUT', 'SALARIES', 'أجور المياومة والعمل الإضافي المدفوعة نقداً', 25
    UNION ALL SELECT 'مكافآت وحوافز الموظفين', 'OUT', 'SALARIES', 'مكافآت وحوافز خارج الراتب الأساسي', 28
    UNION ALL SELECT 'خدمات (ماء/كهرباء/إنترنت)', 'OUT', 'UTILITIES', 'فواتير الماء والكهرباء والإنترنت والهاتف', 30
    UNION ALL SELECT 'اشتراك مولّدة كهرباء', 'OUT', 'UTILITIES', 'اشتراك المولّدة الأهلية الشهري', 35
    UNION ALL SELECT 'صيانة وإصلاح', 'OUT', 'OPERATING_EXPENSE', 'صيانة المكائن والأجهزة والمحل', 40
    UNION ALL SELECT 'مستلزمات طباعة (أحبار وتونر وورق)', 'OUT', 'OPERATING_EXPENSE', 'مستهلكات الطباعة التي تُصرف مباشرةً بلا إدخال مخزني', 45
    UNION ALL SELECT 'مواصلات ووقود', 'OUT', 'OPERATING_EXPENSE', 'وقود المركبات وأجور التنقّل', 50
    UNION ALL SELECT 'أجور توصيل ونقل', 'OUT', 'DELIVERY_EXPENSE', 'أجور مندوبي التوصيل وشركات النقل', 55
    UNION ALL SELECT 'قرطاسية ونثريات', 'OUT', 'OPERATING_EXPENSE', 'قرطاسية الإدارة والمصاريف النثرية الصغيرة', 60
    UNION ALL SELECT 'ضيافة ونظافة', 'OUT', 'OPERATING_EXPENSE', 'ضيافة الزبائن ومواد النظافة', 65
    UNION ALL SELECT 'إعلانات وتسويق', 'OUT', 'OPERATING_EXPENSE', 'إعلانات ولوحات ورعاية وتسويق رقمي', 70
    UNION ALL SELECT 'هدايا وترويج للزبائن', 'OUT', 'GIFTS_PROMO', 'هدايا ترويجية للزبائن والمناسبات', 75
    UNION ALL SELECT 'تبرّعات ومساعدات', 'OUT', 'OTHER_EXPENSE', 'تبرّعات ومساعدات اجتماعية', 80
    UNION ALL SELECT 'اشتراكات وتراخيص برامج', 'OUT', 'OPERATING_EXPENSE', 'اشتراكات البرامج والتصاميم والخدمات السحابية', 85
    UNION ALL SELECT 'ضرائب ورسوم حكومية', 'OUT', 'OTHER_EXPENSE', 'رسوم الدوائر الحكومية وإجازة العمل والضرائب', 90
    UNION ALL SELECT 'سحب شخصي/مالك', 'OUT', 'OWNER_CURRENT', 'سحب المالك لحسابه الجاري (لا مصروف)', 100
    UNION ALL SELECT 'عُمولات وأتعاب', 'OUT', 'OPERATING_EXPENSE', 'عمولات الوسطاء وأتعاب المحاسب والمحامي', 110
    UNION ALL SELECT 'مصاريف بنكية', 'OUT', 'OPERATING_EXPENSE', 'رسوم الحوالات وعمولات البنك والمحافظ', 120
    UNION ALL SELECT 'تسديد قرض', 'OUT', 'LOAN_PAYABLE', 'تسديد أقساط القروض (يُنقص التزام القرض لا مصروفاً)', 135
    UNION ALL SELECT 'ردّ أمانات وتأمينات', 'OUT', 'OTHER_LIABILITY', 'إعادة أمانة أو تأمين محتجز إلى صاحبه', 145
    UNION ALL SELECT 'خسائر وتلف', 'OUT', 'LOSSES', 'تلف أو ضياع أو خسارة تشغيلية مثبتة', 155
    UNION ALL SELECT 'نقص/عجز صندوق', 'OUT', 'LOSSES', 'عجز نقدي مثبت بعد تسوية الدرج', 165
    UNION ALL SELECT 'مصروفات أخرى', 'OUT', 'OTHER_EXPENSE', 'مصروف تشغيلي لا تشمله الفئات أعلاه', 175
    UNION ALL SELECT 'إيرادات متفرّقة', 'IN', 'OTHER_REVENUE', 'إيراد نقدي متفرّق خارج فواتير البيع', 140
    UNION ALL SELECT 'فوائد بنكية', 'IN', 'OTHER_REVENUE', 'فوائد وأرباح حسابات بنكية', 150
    UNION ALL SELECT 'رأس مال — إيداع المالك', 'IN', 'CAPITAL', 'زيادة رأس المال بإيداع من المالك (حقوق ملكية)', 210
    UNION ALL SELECT 'إيداع من المالك (حساب جاري)', 'IN', 'OWNER_CURRENT', 'دعم نقدي مؤقّت من المالك يُردّ لاحقاً', 220
    UNION ALL SELECT 'قرض مستلم', 'IN', 'LOAN_PAYABLE', 'قرض وارد ينشئ التزاماً يُسدَّد لاحقاً', 230
    UNION ALL SELECT 'أمانات وتأمينات مستلمة', 'IN', 'OTHER_LIABILITY', 'مبلغ محتجز لصالح الغير له مسار خروجٍ دائماً', 240
    UNION ALL SELECT 'إيراد تأجير معدات أو خدمات', 'IN', 'OTHER_REVENUE', 'تأجير ماكنة أو مساحة أو خدمة خارج المبيعات', 250
    UNION ALL SELECT 'بيع مخلفات وورق تالف', 'IN', 'OTHER_REVENUE', 'بيع الكرتون والورق التالف والمخلفات', 260
    UNION ALL SELECT 'تعويضات ومطالبات مستلمة', 'IN', 'OTHER_REVENUE', 'تعويض من مورّد أو شركة تأمين أو ناقل', 270
    UNION ALL SELECT 'استرداد مصروفات سابقة', 'IN', 'OTHER_REVENUE', 'استرجاع مبلغ صُرف سابقاً (يُعترف إيراداً آخر بالمعالجة المبسّطة)', 280
) AS d
  ON c.`name` COLLATE utf8mb4_unicode_ci = d.`name` COLLATE utf8mb4_unicode_ci
SET c.`postingRole` = d.`role`,
    c.`description` = COALESCE(NULLIF(c.`description`, ''), d.`descr` COLLATE utf8mb4_unicode_ci)
WHERE c.`postingRole` IS NULL
  AND c.`voucherCategoryDirection` = d.`dir` COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint

-- (٣) تقاعد الفئات الغامضة غير المستعملة — تختفي من منتقيات السندات الجديدة ويشرح وصفُها البديل.
UPDATE `voucherCategories` c
SET c.`isActive` = FALSE,
    c.`description` = CASE c.`name`
      WHEN 'إيداع نقدي بنكي' THEN 'متقاعدة: إيداع البنك تحويلُ خزينة لا سند — استعمل «تحويلات نقدية»'
      WHEN 'ردّ مَردودات/استرداد' THEN 'متقاعدة: استعمل مرتجع البيع من الفاتورة، أو «استرداد مصروفات سابقة»'
      WHEN 'أخرى' THEN 'متقاعدة: استعمل «مصروفات أخرى» للصرف و«إيرادات متفرّقة» للقبض'
      ELSE c.`description`
    END
WHERE c.`name` COLLATE utf8mb4_unicode_ci IN (
    'إيداع نقدي بنكي' COLLATE utf8mb4_unicode_ci,
    'ردّ مَردودات/استرداد' COLLATE utf8mb4_unicode_ci,
    'أخرى' COLLATE utf8mb4_unicode_ci
  )
  AND c.`postingRole` IS NULL
  AND c.`isActive` = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM `receipts` r WHERE r.`voucherCategoryId` = c.`id`
  );
