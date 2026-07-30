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
tRPC + Express + المهام). لا تعدّل كوداً ولا سلوكاً. الانتهاك = raw-role / بلا بوّابة وحدة (قراءةً أو
كتابةً) / admin على كتابة (§07 T-12). `PROCEDURE_UNKNOWN` (انجراف جدول `PROCEDURES` اليدويّ) **يُبلَّغ
ولا يُفشِل**.

### الحارس في CI — **مقارنة قاعدة الدمج (merge-base)** ✅

الوظيفة المستقلّة `authz-guard` في `.github/workflows/ci.yml` (`node scripts/authz-guard-diff.mjs`،
Node فقط بلا قاعدة/تثبيت) هي الحارس الفعليّ على كل PR/push:

```bash
node scripts/authz-guard-diff.mjs        # BASE_REF افتراضياً origin/main
```

يمسح **شجرة الأساس** و**شجرة الـhead** ويفشل **فقط على انتهاكٍ يُدخِله الـPR** — بصمةٌ عددُها في head
أكبر منه في الأساس. **انتهاكاتُ `main` موجودةٌ في الأساس ⇒ لا تُحسَب**، فلا يفشل الحارس أبداً على انجراف
`main` (المشكلة التي أسقطت الحارس الساكن عند دمج `digitalCardsRouter`).

- **الأساس = `merge-base(HEAD, origin/<base>)`** لا رأس `origin/main` الحيّ — sha ثابتٌ يمثّل محتوى main
  الموجود في HEAD فعلاً، فلا سباق مع تقدّم main بين إنشاء مرجع الدمج والجلب (مراجعة review-module #5).
- **البصمة** مستقلّةٌ عن رقم السطر وتشمل `router.name.kind` + أعلام الانتهاك + **مجموعة الأدوار الممنوحة**
  + **بُعد الفرع** — فيُكشف خفضُ بوّابةٍ خشنة (manager→cashier، كلاهما `RAW_ROLE_GATE`) وإسقاطُ عزل الفرع،
  وهي أخطاءٌ لا تُغيّر العلَم وحده (مراجعة #1/#4). مقارنةُ **العدد** (multiset) تكشف المضاعفة على أيّ تصادم.
- **المستجدّ من `PROCEDURE_UNKNOWN`** يدخل الفرق أيضاً: إجراءٌ غير مسجَّلٍ يُدخِله الـPR (بوّابةٌ مخفيّة)
  يظهر مستجدّاً مقابل الأساس؛ آمنٌ هنا لأنّ unknowns الخاصّة بـmain في الأساس (مراجعة #2). الحارس الساكن
  يبقى يستبعدها تفادياً للانجراف.

لا أساسَ يُصان ولا `--write-baseline` في المسار المعتاد.

**مقصودٌ ومبرَّر؟** وثّق السبب في وصف الـPR — لا تحديثَ ملفٍّ مطلوب (الحارس يقارن ضدّ قاعدة الدمج حيّاً).

### الحارس الساكن — أداةٌ محلّية + سقوطٌ رشيق

`node scripts/authz-inventory.mjs --check` (و`pnpm check:authz`) يقارن ضدّ `authz-baseline.json`
الملتزَم — مفيدٌ محلّياً وسريعٌ، **ويُستعمَل تلقائياً بديلاً** إن تعذّر على حارس الدمج حلُّ مرجع الأساس
(بيئةٌ بلا `origin/main`). الأساس يُولَّد/يُوسَّع بـ`pnpm authz:baseline`.

## الأرقام الحاكمة (لقطة حيّة — يُعيد التوليدُ حسابَها من الكود الحاليّ)

> بعد **دمج `origin/main`** (البطاقات الرقمية `digital_cards` وغيرها) صار المسح يرى الشجرة الحاليّة.
> الأرقام أدناه من المسح **بعد الدمج**؛ التفاصيل النصّية في 01 هي تحليل لقطة المراجعة الأصلية (٦٧١
> نقطة) وعدّادات الأعلام فيها ثابتة لأن نقاط `digital_cards` بوّاباتٌ نظيفة. المصدر الحيّ: CSV/JSON.

| المقياس | القيمة |
|---|---|
| نقاط tRPC | **731** (367 mutation / 364 query) عبر 72 اسمَ راوتر في 73 ملفاً (مسح `server/routers/`) |
| مسارات Express | 15 مساراً تحت 10 نقاط تركيب `/api/*` |
| مهام مجدولة/دورية | 5 (2 cron + 3 setInterval) |
| الصلاحيات الذرية المقترحة | **597** عبر **29** مجالاً |
| نقاط بسلطة «اسم الدور» الخام | **58** |
| نقاط `adminProcedure` (سلطة مطلقة) | **72** |
| نقاط ببوّابة لامركزية (`.use` محلّي خارج `server/trpc.ts`) | **119** (18%) |
| نقاط بلا بُعد فرع في بوّابتها | **292** (منها 115 على `module-map`؛ الباقي admin/عامّة/كتالوج مشترك) |
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
