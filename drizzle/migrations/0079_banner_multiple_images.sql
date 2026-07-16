-- 0079: صور متعددة داخل البنر مع جدولة مستقلة لكل صورة.
ALTER TABLE `storeBanners` ADD COLUMN `images` JSON NULL AFTER `imageUrl`;
