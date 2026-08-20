-- صدق طريقة الدفع (بلاغ المالك ١٨/٨: «جميع الفواتير تظهر نقدية»).
--
-- الجذر: ثلاثة مواضع كانت تختلق «نقدي» لعمليةٍ لم يدخلها دينار — `?? "CASH"` في تثبيت
-- المسوّدة، وكائن دفعةٍ يُبنى دائماً ولو بصفر في سلّة الاستقبال، و`default("CASH")` على
-- عمود أمر الشغل. الشيفرة أُصلحت؛ وهذه الهجرة تصحّح **الصفوف الكاذبة القائمة** وتزيل
-- الافتراضي كي لا يعود الاختلاق من طبقة القاعدة.
--
-- الحارس الحاكم: لا يُمسّ صفٌّ له **إيصال قبضٍ حقيقيّ**. فاتورةٌ قُبضت ثم استُردّت تحتفظ
-- بإيصالاتها فتبقى طريقتها كما هي — نصحّح كذبةً ولا نمحو تاريخاً.
-- تقارير Z وتسوية الدرج لا تتأثر إطلاقاً: تُحسب من `receipts.cashBucket` لا من هذا العمود.
SET NAMES utf8mb4;
--> statement-breakpoint

-- (١) عمود أمر الشغل: NULL افتراضاً بدل CASH. مسار الإدراج صار يمرّر القيمة صراحةً دائماً،
-- فالافتراضي فخٌّ كامنٌ لا أكثر — وإزالته تجعل القاعدة تقول الحقيقة لو أُغفل العمود مستقبلاً.
ALTER TABLE `workOrders`
  MODIFY COLUMN `woPaymentMethod`
    ENUM('CASH', 'CARD', 'TRANSFER', 'WALLET', 'TELECOM') NULL DEFAULT NULL;
--> statement-breakpoint

-- (٢) أوامر الشغل بلا عربون: الطريقة تخصّ العربون، وبلا عربونٍ لا طريقة.
UPDATE `workOrders`
SET `woPaymentMethod` = NULL
WHERE `woPaymentMethod` IS NOT NULL
  AND CAST(COALESCE(`deposit`, '0') AS DECIMAL(15, 2)) = 0;
--> statement-breakpoint

-- (٣) الفواتير: طريقةٌ مختومة بلا مقبوضٍ ولا إيصال قبضٍ مكتمل = كذبة. تُصفَّر فتظهر
-- أخيراً تحت فلتر «آجل» (paymentMethod IS NULL) بدل «نقدي».
UPDATE `invoices` `i`
SET `i`.`paymentMethod` = NULL
WHERE `i`.`paymentMethod` IS NOT NULL
  AND CAST(COALESCE(`i`.`paidAmount`, '0') AS DECIMAL(15, 2)) = 0
  AND NOT EXISTS (
    SELECT 1 FROM `receipts` `r`
    WHERE `r`.`invoiceId` = `i`.`id`
      AND `r`.`direction` = 'IN'
      -- ⚠️ اسمُ العمود في القاعدة `receiptStatus` لا `status` (خاصيّةُ Drizzle تُخالف العمود).
      -- SQL الخامّ لا يمرّ بالـORM ⇒ `r`.`status` سقط على الإنتاج بـER_BAD_FIELD_ERROR.
      AND `r`.`receiptStatus` = 'COMPLETED'
  );
