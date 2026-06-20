-- 0019 (٢٠/٦/٢٦): اسم المستخدم كمعرّف دخول بديل للبريد (طلب المالك: «اما بريد او اسم مستخدم»).
-- عمود اختياري فريد على users. UNIQUE في MySQL يسمح بتعدّد NULL ⇒ يفرض التفرّد على القيم غير الـNULL
-- فقط (المستخدمون بلا اسم مستخدم يبقون صالحين). إضافة عمود + UNIQUE = INSTANT/سريعة بلا قفل طويل.
-- وجوبُ «بريد أو اسم مستخدم على الأقل» مفروض في طبقة الخدمة (createUser/updateUser) لا في DB.
ALTER TABLE `users` ADD `username` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_username_unique` UNIQUE(`username`);
