-- 0021 (٢١/٦/٢٦): علاقة واحد-لواحد بين الموظف وحساب النظام (employees.userId → users.id).
-- الميزة الجديدة «إضافة موظف + إنشاء/ربط حساب»: حساب واحد لا يُربط بأكثر من موظف.
-- UNIQUE في MySQL يسمح بتعدّد NULL ⇒ موظفو «بلا حساب» (userId = NULL) غير متأثرين.
-- آمن بلا فحص مسبق: العمود لم يكن يُكتَب قبل هذه الميزة (كل الصفوف الحالية NULL ⇒ صفر تكرار).
ALTER TABLE `employees` ADD CONSTRAINT `uq_employee_user` UNIQUE (`userId`);
