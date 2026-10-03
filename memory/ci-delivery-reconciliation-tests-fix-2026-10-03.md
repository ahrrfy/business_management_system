# استعادة الحالة الخضراء للـ CI وحل تعارضات اختبارات تسوية إرساليات التوصيل (03-10-2026)

**التاريخ:** 03 أكتوبر / تشرين الأول 2026  
**الهدف:** استعادة الحالة الخضراء التامة (100% Green CI) على الفرع الرئيسي `main` بعد ظهور فشل في وظائف الاختبارات والتكامل.  
**الفرع:** `fix_card_subscription_payment` (PR #1371)  
**الالتزام المدموج في `main`:** `23a6afe6`  
**البروتوكولات المتبعة:** V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction, Atomic Merge & Publish.

---

## 1. التحقيق الجنائي وتحليل السبب الجذري (RCA)

عقب دمج الشحنات السابقة في `main`، أظهر تشغيل الـ CI على الفرع الرئيسي فشلاً في شريحتين من شرائح الاختبار (Test Shards 1 و 5) أدى لتعطل بوابة `check-test-build`:

1. **فشل الشريحة الأولى (`test-shard-1-of-8`):**
   - **السبب الجذري:** في الالتزام `5fca264f` (دمج `atomic_order_return_fix` مع `main`)، بقي وسم تعارض دمج غير محلول (`<<<<<<< HEAD`) في السطر 340 من ملف `server/services/__tests__/moneyTrailDelivery.test.ts`.
   - **الأثر:** حدوث خطأ نحوي قاتل أثناء تحويل الملف بواسطة esbuild/vite في Vitest، مما أدى لإسقاط الشريحة فوراً.

2. **فشل الشريحة الخامسة (`test-shard-5-of-8`):**
   - **السبب الجذري:** في اختبار `server/services/__tests__/deliveryReturnReconciliation.test.ts` (السطر 203)، وُضعت فرضيات غير مطابقة للسلوك المعماري للنظام:
     ```ts
     expect(cnAfter.parcelStatus).toBe("DELIVERED");
     expect(cnAfter.status).toBe("DELIVERED");
     expect(cnAfter.moneyStatus).toBe("SETTLED");
     ```
   - **الأثر والتحقق:** السلوك المحاسبي الحاكم المعتمد للنظام (والمثبت في `reverseUnremittedDeliveryConsignment` واختبار الأثر المالي `M10` في `moneyTrailDelivery.test.ts`) ينص على أنه عند إرجاع فاتورة طلب توصيل غير مورّدة (`remittanceId == null`)، تتحول حالة الإرسالية إلى `RETURNED` وحالة المال إلى `CANCELLED` لعكس عهدة التوصيل وتصفير ذمة المندوب وحماية صندوق الكاشير من الاسترداد الوهمي. لذلك أسفر الاختبار عن:
     `AssertionError: expected 'RETURNED' to be 'DELIVERED'`.

3. **الديون البرمجية والملفات المؤقتة:**
   - وجود سكربتات تشغيل مؤقتة متروكة في جذر المشروع (`fix_errors.mjs` و `resolve_conflict.cjs`).

---

## 2. المعالجة الهندسية الذرية (Implementation)

1. **حل تعارض الدمج في `server/services/__tests__/moneyTrailDelivery.test.ts`:**
   - إزالة علامات التعارض واعتماد استدعاء `returnConsignment` مع المعامل المطلوب `returnReason: "رفض العميل"`.
   - تأكيد أن الإرجاع من شاشة التوصيل يُرفض برسالة `الفاتورة أُرجع منها سلفاً` لمنع التكرار المزدوج للعكس المخزني.

2. **مواءمة فرضيات اختبار `server/services/__tests__/deliveryReturnReconciliation.test.ts`:**
   - تعديل التحقق ليتوافق مع السلوك الفعلي للنظام:
     ```ts
     expect(cnAfter.parcelStatus).toBe("RETURNED");
     expect(cnAfter.status).toBe("RETURNED");
     expect(cnAfter.moneyStatus).toBe("CANCELLED");
     expect(cnAfter.returnedAt).not.toBeNull();
     ```
   - تأكيد أن إجمالي تعرّض الـ COD المتبقي يُصفّر بالكامل (`summaryAfter.codOutstanding == 0`).

3. **حذف الملفات المؤقتة:**
   - حذف `fix_errors.mjs` و `resolve_conflict.cjs` نهائياً من المستودع.

---

## 3. التحقق والمطابقة (V.E.R.I.F.Y & CI Verification)

- **الفحص المحلي:**
  - `pnpm check`: اجتياز 100% بصفر أخطاء.
  - `pnpm check:guards`: اجتياز كافة الحراس الـ 38 بنجاح تام (حجم الصفحات، حوكمة الشاشات، سجل الأتمتة، المفردات، السلامة البصرية، وتعامد الجداول).
- **طلب السحب (PR #1371):**
  - فحص كافة الوظائف الـ 14 في GitHub Actions CI: **100% Green**.
  - دمج طلب السحب ذرّياً في `main` بالالتزام `23a6afe6`.
- **فحص ما بعد الدمج على `main` (Run 37073171951):**
  - اجتياز جميع المهام الـ 12 بنجاح تام (`scope`, `authz-guard`, `quality-build`, `test-shard-1..8`, `check-test-build`)، واستعادة الحالة الخضراء التامة للنظام.
