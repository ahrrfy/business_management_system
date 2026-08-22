-- يفصل تسوية الشراء النقدي عن ذمة المورد في كل أوضاع الدفتر.
-- NULL يعني قيداً تاريخياً سبق هذا الفصل ويُعامل كـAP حفاظاً على قابلية اعتماد طلباته القائمة.
ALTER TABLE `accountingEntries`
  ADD COLUMN `purchaseLiabilityAccount` enum('AP','CASH_CLEARING') NULL
  AFTER `purchaseOrderId`;
