-- ai-image-studio (0104): مسار الذكاء الاصطناعي في «استوديو صور المنتجات» — إعادة تصميم صورة المنتج
-- كتصوير استوديو موحّد (خلفية بيضاء + إضاءة + ظلّ) من برومت جاهز، بحفظ الأصل. توليديّ (Gemini/أي
-- مزوّد) ⇒ يُخضَع لمراجعة/اعتماد بشريّ قبل الاستبدال والأصل يبقى دائماً. أعمدة جديدة على الـsingleton
-- imageStudioSettings؛ مستقلّ تماماً عن مسار remove.bg (لا تغيير سلوكيّ عليه). المفتاح مشفَّر
-- (AES-256-GCM عبر cryptoService). كلّها بقيم افتراضية ⇒ صفر أثر رجعيّ (AI معطَّل افتراضياً).
-- ⚠️ MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS — الإضافة صريحة (نمط 0090/0102).
ALTER TABLE `imageStudioSettings` ADD `aiEnabled` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `imageStudioSettings` ADD `aiProvider` varchar(20) NOT NULL DEFAULT 'GEMINI';--> statement-breakpoint
ALTER TABLE `imageStudioSettings` ADD `aiModel` varchar(80);--> statement-breakpoint
ALTER TABLE `imageStudioSettings` ADD `encryptedAiKey` text;--> statement-breakpoint
ALTER TABLE `imageStudioSettings` ADD `aiStudioPrompt` text;--> statement-breakpoint
ALTER TABLE `imageStudioSettings` ADD `aiLastVerifiedAt` timestamp;--> statement-breakpoint
ALTER TABLE `imageStudioSettings` ADD `aiLastError` varchar(500);
