# أرشيف حملة المراجعة المعمارية متعددة المناظير والتحصين الهندسي الشامل (الموجات A–D) — 2026-10-26

- **طلبات الدمج المدموجة على `main`:** `PR #1566` (`7606f5191`) · `PR #1567` (`e7140376e`) · `PR #1568` (`e5b18b019`) · `PR #1571` (`aee336a83`) · `PR #1572` (`7c5aeb71f`) · `PR #1573` (`c45761425`) · `PR #1575` (`b6c888a03`) · `PR #1577` (`a29e1bd78`) — وتكامل الموجة C3 وفصل أنماط المتجر وهجرة `0406` في `PR #1574` (`eedf5e43f`) و`PR #1578` (`12eed0656`) و`PR #1579` (`df75c9851`).
- **الالتزام المنشور في الإنتاج على `main`:** `df75c98519fbb555bffddd04b3f6611ff70e770f`
- **إصدار الإنتاج المنشور ذرّياً:** `web-1793004317012-df75c98519fb` (`https://srv1548487.hstgr.cloud` و`https://alarabiya.online` — `264.1s`، `/healthz` `200 ok:true`، `verify-nginx-storefront-readiness.mjs` `OK` على المضيفَين)

---

## ١. الموجة A — الاعتمادية التشغيلية ونظافة المستودع ومطابقة CI

1. **فحص ثغرات حزم الإنتاج (`A1`):** التثبّت من خلوّ حزم الإنتاج من الثغرات العالية والحرجة عبر `pnpm audit --prod --audit-level high` (`0` ثغرات).
2. **معالجة انحراف مسارات CI وقائمة الاختبارات الوحدوية (`A4` — `PR #1566`، `7606f5191`):** مواءمة `.github/workflows/ci.yml` و`vitest.unit.config.ts` لإغلاق فجوات مسارات الاختبارات الوحدوية والتشغيل المتسق.
3. **تجربة استعادة فعلية لنسخة الإنتاج الاحتياطية (`A2` — `PR #1567`، `e7140376e`):** تنفيذ تمرين تعافٍ من الكوارث لملف نسخة إنتاجية (`178.9 MB`) على حاوية الاختبار المعزولة `erp-test-db` (`127.0.0.1:3310`) في `207s` مع التثبّت من استعادة `330` جدولاً وسلامة الترميز العربي في `5,285/5,285` اسماً، وتوثيق الأدلّة في [`docs/disaster-recovery.md`](disaster-recovery.md).
4. **عزل الأعمال غير الملتزمة وتحصين `.gitignore` (`A3` — `PR #1568`، `e5b18b019`):** أرشفة الملفات المحلية غير الملتزمة خارج الشجرة الجذرية وتحصين `.gitignore` لمنع تلوّث المستودع الأساسي.

---

## ٢. الموجة B — تسريع حزمة الاختبارات وحارس أنواع الاختبارات التنازلي

1. **إزالة ازدواجية الاختبارات الوحدوية وتقنين تفريغ الجداول (`B1 + B2` — `PR #1571`، `aee336a83`):**
   - استثناء ملفات `vitest.unit.config.ts` من شاردات قاعدة البيانات الثمانية عبر `VITEST_EXCLUDE_UNIT=1` في [`vitest.config.ts`](../vitest.config.ts) و`.github/workflows/ci.yml`.
   - تحويل مسح الجداول في [`server/services/__tests__/__setup__.ts`](../server/services/__tests__/__setup__.ts) إلى مسحٍ انتقائي للجداول غير الفارغة بدلاً من المسح الأعمى الشامل بعد كل ملف، مما خفّض أزمنة الشاردات من `14–18` دقيقة إلى `5m19s–11m49s`.
2. **حارس أنواع الاختبارات بمِسنَنةٍ تنازلية (`B3` — `PR #1575`، `b6c888a03`):**
   - استحداث [`tsconfig.test.json`](../tsconfig.test.json) و[`scripts/check-test-types.mjs`](../scripts/check-test-types.mjs) (`pnpm check:test-types`) لإغلاق فجوة استثناء `**/*.test.ts(x)` من `tsconfig.json`.
   - تثبيت خطّ الأساس التنازلي في [`scripts/test-typecheck-baseline.json`](../scripts/test-typecheck-baseline.json) عند `415` ملفاً قديماً بإجمالي `1,476` خطأ مجمّداً تحت `assertMonotonicDescent`، مع قفل كافة ملفات الاختبار الأخرى والجديدة عند `0` خطأ نوع، وتحديد سقف ذاكرة V8 (`--max-old-space-size=10240` مع `--incremental false` في التشغيل البارد على CI).

---

## ٣. الموجة C — عزل حزمة المتجر العام وتأمين النقل الأصيل في سوبر العربية

1. **عزل القشرة العامة للمتجر وحزمة PWA عن شجرة ERP (`C1` — `PR #1572`، `7c5aeb71f`، واستكمال فصل CSS ومسارات الدومين العام `C3` في `PR #1574` و`PR #1578`):**
   - فصل الإقلاع في [`client/src/BootstrapApp.tsx`](../client/src/BootstrapApp.tsx) و[`client/src/main.tsx`](../client/src/main.tsx) وتحميل `App.tsx` وأنماط ERP كسولاً لغير المسارات العامة، وتحديث [`vite.config.ts`](../vite.config.ts) و[`scripts/storefront-pwa-contract.mjs`](../scripts/storefront-pwa-contract.mjs) و[`client/src/lib/siteHosts.ts`](../client/src/lib/siteHosts.ts) (`SHARED_PATHS = ["/login", "/account"]`).
   - انخفضت حزمة الـ JS الساكنة للمتجر العام من `2,747.7 KB` إلى `1,270.3 KB` (`-53.8%` في `#1572`) وانخفض تخزين PWA المسبق في بناء الإنتاج المنشور إلى `42` مدخلاً بحجم `1,644.59 KiB` مقابل `3,971.5 KB` سابقاً.
2. **توجيه عمليات تطبيق سوبر العربية عبر الناقل الأصيل المثبَّت بـ SPKI (`C2` — `PR #1573`، `c45761425`):**
   - تمرير كافة استعلامات وطفرات [`expo/superapp-mobile/lib/operationsApi.ts`](../expo/superapp-mobile/lib/operationsApi.ts) عبر [`expo/superapp-mobile/lib/secureTransport.ts`](../expo/superapp-mobile/lib/secureTransport.ts) ووحدة `AlrueyaSecureTransport` المثبّتة للشهادات (`SPKI Pinning`).
   - إضافة `withOperationalReadUnlock` لقراءات الجلسة المقفلة حيوياً على Android، وصون شارة حالة أمر الشراء `SENT`، وتصحيح عرض أرصدة الوحدة الأساس ودقّة مبالغ الدينار العراقي.

---

## ٤. الموجة D — مشغّل الحرّاس المتوازي وحارس حدود الطبقات ومزامنة الحقائق المعمارية

في `PR #1577` (`a29e1bd78`):
1. **مزامنة وحراسة الحقائق المعمارية الحيّة (`D1` — [`scripts/sync-architecture-facts.mjs`](../scripts/sync-architecture-facts.mjs)، `pnpm check:arch-facts`):** اشتقاق الأرقام البنيوية الفعلية من الشيفرة (الصفحات، الراوترات، الخدمات، الجداول، الحرّاس، شاردات CI، ملفات الاختبار والاختبارات الوحدوية من `UNIT_TEST_FILES`) ومطابقتها آلياً مع `CLAUDE.md`.
2. **حارس حدود الطبقات عبر محلّل TypeScript AST (`D2` — [`scripts/check-layer-imports.mjs`](../scripts/check-layer-imports.mjs)، `pnpm check:layer-imports`):** منع استيراد `drizzle/*Schema` أو `server/db` وقت التشغيل في `server/routers/**` مع السماح بـ `import type` و`ImportTypeNode`، وتجميد خطّ الأساس التنازلي في [`scripts/layer-imports-baseline.json`](../scripts/layer-imports-baseline.json) عند `39` ملفاً قديماً (`69` استيراداً وقت التشغيل) وقفل كافة الراوترات النظيفة والجديدة عند `0`.
3. **التشغيل المتوازي المحكوم لـ 49 حارساً وتشديد مقياس الاحتكاك (`D3`):**
   - استحداث [`scripts/run-guards.mjs`](../scripts/run-guards.mjs) بجدولة LPT متوازية (`6` عمّال) وتحديث [`scripts/check-guards-registered.mjs`](../scripts/check-guards-registered.mjs) لربط الحرّاس الـ `49` بين `package.json` و`ci.yml`.
   - ترقية [`scripts/check-friction.mjs`](../scripts/check-friction.mjs) لفرض عدم ارتفاع خطّ الأساس الكلّي وحجب المحور `D5` (`--enforce-axes=D5`).

---

## ٥. التحقق النهائي والنشر الذري وسحب النسخة الاحتياطية

- **بوابات ما قبل النشر على `df75c9851`:** اجتياز `pnpm check` (`0` أخطاء)، و`pnpm check:guards` (`49/49` حارساً ناجحاً)، وتجربة تشغيل الهجرة `0406_storefront_w2_privacy_customization.sql` على مخطط يطابق الإنتاج عبر `scripts/migration-dry-run.mjs --from 0406` (`1/1`)، واخضرار `CI` (`Run 40264454272`) و`Security Audit` (`Run 40264454313`) على `main`.
- **النشر الإنتاجي الذري (`pnpm prod:deploy`):** اكتمل في `264.1s` على `srv1548487.hstgr.cloud` إلى الإصدار `web-1793004317012-df75c98519fb`، متضمناً النسخة الاحتياطية `erp-2026-10-26T08-45-22-578Z-b88eef59.sql.gpg` (`356,863.5 KB`) التي سُحبت خارجياً عبر `scripts/pull-vps-backup.ps1`، واجتياز `db:migrate:safe` و`db:verify` وبوابة استقرار `erp-hr-bridge` وفحص `/healthz` (`200 ok:true`) و`verify-nginx-storefront-readiness.mjs` (`categories=85 products=1 quote=ok`) على المضيفَين الداخلي والعام.
