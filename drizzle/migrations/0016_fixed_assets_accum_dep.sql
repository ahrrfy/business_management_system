-- FI-02 (تدقيق ٢٠/٦): الإهلاك المتراكم المُرحَّل على الأصل — يَتتبّع computeDepreciation عبر
-- الترحيل الشهري (postMonthlyDepreciation). الميزانية تَقرأ NBV = purchaseValue − هذا العمود،
-- وقائمة الدخل تُدرج مصروف الإهلاك من قيود DEPR.
ALTER TABLE `fixedAssets` ADD `accumulatedDepreciation` decimal(15,2) DEFAULT '0' NOT NULL;
