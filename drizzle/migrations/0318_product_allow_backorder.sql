-- 0318 — «يُباع بالطلب» (backorder): بيعٌ قبل التوريد لصنفٍ مخزنيّ يُغذَّى لاحقاً.
--
-- الحالة (بلاغ المالك ٣١/٨): عملُ طباعةٍ يُباع للزبون ثمّ يُوفَّر — إمّا شراءً جاهزاً من مطبعة
-- أخرى (فاتورة شراء ترفع الرصيد وتسجّل المورّد وذمّته والتكلفة بـWAVG)، أو إنتاجاً داخلياً
-- بوصفة الصنف. الطريقان قائمان ويعملان؛ الناقص وحده كان السماح بالبيع **قبل** التغذية.
--
-- الرصيد السالب هنا عدّادُ التزام لا عطب: عدد الأعمال المُباعة ولم تُورَّد، ويعود صفراً بأوّل
-- شراءٍ أو إنتاج. ولذلك الإعفاء **دائم**: لا نافذةَ «وضع الافتتاح» ولا شرطَ `openedAt IS NULL`
-- (كلاهما ينكسر بعد أوّل استلامٍ يَسِم الصنف مُفتتَحاً، فيعود الرفض في الدورة الثانية).

ALTER TABLE `products` ADD COLUMN `allowBackorder` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX `idx_product_allow_backorder` ON `products` (`allowBackorder`);
--> statement-breakpoint
-- الخدمة/البكج بلا رصيد ذاتيّ ⇒ الوسم بلا معنى. والأمانة: سالبُها يُلفّق التزاماً لمودِعٍ
-- لم يُودِع بضاعةً (§٥-ج) ⇒ ممنوع بنيويّاً لا بالنيّة.
ALTER TABLE `products` ADD CONSTRAINT `chk_product_backorder_stocked_only` CHECK (`allowBackorder` = 0 OR (`isService` = 0 AND `isBundle` = 0 AND `isConsignment` = 0));
