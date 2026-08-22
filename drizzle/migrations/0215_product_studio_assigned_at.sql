-- 0215 — لحظة الإسناد: زمنُ الدورة يقيس العمل لا انتظار الطابور.
--
-- `medianCycleMinutes` يُحتسب `reviewedAt − createdAt`. وهذا صحيحٌ لمهمةٍ تُنشأ عند
-- تسليمها، وخاطئٌ تماماً لمهام الحملة: تُولَد بالآلاف في لحظةٍ واحدة ثمّ تنتظر أسابيع
-- قبل أن يستلمها أحد ⇒ أوّل مهمةٍ تُعتمَد بعد ثلاثة أسابيع تُبلّغ عن «دورة» بثلاثة
-- أسابيع، بينما العمل الفعليّ استغرق دقائق. المؤشّر يقيس عمرَ الطابور لا الإنتاجية.
--
-- العمود يُملأ من الآن فصاعداً عند كل إسناد. والصفوف القديمة تبقى `NULL` ويرجع
-- حسابها إلى `createdAt` كما كان — لا نخترع لها تاريخاً لم يُسجَّل.
--
-- إضافةٌ محروسة فقط: لا مسّ لأيّ صفٍّ قائم.
SET NAMES utf8mb4;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productImageJobs' AND COLUMN_NAME = 'assignedAt'
    ),
    'SELECT 1',
    'ALTER TABLE `productImageJobs` ADD COLUMN `assignedAt` TIMESTAMP NULL'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
