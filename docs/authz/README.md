# حزمة مخرجات ما قبل التنفيذ — إعادة هندسة الصلاحيات وحوكمة الوصول

> **مرجع الحوكمة:** [`docs/authorization-governance-redesign-v2-2026-07-29-ar.md`](../authorization-governance-redesign-v2-2026-07-29-ar.md) (AGP-002 v2.1)
> **الحالة:** مسودّة مقدَّمة للمراجعة والاعتماد — **لم يُغيَّر أي سلوك صلاحيات، ولم يُفعَّل `RBAC_CAPABILITIES`.**
> **التاريخ:** 29 يوليو 2026

## ما في هذه الحزمة

هذه الحزمة تستجيب لطلبين:

1. **مراجعة الوثيقة الحاكمة** ⇐ [`00-spec-review.md`](00-spec-review.md)
2. **مخرجات القسم 30 السبعة عشر** ⇐ الملفّات المرقّمة 01–17 أدناه.

| # | المخرَج (§30) | الملف | الحالة |
|---|---|---|---|
| — | مراجعة الوثيقة | [`00-spec-review.md`](00-spec-review.md) | ✅ مكتمل |
| 1 | Endpoint Inventory | [`01-endpoint-inventory.md`](01-endpoint-inventory.md) + [`endpoint-inventory.csv`](endpoint-inventory.csv) / [`.json`](endpoint-inventory.json) | ✅ **مولَّد آلياً** |
| 2 | Permission Catalog | [`02-permission-catalog.md`](02-permission-catalog.md) | 🟡 مسودّة تحتاج اعتماد ملاك المجالات |
| 3 | Authorization Contract | [`03-authorization-contract.md`](03-authorization-contract.md) | ✅ مكتمل |
| 4 | Conceptual ERD | [`04-conceptual-erd.md`](04-conceptual-erd.md) | ✅ مكتمل |
| 5 | Attribute Registry | [`05-attribute-registry.md`](05-attribute-registry.md) | ✅ مكتمل |
| 6 | Scope Catalog | [`06-scope-catalog.md`](06-scope-catalog.md) | ✅ مكتمل |
| 7 | Threat Model | [`07-threat-model.md`](07-threat-model.md) | ✅ مكتمل |
| 8 | SoD Matrix | [`08-sod-matrix.md`](08-sod-matrix.md) | 🟡 يحتاج اعتماد مالك المخاطر |
| 9 | Approval Separation Design | [`09-approval-separation.md`](09-approval-separation.md) | ✅ مكتمل |
| 10 | Legacy Mapping | [`10-legacy-mapping.md`](10-legacy-mapping.md) | ✅ مكتمل |
| 11 | Decision Trace Design | [`11-decision-trace-design.md`](11-decision-trace-design.md) | ✅ مكتمل |
| 12 | UI Wireframes | [`12-ui-wireframes.md`](12-ui-wireframes.md) | ✅ مكتمل |
| 13 | Test Traceability Matrix | [`13-test-traceability-matrix.md`](13-test-traceability-matrix.md) | ✅ مكتمل (مولَّد جزئياً) |
| 14 | Performance Budget | [`14-performance-budget.md`](14-performance-budget.md) | 🟡 يحتاج قياس أساس فعليّ |
| 15 | Rollout Plan | [`15-rollout-plan.md`](15-rollout-plan.md) | ✅ مكتمل |
| 16 | Rollback Runbook | [`16-rollback-runbook.md`](16-rollback-runbook.md) | ✅ مكتمل |
| 17 | Operational Runbook | [`17-operational-runbook.md`](17-operational-runbook.md) | ✅ مكتمل |

## الأداة

```bash
node scripts/authz-inventory.mjs
```

أداة **قراءة فقط** تمسح `server/` وتولّد `endpoint-inventory.csv/json` (الـCSV يشمل **كل** الأسطح:
tRPC + Express + المهام). لا تعدّل كوداً ولا سلوكاً.

الراية `--check` تجعلها حارساً: تفشل على أي نقطة **مستجدّة** خارج قاعدة الأساس تحمل
`WRITE_WITHOUT_MODULE_GATE` أو `RAW_ROLE_GATE` أو `ADMIN_ONLY` (كتابة) أو `PROCEDURE_UNKNOWN/UNRESOLVED`
— أي تمنع إعادة إدخال بوّابات اسم الدور والنقاط غير المسجَّلة (§07 T-12). قاعدة الأساس
(`authz-baseline.json`) تُغرّب الحالة القائمة وتُولَّد بـ`--write-baseline`. **لا تُربط بـCI قبل اعتماد
الكتالوج** (§30.2).

## الأرقام الحاكمة (لقطة 29 يوليو 2026)

| المقياس | القيمة |
|---|---|
| نقاط tRPC | **671** (337 mutation / 334 query) عبر 64 راوتراً في 72 ملفاً |
| مسارات Express | 15 مساراً تحت 10 نقاط تركيب `/api/*` |
| مهام مجدولة/دورية | 5 (2 cron + 3 setInterval) |
| الصلاحيات الذرية المقترحة | **561** عبر **28** مجالاً |
| نقاط بسلطة «اسم الدور» الخام | **58** |
| نقاط `adminProcedure` (سلطة مطلقة) | **72** |
| نقاط ببوّابة لامركزية (`.use` محلّي خارج `server/trpc.ts`) | **119** (18%) |
| نقاط بلا أي عزل فرع | **115** |
| نقاط كتابة بلا بوّابة وحدة | 23 (كلّها مصادقة/تمهيد هوية — انظر §01) |

## القيود المعروفة في الجرد الآلي

1. **تحليل نصّي لا AST.** يلتقط النمط السائد (`name: gate.query/mutation`) والبوّابات المحلّية،
   لكن لا يفكّ استدعاءات ديناميكية. §24.1 من الوثيقة تشترط حصر AST — يُنفَّذ في المرحلة 1 قبل
   إقفال بوابة الخروج، وهذا الجرد أساسٌ له لا بديلٌ عنه.
2. **الراوترات الفرعية المُعرَّفة كثوابت مستقلّة** تظهر بأسماء أوراقها بلا بادئة المسار الكامل
   (مثل `plansRouter` داخل `commissionsRouter`). المسار النهائي يُثبَّت عند اعتماد الكتالوج.
3. **الحساسية مشتقّة من اسم الفعل** (heuristic) — تصنيف الحساسية النهائي قرار مالك المجال (§31.1).
4. **الأثر الجانبي داخل الخدمات لم يُحصَر بعد**: نقطة قد تبدو قراءةً وتُصدِر واتساب/طباعة داخلياً.
   هذا بند صريح في المرحلة 1 ولم يُغلق هنا.
