-- 0023 (٢٢/٦/٢٦): مُنتج خِدمي — products.isService boolean.
-- المُنتج الخِدمي لا يَتتبَّع مَخزوناً: البَيع يَتجاوز branchStock + inventoryMovements،
-- التَحويل بين الفُروع مَمنوع، الإيراد يَدخل كَالعَادة (SALE)، التَكلفة من productVariants.cost.
-- استعمال نَموذجي: «تَصميم لوغو»، «طِباعة A4 لَون»، «رَسم تَسليم»، «اشتراك خَدمة».
--
-- DEFAULT false ⇒ المُنتجات القَائمة تَبقى سِلَعاً مَلموسة بِلا تَأثير على سُلوكها.
-- INSTANT DDL في MySQL 8 (إضافة عَمود مَع DEFAULT scalar) ⇒ صِفر downtime على جَدول كَبير.

ALTER TABLE `products` ADD `isService` boolean NOT NULL DEFAULT false;
