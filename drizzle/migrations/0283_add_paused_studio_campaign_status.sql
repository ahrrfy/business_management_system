-- productStudioCampaigns.status: إضافةُ حالة `PAUSED` (تجميدٌ ذكيّ يحفظ الطابور).
--
-- الحاجة (المالك ٢٨/٨): «لا أستطيع إيقاف حملة» — قبلَ كانت الحالات الأربع (DRAFT/ACTIVE/
-- COMPLETED/CANCELLED) وحدها، فإيقافٌ مؤقّت غير ممكن. الإلغاء يجرّ الطابور، والإكمال
-- يقفل الحملة نهائياً — كلاهما لا يعبّر عن «توقّفٌ مؤقّت ثمّ استئناف».
--
-- الدلالة (اختِيرت مع المالك): **تجميد ذكيّ** —
--   • الحملة المُوقَفة تختفي من مسار المصوّر (claimFreshCampaignTask يفلتر status='ACTIVE'
--     ⇒ التصفية القائمة تكفي بلا تعديل).
--   • المهام المُسنَدة سلفاً تبقى قابلةً للإتمام والاعتماد (لا نطمس عمل بدأه موظف).
--   • الاستئناف بضغطةِ زرّ (PAUSED → ACTIVE) بلا فقد بيانات.
--
-- الانتقالات (يُنفَّذ الحرسُ في transitionStudioCampaign):
--   DRAFT     → ACTIVE | CANCELLED
--   ACTIVE    → PAUSED | COMPLETED | CANCELLED
--   PAUSED    → ACTIVE | COMPLETED | CANCELLED
--   COMPLETED نهائية · CANCELLED نهائية
--
-- التطبيق idempotent — قراءةُ COLUMN_TYPE من INFORMATION_SCHEMA قبل ALTER، فمن أُعيد
-- تطبيقُ الهجرة على قاعدةٍ حديثة يمرّ بلا خطأ.

SET @db := DATABASE();

SET @has_paused := (
  SELECT IF(
    LOCATE('PAUSED', COLUMN_TYPE) > 0,
    1, 0
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'productStudioCampaigns'
    AND COLUMN_NAME = 'status'
);

SET @sql := IF(
  @has_paused = 1,
  'SELECT ''productStudioCampaigns.status already has PAUSED''',
  'ALTER TABLE `productStudioCampaigns` MODIFY COLUMN `status` ENUM(''DRAFT'', ''ACTIVE'', ''PAUSED'', ''COMPLETED'', ''CANCELLED'') NOT NULL DEFAULT ''DRAFT'''
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
