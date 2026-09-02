-- ═══ سحبُ طلب التحكّم من طالبه — مخرج الطريق المسدود (تدقيق ١/٩/٢٦) ═══
--
-- البلاغ: «مرتجع الفواتير وهميّ ولا أثر له ويبتلع المخزن». أحد جذوره أنّ الطلب المعلَّق
-- قد يصير **غير قابلٍ للاعتماد ولا للرفض**: `assertReviewerSeparation` يحجب الطالبَ ومنشئَ
-- الفاتورة معاً على **كلا** الفعلين، ومع الفهرس الفريد على `activeInvoiceId` تُقفَل الفاتورة
-- ضدّ كلّ عمليات التحكّم (مرتجع/إلغاء/تصحيح/استبدال/استحقاق) إلى الأبد.
--
-- والسحبُ ليس مراجعةً: هو تراجعُ صاحب الطلب عن اقتراحه، وأثرُه صفرٌ ماليّاً ومخزنياً —
-- كلّ ما يفعله أن يُخرج `status` من PENDING فيصير `activeInvoiceId` بـNULL وتتحرّر الفاتورة.
-- فرضُ فصل المهام على فعلٍ صفريّ الأثر لا يشتري رقابةً، بل قفلاً دائماً على مستندٍ حيّ.
-- ⚠️ الاعتماد يبقى محكوماً بفصل المهام كما هو — لم يُمَسّ.
--
-- ثلاثةُ قيودٍ تمنع تمثيل الحالة اليوم، وهذه الهجرة تُوسّعها:
--   ١) enum الحالة بلا WITHDRAWN.
--   ٢) `chk_sales_control_decision_shape` لا يعرف الحالة الجديدة.
--   ٣) `chk_sales_control_maker_checker` يشترط `reviewedBy <> requestedBy` — وهو بالضبط ما
--      يستحيل تحقيقه في السحب (الساحبُ هو الطالب). يُستثنى السحبُ وحده، ويبقى القيد سارياً
--      على APPROVED/REJECTED حيث يعني شيئاً.
--
-- `activeInvoiceId` عمودٌ مولَّدٌ مخزَّن على `status`؛ توسيعُ الـenum يُبقي تعبيره صالحاً
-- (WITHDRAWN ≠ 'PENDING' ⇒ NULL) فلا يلزم إسقاطُه ولا إسقاطُ فهرسه الفريد.

-- ① توسيع enum الحالة (idempotent: يُعاد تنفيذه بلا ضرر).
SET @needs_withdrawn := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'salesControlRequests'
    AND column_name = 'status'
    AND column_type NOT LIKE '%WITHDRAWN%'
);
SET @sql := IF(@needs_withdrawn = 1,
  'ALTER TABLE `salesControlRequests` MODIFY COLUMN `status` ENUM(''PENDING'',''APPROVED'',''REJECTED'',''STALE'',''WITHDRAWN'') NOT NULL DEFAULT ''PENDING''',
  'SELECT ''salesControlRequests.status already has WITHDRAWN'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ② شكل القرار: السحب يحمل ساحباً ووقتاً، وبلا `appliedAt` (لا أثر نُفِّذ).
SET @has_shape := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'salesControlRequests'
    AND constraint_name = 'chk_sales_control_decision_shape'
);
SET @sql := IF(@has_shape > 0,
  'ALTER TABLE `salesControlRequests` DROP CHECK `chk_sales_control_decision_shape`',
  'SELECT ''decision shape check absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

ALTER TABLE `salesControlRequests` ADD CONSTRAINT `chk_sales_control_decision_shape` CHECK ((
  (`status` = 'PENDING' AND `reviewedBy` IS NULL AND `reviewedAt` IS NULL AND `appliedAt` IS NULL)
  OR (`status` = 'APPROVED' AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NOT NULL)
  OR (`status` IN ('REJECTED','STALE','WITHDRAWN') AND `reviewedBy` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `appliedAt` IS NULL)
));
--> statement-breakpoint

-- ③ Maker-Checker: يبقى مُلزِماً حيث يعني شيئاً، ويُستثنى السحبُ وحده.
SET @has_mc := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'salesControlRequests'
    AND constraint_name = 'chk_sales_control_maker_checker'
);
SET @sql := IF(@has_mc > 0,
  'ALTER TABLE `salesControlRequests` DROP CHECK `chk_sales_control_maker_checker`',
  'SELECT ''maker checker check absent'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

ALTER TABLE `salesControlRequests` ADD CONSTRAINT `chk_sales_control_maker_checker` CHECK (
  `reviewedBy` IS NULL OR `status` = 'WITHDRAWN' OR `reviewedBy` <> `requestedBy`
);
