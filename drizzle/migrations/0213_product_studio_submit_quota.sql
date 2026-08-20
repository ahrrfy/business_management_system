-- 0213 — سقف الإرسال اليوميّ لكل منفّذ في استوديو المنتجات.
--
-- `imageStudioUsageGuard` يحرس المزوّدين المدفوعين (remove.bg / Gemini) وحدهم. أمّا مسار
-- الإرسال المجّاني `submitCandidate` فكان إجراءً عادياً بلا أيّ سقف: كل نداء يكتب حتى
-- كائنَين (~٩٠٠ ك.ب لكلٍّ) معنونَين بمحتواهما — فلا يُستبدَل كائنٌ سابق أبداً — والكنس
-- معطَّلٌ افتراضياً (`R2_GC_MODE=audit`) فلا يُستردّ شيء. سقفه الوحيد كان محدّد المعدّل
-- العامّ للـIP، أي ما يقارب عشرة غيغابايت من حسابٍ واحد في النافذة، دائمةً.
--
-- العدّ بالبايتات لا بعدد النداءات وحده: الكلفة تخزينٌ لا استدعاء، ومنفّذٌ يرسل صوراً
-- كبيرة يستهلك أضعاف من يرسل صغيرة بالعدد نفسه.
--
-- إنشاءٌ محروس فقط: جدولٌ جديد، ولا مسّ لأيّ صفٍّ أو جدولٍ قائم.
SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `productStudioSubmitQuota` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `usageDate` DATE NOT NULL,
  `userId` INT NOT NULL,
  `submitCount` INT NOT NULL DEFAULT 0,
  `bytesWritten` BIGINT NOT NULL DEFAULT 0,
  `lastSubmittedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_pssq_user_day` (`usageDate`, `userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- المفتاح الأجنبيّ باسمٍ صريح قصير: التسمية التلقائية تتجاوز ٦٤ محرفاً على MySQL 8.4.
SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productStudioSubmitQuota' AND CONSTRAINT_NAME = 'fk_pssq_user'
    ),
    'SELECT 1',
    'ALTER TABLE `productStudioSubmitQuota` ADD CONSTRAINT `fk_pssq_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`)'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
