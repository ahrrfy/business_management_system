-- 0027 (٢٤/٦/٢٦): تتبّع الكمية المُعادة للمخزون فعلاً على بنود الفاتورة (returnedRestockedBaseQuantity).
--
-- لِمَ: بعد إصلاح مرتجع البيع (لا يُعكَس COGS حين restock=false) صار دفتر P&L يُبقي تكلفة البضاعة
-- التالفة خسارةً صحيحةً. لكن التقارير التحليلية (المنتجات/الفئات/سجلّ المبيعات) كانت تطرح تكلفة
-- كلّ مرتجع من invoiceItems بصرف النظر عن restock ⇒ تخالف الدفتر للتالف (تُخفي خسارة التلف).
-- هذا العمود يميّز المُعاد للرفّ عن التالف، فتطرح التقارير تكلفة المُعاد فقط (مطابِقةً للدفتر).
-- returnService يزيده مع returnedBaseQuantity عند restock=true فقط.
--
-- التعبئة التاريخية: نضبطه = returnedBaseQuantity لكل الصفوف القائمة، كي تبقى أرقام التقارير
-- الماضية مطابِقةً تماماً لما كانت عليه (الدفتر التاريخي عكَس تكلفة كل المرتجعات أصلاً) — بلا
-- تغيير رجعيّ على فترات مُقفَلة. الفرق الجديد يسري فقط على المرتجعات التالفة اللاحقة.
--
-- DDL: ADD COLUMN بقيمة افتراضية (سريع) ثم UPDATE تعبئة (قد يطول قليلاً على جدول كبير).

ALTER TABLE `invoiceItems` ADD `returnedRestockedBaseQuantity` int NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `invoiceItems` SET `returnedRestockedBaseQuantity` = `returnedBaseQuantity`;
