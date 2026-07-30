-- 0130 — البطاقات الرقمية §٧.١: اعتماد ثانٍ عند «تغيير كبير» في حصة المزوّد.
--
-- قرار المالك (٣٠/٧/٢٦): عتبة التغيير الكبير = **٥٠٪**. أيّ بطاقة تتغيّر حصتها عن
-- السعر النافذ بنسبة ≥٥٠٪ تجعل نشر الدُفعة كلّها موقوفاً على اعتماد **مديرٍ آخر**
-- غير مُنشئ المسودّة. (شقّ «تحت الحدّ الأدنى» منفَّذٌ أشدّ: رفضٌ باتّ لا اعتماد.)
--
-- **لماذا عمودان على الدُفعة لا حالةٌ جديدة:** الدُفعة أصلاً `DRAFT` = «غير نافذة»،
-- فحالة `PENDING_APPROVAL` لا تُضيف معنى بل تُجبرنا على إعادة بناء العمودين المولَّدين
-- `draftKey`/`publishedKey` وفهرسيهما الفريدين (0127) — مخاطرةٌ بلا مقابل. الاعتماد
-- سِمةٌ على المسودّة، و`saveDraft` يمسحه عند أيّ تعديل ⇒ لا يُعتمَد شيءٌ ثمّ يُنشَر غيره.

SET @s := (SELECT IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches'
           AND COLUMN_NAME = 'bigChangeApprovedBy'),
  'SELECT 1',
  'ALTER TABLE `digitalPriceBatches`
     ADD COLUMN `bigChangeApprovedBy` INT NULL,
     ADD COLUMN `bigChangeApprovedAt` TIMESTAMP NULL'
));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @s := (SELECT IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalPriceBatches'
           AND CONSTRAINT_NAME = 'fk_dpbatch_bigchg_app'),
  'SELECT 1',
  'ALTER TABLE `digitalPriceBatches`
     ADD CONSTRAINT `fk_dpbatch_bigchg_app` FOREIGN KEY (`bigChangeApprovedBy`) REFERENCES `users`(`id`)'
));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
