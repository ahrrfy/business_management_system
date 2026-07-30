-- 0132 — البطاقات الرقمية: ردّ الخسارة باعتمادٍ ثانٍ (SOD). قرار المالك ٣٠/٧/٢٦.
--
-- **لماذا:** `lossRefund` يعترف بخسارةٍ (الإيراد يزول والحصة تبقى تكلفةً على المكتبة) —
-- وهو ماديّاً من جنس شطب النيّة العالقة الذي قرّر المالك له اعتماداً ثنائياً. بقيّة
-- العمليات الحسّاسة في الوحدة تشترط مديرَين (تعديل المحفظة · الشطب · التغيير الكبير)،
-- فكان `lossRefund` الاستثناء الوحيد بفاعلٍ واحد. هذه الهجرة تُنهي ذلك الاستثناء.
--
-- **`approveReversal` يبقى بفاعلٍ واحد عمداً**: صافيه صفر (المزوّد أعاد الحصة) فلا خسارة
-- تُعتمَد، والزبون واقفٌ ينتظر استرداده.
--
-- ملاحظة: 0131 حذفت `REVERSAL_PENDING` لأنها كانت قيمةً **لا يكتبها أحد**. هذه الهجرة
-- تُعيد حالةً معلّقة باسمٍ أدقّ (`LOSS_REFUND_PENDING` — الردّ وحده مُعتمَد لا العكس)
-- **مع الكود الذي يكتبها ويقرأها**. القيمة تُضاف حين تُستعمَل لا قبلها.
--
-- توسيع enum لا يُمثّله drizzle-kit موثوقاً ⇒ مُدرَجة في ci-apply-extra-migrations.mjs.

ALTER TABLE `digitalSaleDetails`
  MODIFY COLUMN `fulfillmentStatus`
  ENUM('ISSUED','LOSS_REFUND_PENDING','REVERSED','LOSS_REFUND') NOT NULL DEFAULT 'ISSUED';
--> statement-breakpoint

-- أثر الطلب والاعتماد على البند نفسه (الحبيبة نفسها التي يُختار بها) — أساس فحص SOD.
SET @s := (SELECT IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleDetails'
           AND COLUMN_NAME = 'lossRefundRequestedBy'),
  'SELECT 1',
  'ALTER TABLE `digitalSaleDetails`
     ADD COLUMN `lossRefundRequestedBy` INT NULL,
     ADD COLUMN `lossRefundRequestedAt` TIMESTAMP NULL,
     ADD COLUMN `lossRefundReason` VARCHAR(300) NULL,
     ADD COLUMN `lossRefundApprovedBy` INT NULL,
     ADD COLUMN `lossRefundApprovedAt` TIMESTAMP NULL'
));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- مفتاحا الأثر (أسماء قصيرة صريحة — MySQL 8.4 يرفض ما تجاوز ٦٤ محرفاً).
SET @s := (SELECT IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleDetails'
           AND CONSTRAINT_NAME = 'fk_dsd_lr_req'),
  'SELECT 1',
  'ALTER TABLE `digitalSaleDetails`
     ADD CONSTRAINT `fk_dsd_lr_req` FOREIGN KEY (`lossRefundRequestedBy`) REFERENCES `users`(`id`),
     ADD CONSTRAINT `fk_dsd_lr_app` FOREIGN KEY (`lossRefundApprovedBy`) REFERENCES `users`(`id`)'
));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
