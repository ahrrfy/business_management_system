-- ═══ قناةُ RETURN في طابور استرداد الأوفلاين (تدقيق ١/٩/٢٦) ═══
--
-- طابورُ الاسترداد يحمل «عمليةً موّلها الزبونُ نقداً على الجهاز ورفضها الخادمُ عند الترحيل،
-- فلم تدخل الدفتر ولا مكانَ لها فيه بعد». وبإضافة المرتجع الأوفلاينيّ صار في الطابور نوعٌ
-- **مُعاكسُ الاتجاه**: نقدٌ **خرج** للزبون لا دخل منه.
--
-- ولا يصحّ تصنيفُه `RETAIL`: الطابور يُعرَض للمدير بعنوان «مبيعاتٌ أوفلاينية مدفوعة»، فيقرأ
-- استردادَ مرتجعٍ بيعاً — وهو عينُ الكذب الذي فتح هذا التدقيق كلَّه («الشاشة تُقسم بغير ما
-- يقع»). القيمةُ الصريحة تجعل المدير يرى الاتجاه الحقيقيّ قبل أن يقرّر.
--
-- `db:push` يبني الـenum من `drizzle/schema.ts` فتنشأ الصيغةُ الجديدة على قاعدة الاختبار؛
-- والإنتاج يمرّ من هنا. القيدُ idempotent فيُعاد تنفيذه بلا ضرر.

SET @needs_return_channel := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'offlineRecoveryItems'
    AND column_name = 'recoveryChannel'
    AND column_type NOT LIKE '%RETURN%'
);
SET @sql := IF(@needs_return_channel = 1,
  'ALTER TABLE `offlineRecoveryItems` MODIFY COLUMN `recoveryChannel` ENUM(''RETAIL'',''PRINT'',''RECEPTION'',''RETURN'') NOT NULL DEFAULT ''RETAIL''',
  'SELECT ''offlineRecoveryItems.recoveryChannel already has RETURN'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
