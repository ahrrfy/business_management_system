-- الطلبات القديمة التي أنشأها موظف الاستقبال تبقى هي مصدر التفويض؛ لا ننسخ
-- فواتير ولا نعيد ترحيل قيود مالية. نمنح الدور القياسي قراءة فواتير طلباته فقط.
-- شرط المفتاح والفئة يمنع لمس أي دور مخصص آخر بالاسم ذاته.
UPDATE `roles`
SET `permissions` = JSON_SET(`permissions`, '$.sales', 'READ')
WHERE `key` = 'reception_clerk'
  AND `baseRole` = 'cashier'
  AND JSON_UNQUOTE(JSON_EXTRACT(`permissions`, '$.sales')) = 'NONE';
