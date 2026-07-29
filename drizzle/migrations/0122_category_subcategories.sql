-- أقسام فرعية داخل الفئة (٢٩/٧): عمود parentId ذاتي المرجع على categories، بلا قيد FK (نمط
-- accounts.parentId — تفادي علّة اسم قيد FK الذاتي التلقائي >٦٤ محرفاً على MySQL 8.4). عمق
-- مقيَّد بمستويين (فئة رئيسية ← فئة فرعية) يُفرض خدمياً في categoryService، لا في قاعدة البيانات.
ALTER TABLE `categories`
  ADD COLUMN `parentId` bigint NULL AFTER `showInStore`;
--> statement-breakpoint
CREATE INDEX `idx_category_parent` ON `categories` (`parentId`);
