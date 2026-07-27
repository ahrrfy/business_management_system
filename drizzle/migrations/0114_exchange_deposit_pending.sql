-- 0114: اعتماد ثانٍ (SOD، تدقيق ٢٥/٧) لإيداع الدولار المباشر لدى الصيرفة — حالة PENDING_APPROVAL جديدة.
-- ⚠️ اسم عمود enum = أوّل وسيط mysqlEnum (DB لا JS): exchangeTxnStatus (لا status) — راجع رأس 0037.
-- الإيداع الدولاري المباشر يُنشأ معلّقاً بلا رفع رصيد المحفظة/WAVG/قيد حتى يعتمده مديرٌ ثانٍ
-- (recomputeHouseFromLog يرشّح ACTIVE فيستثني المعلّق). لا backfill: العمليات القائمة تبقى ACTIVE.
ALTER TABLE `exchangeTransactions`
  MODIFY COLUMN `exchangeTxnStatus` enum('ACTIVE','REVERSED','PENDING_APPROVAL') NOT NULL DEFAULT 'ACTIVE';
