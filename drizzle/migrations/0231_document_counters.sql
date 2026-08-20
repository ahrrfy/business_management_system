-- ترقيم تسلسليّ بسيط (طلب المالك ١٨/٨): «رقم الفاتورة أو الطلب كبير وصعب ويحتوي على الأحرف
-- والفواصل — أريد استبداله بأرقام صحيحة تسلسلية».
--
-- الحالي: `INV-{فرع}-{YYYYMMDD}-{تسلسل}` يُولَّد بمسح `LIKE 'prefix%'` ثم `MAX+1` — يُملى
-- هاتفياً بصعوبة، ويُكتب يدوياً بخطأ. وآليّة توليده نفسها هشّة: `FOR UPDATE` على مسحٍ لا
-- يقفل صفوفاً غير موجودة (تعليقٌ محفور في numbering.ts)، فأُضيف GET_LOCK ترقيعاً — وسبعةُ
-- مولّدات أخرى في المستودع بقيت بلا هذا القفل أصلاً.
--
-- البديل: **عدّاد ذرّيّ** واحد لكل نوع مستند. الحجز بـ`LAST_INSERT_ID` داخل
-- `INSERT … ON DUPLICATE KEY UPDATE` — عمليةٌ ذرّيّة واحدة بلا قفلٍ صريح ولا مسحٍ ولا سباق.
--
-- الأرقام التاريخية **لا تُمسّ**: تبقى بصيغتها وتبقى قابلة للبحث (البحث يطابق الصيغتين).
-- نطاقان متباعدان عمداً كي يُميَّز نوعُ المستند بالنظر: الفواتير من 10001، أوامر الشغل من 5001.
SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `documentCounters` (
  `counterKey` VARCHAR(64) NOT NULL,
  `lastValue` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`counterKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

-- بذر العدّادين ببداية النطاق ناقصَ واحد (أوّل حجزٍ يُنتج 10001 و5001).
INSERT INTO `documentCounters` (`counterKey`, `lastValue`) VALUES ('invoice', 10000)
  ON DUPLICATE KEY UPDATE `counterKey` = `counterKey`;
--> statement-breakpoint

INSERT INTO `documentCounters` (`counterKey`, `lastValue`) VALUES ('workOrder', 5000)
  ON DUPLICATE KEY UPDATE `counterKey` = `counterKey`;
