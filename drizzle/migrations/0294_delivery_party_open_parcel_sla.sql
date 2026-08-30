-- deliveryParties.maxOpenParcelAgeDays — عمود قاعدة SLA على عمر الطرود المفتوحة (Slice DFP1، ٣٠/٨/٢٦).
--
-- الحاجة (بلاغ المالك ٣٠/٨): «مندوب لديه طرود منذ ٢١ يوماً بلا توريد، والنظام يقبل إسنادَ طرودٍ
-- جديدة عليه» — رقيبٌ صامت على السنّ يجب أن يوجد. كان `assertFloatLimitTx` يفحص سقف النقد فقط
-- (`floatLimit`) ولا يفحص عمر الطرود ⇒ جهةٌ تُراكم مالاً وبضاعةً بلا إعادة معالجةٍ لأسابيع.
--
-- القرار (المالك، مغلَق):
--   • حظر إسنادٍ جديد ثابت (server-side) إن كان لدى الجهة أيّ طرد أقدم من `maxOpenParcelAgeDays`
--     دون توريد (COD_REMITTED) أو تسويةٍ صريحة (COD_WRITTEN_OFF/COD_RELEASED).
--   • إشعار مدير — لا تجاوُز إداريّ. الجهة يجب أن تُصفّي القديم أوّلاً.
--   • القاعدة قابلة للتخصيص لكلّ جهة (٣ أيام لمناديب سريعي التسوية، ١٠ أيام لشركاتٍ ذات مواعيد
--     دوريّة). الافتراض ٧ أيام — يوافق الأسبوع التشغيليّ.
--
-- الشكل: عمود int NOT NULL DEFAULT 7 (بلا nullable — القيمة صريحة دائماً ولا «قيمة سحرية»).
-- التقييد: يجب أن يكون موجباً (>= 1) — قيمة 0 تعني «حظر أيّ طرد قديم» وهي تكوينٌ خاطئ يُنشئ
-- حظراً كاملاً مع أوّل طرد. حدّ 365 يمنع تجاوزاً عرضياً (كتابة 999 بدل 9).
--
-- التطبيق idempotent — يفحص وجود العمود قبل الإضافة.

SET @db := DATABASE();

-- ١) إضافة عمود `maxOpenParcelAgeDays` إن لم يوجد
SET @add_col := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db
        AND TABLE_NAME = 'deliveryParties'
        AND COLUMN_NAME = 'maxOpenParcelAgeDays'
    ),
    'SELECT ''maxOpenParcelAgeDays already present''',
    'ALTER TABLE `deliveryParties` ADD COLUMN `maxOpenParcelAgeDays` INT NOT NULL DEFAULT 7'
  )
);
PREPARE stmt FROM @add_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٢) قيدُ CHECK لضمان قيمة معقولة (1..365) — يحول دون إسنادات مستحيلة أو خطأ إدخالٍ عرضيّ
SET @has_check := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db
    AND CONSTRAINT_NAME = 'chk_delivery_party_max_age_range'
);

SET @add_check := IF(
  @has_check = 0,
  'ALTER TABLE `deliveryParties` ADD CONSTRAINT `chk_delivery_party_max_age_range` CHECK (`maxOpenParcelAgeDays` >= 1 AND `maxOpenParcelAgeDays` <= 365)',
  'SELECT ''chk_delivery_party_max_age_range already exists'''
);
PREPARE stmt FROM @add_check;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
