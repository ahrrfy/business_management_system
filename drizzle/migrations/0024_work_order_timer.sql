-- 0024 (٢٣/٦/٢٦): مؤقّت تَنفيذ أَوامر الشَغل — workStartedAt + workSeconds.
-- يَستبدل اشتقاق المؤقّت من auditLogs (workOrder.start → workOrder.markReady) بأَعمدة صَريحة.
-- المَبرّر: auditLogs قد يُنَظَّف، والاشتقاق يَحتاج timeline.useQuery منفصلة لكل أَمر مفتوح؛
-- الأَعمدة الصَريحة في workOrders.list ⇒ المؤقّت يَظهر بَلا طَلب إضافي ويُحفَظ مَهما حَدث للسجلّ.
--
-- workStartedAt: timestamp NULL ⇒ يُكتَب فَقط عند RECEIVED → IN_PROGRESS (startWorkOrder).
-- workSeconds: int NULL ⇒ يُحسَب عند IN_PROGRESS → READY (markWorkOrderReady) كـ
--   TIMESTAMPDIFF(SECOND, workStartedAt, NOW()). يُمَكِّن تَقارير زَمن التَنفيذ المُتوسّط.
--
-- لا backfill: الأَوامر القَديمة DELIVERED/CANCELLED تَبقى بِـNULL (لا مَعنى لمؤقّتها بأَثر رَجعي).
-- INSTANT DDL في MySQL 8 (إضافة عَمودَين NULLable) ⇒ صِفر downtime على جَدول كَبير.

ALTER TABLE `workOrders`
  ADD `workStartedAt` timestamp NULL,
  ADD `workSeconds` int NULL;
