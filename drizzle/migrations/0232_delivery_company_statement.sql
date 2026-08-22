-- كشف شركة التوصيل (إطار المالك نسخة ٢): «كشف الشركة هو الدليل الأساسيّ للشركات التي لا تملك
-- بوابة. بوابة المندوب اختيارية، والإثبات اليدويّ الاستثنائي يحتاج دليلاً وموافقة مدير».
--
-- العقدة التي يفكّها: التوريد يشترط `parcelStatus = DELIVERED` على كل سطر، وختمُ التسليم
-- حصريٌّ ببوّابة المندوب (`courierProcedure` + عضوية جهة نشطة). وأغلب جهات التوصيل كيانُ
-- بياناتٍ بلا حساب نظام ⇒ **لا سطر يمكن توريده لها أبداً**، فالمال يعلق بلا مخرج.
--
-- الكشف يجعل سطرَه هو الدليل: يقود إثبات التسليم والتحصيل والتوريد في **عملية واحدة غير
-- قابلة للتكرار** — ورقم الكشف الفريد لكل جهة هو مفتاح عدم التكرار الأعمالي: إعادة إدخال
-- نفس الكشف (أو ضعف الشبكة) لا تضاعف القيود.
--
-- الاستقطاعات (أجور التوصيل التي تحسمها الشركة من الحصيلة) **مصروف شركة مستقل** لا تخفيضُ
-- ذمّة عميل — مطابقةً لقرار المالك في الشحن/الكمرك: مصروفٌ يُعترف به لحظته ولا يمسّ ذمّة أحد.
SET NAMES utf8mb4;
--> statement-breakpoint

ALTER TABLE `deliveryRemittances`
  ADD COLUMN `companyStatementNumber` VARCHAR(64) NULL AFTER `remittanceNumber`,
  ADD COLUMN `statementDate` DATE NULL AFTER `companyStatementNumber`,
  ADD COLUMN `statementAttachmentUrl` TEXT NULL AFTER `statementDate`,
  ADD COLUMN `deductionsTotal` DECIMAL(15, 2) NOT NULL DEFAULT '0' AFTER `feesTotal`;
--> statement-breakpoint

-- مفتاح عدم التكرار الأعمالي: رقم الكشف فريدٌ **لكل جهة** (شركتان قد تستعملان نفس الترقيم).
-- NULL مسموحٌ بتعدّده في MySQL ⇒ التوريدات اليدوية بلا كشفٍ تبقى كما هي بلا قيد.
CREATE UNIQUE INDEX `uq_remittance_party_statement`
  ON `deliveryRemittances` (`partyId`, `companyStatementNumber`);
