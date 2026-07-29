-- 0124: علامة مالك النظام (isOwner) — مرتبة فوق admin تتجاوز الاعتماد الثنائي.
ALTER TABLE `users` ADD COLUMN `isOwner` boolean NOT NULL DEFAULT false;
