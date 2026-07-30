-- 0131 — البطاقات الرقمية: حذف قيمة `REVERSAL_PENDING` الميّتة من `fulfillmentStatus`.
--
-- **لماذا:** القيمة عُرِّفت في 0126 من تصميمٍ أوّليّ كان العكس فيه باعتمادٍ ثنائيّ، لكن
-- التصميم المشحون (`reversalService`) جعل `approveReversal` و`lossRefund` نهائيتين — ولا
-- سطرَ واحد في المستودع يكتبها أو يقرأها. قيمةٌ في enum لا يكتبها أحد ليست حياديّة: تُوهم
-- قارئ المخطّط بحالةٍ لا وجود لها، وتجعل أيّ `switch` على الحالات ناقصاً بلا داعٍ.
--
-- **الحذف سلوكياً محايد**: لا كود يُنتجها ولا يستهلكها.
--
-- ⚠️ **حارس السلامة:** حذف قيمةٍ من enum يُحوّل الصفوف الحاملة لها إلى '' صامتاً. لذا
-- نُفشِل الهجرة صراحةً إن وُجد صفٌّ واحد يحملها بدل أن نُتلف بياناته. (الإنتاج فُحص عند
-- كتابة الهجرة: صفر صفوف في الجدول كلّه.)
--
-- توسيع/تقليص enum لا يُمثّله drizzle-kit موثوقاً ⇒ الملف مُدرَجٌ في
-- scripts/ci-apply-extra-migrations.mjs (نظير 0068 و0105 و0129).

SET @orphans := (
  SELECT COUNT(*) FROM `digitalSaleDetails` WHERE `fulfillmentStatus` = 'REVERSAL_PENDING'
);
--> statement-breakpoint

-- الإيقاف بقراءةٍ من جدولٍ اسمُه الرسالة، لا بـSIGNAL: الأخير **غير مدعوم داخل
-- PREPARE/EXECUTE** فيُفشل الهجرة برسالة بروتوكولٍ مبهمة بدل السبب الحقيقيّ.
-- هذا الشكل يُخرج «Table '…ABORT_0131_rows_still_carry_REVERSAL_PENDING' doesn't exist»
-- فيقرأ المشغّل السبب من الخطأ نفسه. عند صفر صفوف يصير 'SELECT 1' وتمرّ الهجرة.
SET @s := IF(@orphans > 0,
  'SELECT * FROM `ABORT_0131_rows_still_carry_REVERSAL_PENDING`',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

ALTER TABLE `digitalSaleDetails`
  MODIFY COLUMN `fulfillmentStatus` ENUM('ISSUED','REVERSED','LOSS_REFUND') NOT NULL DEFAULT 'ISSUED';
