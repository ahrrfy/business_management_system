-- 0120: العهدة الوسيطة (imprest — إصلاح Codex P1 على #377، قرار المالك ٢٨/٧/٢٦).
-- نوعا قيدٍ جديدان لحركتَي النقد treasury↔drawer (revenue=cost=0، تُستثنيان من الإيراد كسائر CASH_*):
--   • SHIFT_FLOAT_OUT  — عهدة افتتاح وردية: سحبٌ من الخزينة → درج الكاشير (openShift).
--   • TREASURY_FUNDING — تمويل الخزينة (رأس مال/رصيد افتتاحيّ): مصدر خارجيّ → الخزينة (fundTreasury).
-- إضافةٌ محضة لقيم enum (append-only، بلا backfill). القائمة كاملةٌ بكلّ القيم القائمة **بما فيها GIFT_OUT**
-- المُضاف في 0116_gifts (MODIFY يستبدل التعريف كاملاً ⇒ لو أُسقط GIFT_OUT لانكسرت قيود الهدايا).
-- ⚠️ اسم عمود enum = أوّل وسيط mysqlEnum (DB لا JS): entryType.
ALTER TABLE `accountingEntries`
  MODIFY COLUMN `entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN','DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_WRITEOFF','EXCHANGE_DEPOSIT','EXCHANGE_WITHDRAW','EXCHANGE_FX_BUY','EXCHANGE_SETTLE','EXCHANGE_FEE','EXCHANGE_FX_DIFF','GIFT_OUT','SHIFT_FLOAT_OUT','TREASURY_FUNDING') NOT NULL;
