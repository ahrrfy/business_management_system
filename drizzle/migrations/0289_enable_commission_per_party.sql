-- H2 (٢٩/٨/٢٦) — تفعيل استبدال الأجرة بالعمولة عند التسوية لكلّ جهةٍ على حدة.
--
-- بلاغ المالك: «راقب الأرقام أسبوعين ثم فعّل H2» — الشيفرة تُنشَر جاهزةً معطَّلةً افتراضياً؛
-- العمود `useCommissionForSettlement` مفتاحٌ opt-in لكلّ جهة، يفعّله المدير بعد المقارنة.
--
-- التأثيرُ حين يكون TRUE (بالتزامن مع قاعدة عمولةٍ فعّالة):
--   `postFeePayment` (في fees.ts) يبدّل قيد التسوية:
--     • كان: DR COURIER_PAYABLE = feeAmount, CR CASH = feeAmount (يُدفَع كامل الأجرة للمندوب)
--     • يصير: DR COURIER_PAYABLE = feeAmount, CR CASH = commissionAmount, CR DELIVERY_REVENUE = (fee − commission)
--   المندوب يستلم مبلغ العمولة (الأقلّ)، والمكتبة تعترف بالفارق إيراداً — قيدٌ متوازنٌ تماماً.
--
-- Safety:
--   - DEFAULT FALSE: كلُّ الجهات القائمة تحتفظ بسلوكها الحالي (لا انحرافَ ماليّ صامت).
--   - القيد يتفعّل فقط حين يتحقّق شرطان: (١) العلَم TRUE، (٢) للجهة قاعدةُ عمولةٍ فعّالة.
--   - إن كانت `commission > fee`: يُقصَر إلى fee (لا نُقيّد إيراداً سالباً — سيناريو خطأ ضبط).

ALTER TABLE `deliveryParties`
  ADD COLUMN `useCommissionForSettlement` BOOLEAN NOT NULL DEFAULT FALSE;
