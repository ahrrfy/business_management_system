-- 0129 — البطاقات الرقمية: شطب نيّةٍ عالقة باعتمادٍ ثنائيّ (SOD).
--
-- المشكلة: نيّةٌ صدر كرتها ولم تُثبَّت بفاتورة تبقى `NEEDS_REVIEW` أبداً، وحجزُ محفظتها
-- مجمَّدٌ بلا مسار إنهاء ⇒ الرصيد المتاح يتآكل بكل حالة، والمطابقة اليومية تُظهر فرقاً دائماً.
-- الحلّ (قرار المالك ٣٠/٧/٢٦): شطبٌ بطلبٍ واعتمادٍ من مديرٍ آخر — لا بفاعلٍ واحد.
--
-- الشطب اعترافٌ بخسارة: دفعنا حصة المزوّد ولم نقبض شيئاً. لذلك قيدُه **cost-only**
-- (revenue=0، cost=الحصة، profit=−الحصة) على نمط `DELIVERY_WRITEOFF` القائم — لا حركة أصلٍ
-- صفريّة كبقية قيود `DIGITAL_WALLET_*`.
--
-- idempotent: كل خطوة محروسة بـINFORMATION_SCHEMA أو صيغة MODIFY المتكرّرة الآمنة.
-- توسيع enum لا يُمثّله drizzle-kit موثوقاً على قواعد CI ⇒ الملف مُدرَجٌ في
-- scripts/ci-apply-extra-migrations.mjs (نظير 0068 و0105).

-- ① قيمة قيدٍ جديدة: شطب كرتٍ عالق (مصروفٌ بلا نقد).
ALTER TABLE `accountingEntries`
  MODIFY COLUMN `entryType` ENUM(
    'SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE',
    'WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN','DELIVERY_DISPATCH',
    'DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_WRITEOFF','EXCHANGE_DEPOSIT','EXCHANGE_WITHDRAW',
    'EXCHANGE_FX_BUY','EXCHANGE_SETTLE','EXCHANGE_FEE','EXCHANGE_FX_DIFF','GIFT_OUT',
    'SHIFT_FLOAT_OUT','TREASURY_FUNDING','DIGITAL_WALLET_DEPOSIT','DIGITAL_WALLET_WITHDRAWAL',
    'DIGITAL_WALLET_CONSUMPTION','DIGITAL_WALLET_REVERSAL','DIGITAL_WALLET_ADJUSTMENT',
    'DIGITAL_WRITEOFF'
  ) NOT NULL;
--> statement-breakpoint

-- ② حالتا الشطب على النيّة: طلبٌ معلّق ثمّ مشطوبة (كلتاهما نهائيتان للمسار).
ALTER TABLE `digitalSaleIntents`
  MODIFY COLUMN `status` ENUM(
    'PREPARED','EXECUTING','EXECUTED','FINALIZED','CANCELLED','EXPIRED','NEEDS_REVIEW',
    'WRITEOFF_PENDING','WRITTEN_OFF'
  ) NOT NULL DEFAULT 'PREPARED';
--> statement-breakpoint

-- ③ نوع حركة محفظة جديد: خصمُ الشطب (يخفض الرصيد فعلياً كما خفضه جهاز المزوّد).
ALTER TABLE `digitalWalletTransactions`
  MODIFY COLUMN `type` ENUM(
    'OPENING','DEPOSIT','SALE_CONSUMPTION','SALE_REVERSAL','WITHDRAWAL','ADJUSTMENT','WRITEOFF'
  ) NOT NULL;
--> statement-breakpoint

-- ④ أثر الطلب والاعتماد على النيّة (مَن طلب، ولماذا، ومَن اعتمد ومتى) — أساس فحص SOD.
SET @s := (SELECT IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntents'
           AND COLUMN_NAME = 'writeoffRequestedBy'),
  'SELECT 1',
  'ALTER TABLE `digitalSaleIntents`
     ADD COLUMN `writeoffRequestedBy` INT NULL,
     ADD COLUMN `writeoffRequestedAt` TIMESTAMP NULL,
     ADD COLUMN `writeoffReason` VARCHAR(300) NULL,
     ADD COLUMN `writeoffApprovedBy` INT NULL,
     ADD COLUMN `writeoffApprovedAt` TIMESTAMP NULL'
));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ⑤ مفتاحا الأثر إلى المستخدمين (أسماء قصيرة صريحة — MySQL 8.4 يرفض ما تجاوز ٦٤ محرفاً).
SET @s := (SELECT IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'digitalSaleIntents'
           AND CONSTRAINT_NAME = 'fk_dsi_woff_req'),
  'SELECT 1',
  'ALTER TABLE `digitalSaleIntents`
     ADD CONSTRAINT `fk_dsi_woff_req` FOREIGN KEY (`writeoffRequestedBy`) REFERENCES `users`(`id`),
     ADD CONSTRAINT `fk_dsi_woff_app` FOREIGN KEY (`writeoffApprovedBy`) REFERENCES `users`(`id`)'
));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
