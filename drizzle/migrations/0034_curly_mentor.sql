-- توجيه الخدمة لكاشير خدمة العملاء (الاستقبال): خدمة طباعة مفعَّل عليها showInReception تَظهر
-- في الاستقبال وتُباع عبر createPrintSale (خصم مواد + COGS). ملاحظة: db:generate جوهَر هجرةً ضخمةً
-- مكرَّرة (snapshot متأخّر) فاستُبدِل المحتوى بعبارة ALTER الوحيدة الفعلية (نمط الهجرة اليدوية المعتمد).
ALTER TABLE `products` ADD `showInReception` boolean DEFAULT false NOT NULL;
