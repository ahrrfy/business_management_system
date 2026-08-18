-- 0204 — إعادة تقييم تكلفة المخزون: المسار المحكوم البديل للتعديل اليدويّ المُغلق.
--
-- `productVariants.costPrice` مصدر الحقيقة الوحيد لتقييم المخزون في الميزانية (أصل المخزون =
-- SUM(quantity × costPrice)) ولتكلفة البضاعة المباعة. تعديلُه يدوياً على صنفٍ **له رصيد** كان
-- يحرّك الأصل ⇒ تتحرّك حقوق الملكية (الرصيد المُكمِّل) بلا سطرٍ مقابلٍ في قائمة الدخل ولا قيدٍ
-- في الدفتر ولا حارس فترة (تدقيق ٢٧/٧، البندان H3/H4). فأُغلق المسار اليدويّ فيلاً مغلقاً —
-- ولم يبقَ أيُّ طريقٍ لتصحيح تكلفةٍ خاطئة على صنفٍ قائم.
--
-- هذا الجدول هو الطريق: مستندٌ صريح (غرضٌ محاسبيّ + سببٌ مكتوب + لقطة كميّات) يعتمده مديرٌ
-- ثانٍ (فصل المهام)، ويُرحَّل عند الاعتماد قيدُ ADJUST بقيمة Δالتكلفة × الكمية **لكل فرعٍ** له
-- رصيد ⇒ يخضع تلقائياً لحارس إقفال الفترة داخل postEntry.
--
-- إنشاءٌ محروس فقط: لا مسّ لأيّ صفٍّ أو مبلغٍ أو قيدٍ قائم.
SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `costRevaluationRequests` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `variantId` BIGINT NOT NULL,
  `branchId` BIGINT NOT NULL,
  `oldCost` DECIMAL(15,2) NOT NULL,
  `newCost` DECIMAL(15,2) NOT NULL,
  `costRevaluationPurpose` ENUM('CORRECTION','IMPAIRMENT') NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `expectedQuantity` INT NOT NULL,
  `branchQuantities` JSON NULL,
  `expectedValueDelta` DECIMAL(15,2) NOT NULL,
  `costRevaluationStatus` ENUM('PENDING_APPROVAL','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING_APPROVAL',
  `createdBy` INT NOT NULL,
  `approvedBy` INT NULL,
  `approvedAt` TIMESTAMP NULL,
  `rejectionReason` VARCHAR(500) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_costreval_status` (`costRevaluationStatus`, `branchId`),
  KEY `idx_costreval_variant` (`variantId`),
  CONSTRAINT `fk_costreval_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants` (`id`),
  CONSTRAINT `fk_costreval_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_costreval_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_costreval_approver` FOREIGN KEY (`approvedBy`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
