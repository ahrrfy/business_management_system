-- 0087: «الافتتاح التدريجي» — نوع جلسة الجرد (١٨/٧).
-- NORMAL = جرد دوري بكامل قيوده المالية (قيدا عجز/زيادة + عتبات صنفية).
-- OPENING = «جرد افتتاحي»: يثبّت العدّ كرصيد افتتاحي (setStock بمرجع OPENING) بلا قيدَي عجز/زيادة
-- ويختم branchStock.openedAt — محصور بنافذة وضع الافتتاح، بمدير فأعلى، بتوقيعَين دائماً،
-- ويستبعد الأصناف المُفتتَحة (الافتتاح مرّة واحدة لكل صنف×فرع).
ALTER TABLE `stocktakeSessions` ADD COLUMN `sessionType` ENUM('NORMAL','OPENING') NOT NULL DEFAULT 'NORMAL' AFTER `scopeDetail`;
