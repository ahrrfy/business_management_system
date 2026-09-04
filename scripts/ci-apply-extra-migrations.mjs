// مُطبِّق مُكمِّل لـCI: بَعد db:push يَكتب schema.ts، هذا السكريبت يُطبّق هَجرات يَدوية
// لا يَفهمها drizzle-kit (مَثلاً GENERATED ALWAYS AS ... STORED — D2 searchNorm).
//
// لماذا لا نَستعمل migrator API كاملاً: snapshot drizzle مُجمَّد عند 0019 ⇒ لو migrator
// يُطبّق من 0000 على قاعدة فارغة، snapshot القديم يَفقد بَعض الأعمدة التي أُضيفت في schema.ts
// بَعد التَجميد (٢٠/٦ قَرار). الحلّ: db:push يَكتب الجداول الحالية + هذا السكريبت يُضيف
// ما لا يُمكن تَمثيله في drizzle-kit (مَثل GENERATED columns).
//
// يَقرأ ملفات SQL مَحدَّدة، يُقسّمها على `--> statement-breakpoint`، ويُنفّذها بالتَرتيب.
// الهَجرات مَكتوبة idempotent (INFORMATION_SCHEMA checks) فآمنة للتَطبيق المُتَكرّر.

import "dotenv/config";
import { createConnection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// قائمة الهَجرات اليَدوية التي يُطبِّقها هذا السكريبت (بَعد db:push). تُضاف هُنا فقط
// الهَجرات التي drizzle-kit يَعجز عن تَمثيلها (GENERATED columns، FULLTEXT indexes، إلخ).
const EXTRA_MIGRATIONS = [
  "drizzle/migrations/0035_search_norm_products.sql",
  // 0036 يُضيف voucherCategories + أعمدة receipts. درizzle-kit يَفهم الجداول العادية لكن
  // مَيلُه إسقاط بَعض الـFK/UNIQUE صامتاً ⇒ نُكرّر التَطبيق هنا idempotently كَدفاع متعمّق.
  "drizzle/migrations/0036_vouchers_pro.sql",
  // 0039 توسعة D2: نفس نمط 0035 (GENERATED STORED) على customers.searchNorm/suppliers.searchNorm.
  "drizzle/migrations/0039_search_norm_customers_suppliers.sql",
  // gstack M6 (٧/٧/٢٦): قيود CHECK للـبكج/اللقطة/موجات الأسعار — drizzle-kit db:push لا يبنيها
  // موثوقاً على MySQL 8. snippet idempotent (يفحص INFORMATION_SCHEMA قبل ALTER).
  "drizzle/migrations/extras/0057_0060_bundle_check_constraints.sql",
  // ٨/٧/٢٦ (تشخيص فشل perf.explain على PR #163): db:push يترك invoices بلا فهارسها المُغطّية على
  // قواعد CI بعد تضخّم schema (المذكور في الذاكرة «db:push ينشئ جداول عارية عند فشله النصفي»).
  // الفهارس مطلوبة لحارس perf.explain وللأداء الفعلي. 0031/0032/0033 idempotent (INFORMATION_SCHEMA
  // checks) فآمنة للتَطبيق المتكرّر بعد db:push. الترتيب مهم: 0031→0032→0033 (0033 يُسقط بادئة كرَّرها 0032).
  "drizzle/migrations/0031_scale_composite_indexes.sql",
  "drizzle/migrations/0032_invoice_covering_indexes.sql",
  "drizzle/migrations/0033_drop_redundant_invoice_index.sql",
  // ٨/٧/٢٦: باركودات بديلة (aliases) — jedwal جانبيّ بـFK cascade على productUnits. `db:push`
  // على CI أنشأ الجدول بلا قيد FK فَسقط اختبار A3 (حذف الوحدة لم يُلقِ بدائلها) — إعادة تطبيق
  // idempotent لضمان القيود على CI. راجع ذاكرة «db:push ينشئ جداول عارية عند فشله النصفي».
  "drizzle/migrations/0062_product_unit_barcode_aliases.sql",
  // ١١/٧/٢٦: حقول متجر الجوال B2C (COD) على onlineOrders — أعمدة عادية + UNIQUE على عمود
  // غير-FK؛ نُعيد تطبيقها idempotently (INFORMATION_SCHEMA) لضمان وجودها على CI بعد db:push.
  "drizzle/migrations/0063_online_order_cod_fields.sql",
  // ١١/٧/٢٦: إدارة المتجر (لوحة hPanel) — جدولا storeBanners/storeSettings (بنرات + إعدادات).
  "drizzle/migrations/0064_store_banners.sql",
  "drizzle/migrations/0065_store_settings.sql",
  "drizzle/migrations/0066_store_free_shipping.sql",
  "drizzle/migrations/0067_online_order_delivery_party.sql",
  // ١٢/٧/٢٦: دور courier + ربط جهة التوصيل بحساب (deliveryParties.userId). enum ALTER + عمود/UNIQUE/FK
  // محروسة idempotently — نُعيد تطبيقها لضمان وجودها على CI بعد db:push (لا يُمثّل توسيع enum موثوقاً).
  "drizzle/migrations/0068_courier_role_and_party_user.sql",
  // ١٢/٧/٢٦: سبب إلغاء طلب المتجر (cancelReason) — «تعذّر التسليم» للمندوب. عمود عادي محروس idempotently.
  "drizzle/migrations/0069_online_order_cancel_reason.sql",
  "drizzle/migrations/0070_invoice_delivery_fee.sql",
  "drizzle/migrations/0071_category_store_fields.sql",
  "drizzle/migrations/0072_product_store_merchandising.sql",
  "drizzle/migrations/0073_promotion_store_managed.sql",
  // ١٣/٧/٢٦: موضع البنر (HERO/SIDE/INLINE) — enum بعمود جديد محروس idempotently.
  "drizzle/migrations/0074_banner_placement.sql",
  "drizzle/migrations/0076_banner_smart_rendering.sql",
  "drizzle/migrations/0077_store_conversion_metrics.sql",
  // ٢٣/٧/٢٦: نوع وردية PRINT_SERVICES — توسيع enum على shifts.shiftType. db:push لا يُمثّل توسيع
  // enum موثوقاً على قواعد CI الدائمة (نظير 0068). MODIFY idempotent (يُعيد ضبط العمود لنفس التعريف)
  // ⇒ آمن للتطبيق المتكرّر بعد db:push. يضمن وجود القيمة الثالثة قبل اختبارات فصل درج الطباعة.
  "drizzle/migrations/0105_shift_type_print_services.sql",
  // ملاحظة: شجرة الحسابات (P0، الهجرة 0115) لا تُبذَر هنا — اختبار chartOfAccounts.test.ts يبذُر
  // شجرته ذاتياً من CHART_ACCOUNTS (أمتنُ من بذرٍ عامّ عبر db:push، الذي أخفى خطأ INSERT صامتاً).
  // ٢٩/٧/٢٦: البطاقات الرقمية ش٤ — عمودان مولَّدان STORED + فهرسان فريدان على digitalPriceBatches
  // (مسودّة واحدة لكل فرع×مزوّد×تاريخ، ومنشورة واحدة سارية لكل فرع×مزوّد). drizzle-kit لا يُمثّل
  // GENERATED columns ⇒ يلزم تطبيقها هنا وإلا سقط حارسا التفرّد في الاختبارات وعلى CI.
  "drizzle/migrations/0127_digital_price_batch_uniqueness.sql",
  // ٢٩/٧/٢٦: البطاقات الرقمية ش٧ — providerId على بند النيّة + عمود refKey مولَّد + فهرس فريد
  // يمنع تكرار مرجع التنفيذ لدى المزوّد نفسه (نقرتان متزامنتان بنفس الرقم = كرتٌ يُسجَّل مرّتين).
  "drizzle/migrations/0128_digital_intent_reference_uniqueness.sql",
  // ٣٠/٧/٢٦: شطب النيّة العالقة — توسيع ثلاثة enums (entryType/intent.status/walletTx.type)
  // + أعمدة أثر الشطب. db:push لا يُمثّل توسيع enum موثوقاً (نظير 0068/0105) ⇒ يلزم تطبيقه
  // هنا وإلا سقطت اختبارات الشطب على CI بـ«Data truncated for column».
  "drizzle/migrations/0129_digital_intent_writeoff.sql",
  // ٣٠/٧/٢٦: تقليص enum — حذف `REVERSAL_PENDING` الميّتة من digitalSaleDetails.fulfillmentStatus.
  // نفس سبب 0129: db:push لا يُمثّل تغيّر enum موثوقاً. الملف يحمل حارس SIGNAL يُفشل الهجرة
  // إن وُجد صفٌّ يحمل القيمة بدل أن يُتلفه صامتاً بـ''.
  "drizzle/migrations/0131_drop_dead_reversal_pending.sql",
  // ٣٠/٧/٢٦: ردّ الخسارة باعتمادٍ ثانٍ — توسيع enum بحالة LOSS_REFUND_PENDING + أعمدة الأثر.
  "drizzle/migrations/0132_loss_refund_sod.sql",
  // ٣٠/٧/٢٦: priceSanity L1.8 — قيود CHECK على productVariants.costPrice و productUnits.conversionFactor.
  // drizzle-kit db:push على MySQL 8 لا يُمثّل CHECK constraints موثوقاً في كل الحالات ⇒ نطبّقه هنا
  // idempotently كدفاع نهائيّ ضدّ حادثة SINARLINE-class (تكلفة كارثيّة عبر الاستيراد/seed/db:push العاري).
  "drizzle/migrations/0133_price_sanity_ceilings.sql",
  // ٣٠/٧/٢٦: priceSanity L2.2 — جدول استثناءات لوحة تدقيق الكتالوج (catalogAnomalyOverrides).
  // drizzle-kit لا يُمثّله (لأنه ليس ضمن schema.ts؛ إبقاؤه هنا حرّاً من دورة drizzle-kit generate).
  "drizzle/migrations/0134_catalog_anomaly_overrides.sql",
  // ٣٠/٧/٢٦: priceSanity L3 — جدول أثر التغيّرات على التكلفة/السعر + Trigger BEFORE UPDATE.
  // drizzle-kit لا يُمثّل Triggers ⇒ يجب أن يُطبَّق يدوياً هنا. idempotent (DROP TRIGGER IF EXISTS).
  "drizzle/migrations/0135_price_anomaly_log.sql",
  // Keep CI's schema-pushed database on the same physical work-order payment
  // column as migration-built/production databases. The migration also repairs
  // a database carrying the accidental generic `paymentMethod` column name.
  "drizzle/migrations/0142_work_order_transfer_deposits.sql",
  // 06/08/2026: a raw SQL execution-lease table protects a digital card item
  // from being issued in two cashier windows. It intentionally stays outside
  // schema.ts while that shared file is owned by another coordinated slice.
  "drizzle/migrations/0154_digital_sale_execution_claims.sql",
  // 5/8 (0150): DELIVERY_FEE_HELD — drizzle-kit push la yuwassi' enum qa'iman.
  // ⚠ YAJIB an tabqa ba'd 0129: 0129_digital_intent_writeoff yu'id kitabat nafs
  //   al-'amud (MODIFY COLUMN entryType ENUM) bi-qa'ima aqdam, fa-ayy tartib qablahu
  //   yamhu al-qima SAMITAN (al-script yaqul tubbiqat wa-l-enum yarji' kama kan).
  "drizzle/migrations/extras/0150_delivery_fee_held_enum.sql",
  // 6/8 (0157): TELECOM 'ala receipts.paymentMethod — nafs qissat 0150 (push la
  // yuwassi' enum). 'amud mukhtalif 'an 0150/0129 lakin al-qa'ida wahida: al-akhir.
  "drizzle/migrations/extras/0157_receipt_payment_method_telecom.sql",
  // 10/8 (0169): SUPERSEDED 'ala invoices.invoiceStatus (tashih al-fatura) — nafs
  // qissat 0150/0157 (push la yuwassi' enum). yabqa akhir al-qa'ima.
  "drizzle/migrations/extras/0169_invoice_status_superseded.sql",
  // 12/8/2026: repair schema-push/baselined databases that missed the
  // reception delivery-disclosure columns and critical queue/payment indexes.
  "drizzle/migrations/0178_repair_reception_schema_drift.sql",
  // Delivery phase 2: physical/financial states, company memberships,
  // immutable allocations, operational ledger, events and outbox. This runs
  // after the reception repair because it builds on those consignment fields.
  "drizzle/migrations/extras/0178_delivery_phase2_state_and_ledgers.sql",
  // 18/8/2026: db:push creates storeSettings but can miss the fulfillment
  // branch index/FK. Replay the idempotent migration before schema verification.
  "drizzle/migrations/0181_store_fulfillment_branch.sql",
  // 0185 المسار أ: عمود مولَّد STORED + فهرس فريد يمنع تكرار رقم السحب النقديّ لنفس الاتجاه
  //   (db:push لا يُنشئ الأعمدة المولَّدة ⇒ لولا هذا السطر لَمَرّ الاختبار خضراءَ زوراً في CI).
  "drizzle/migrations/0185_cash_drop_reference_uniqueness.sql",
  // 15/8/2026: db:push represents the month-close tables and CHECKs but cannot create triggers.
  // This idempotent repair keeps fresh CI/test databases identical to migration-built production.
  "drizzle/migrations/extras/0192_0197_month_close_triggers.sql",
  // ١٧/٨/٢٦: كتالوج فئات السندات. البذر بيانات لا بنية ⇒ `db:push` لا يُنتجه أبداً، فقاعدة
  // CI/الاختبار كانت تحصل على فئات 0036 (المطبَّقة أعلاه) **بلا حساب مقابل** فتُخالف الإنتاج.
  // 0202 idempotent (INSERT مشروط + UPDATE على NULL) ويجب أن تبقى بعد 0036 في الترتيب.
  "drizzle/migrations/0202_voucher_category_defaults.sql",
  // ١٧/٨/٢٦: فئات المصروفات المُدارة. الجدول يفهمه db:push، لكن **بذر الكتالوج والردم الرجعيّ
  // وقيد الـFK** بيانات/قيود لا يُنتجها push ⇒ قاعدة CI تبقى بلا فئةٍ واحدة وبلا فئةٍ احتياطية
  // لكل دلو، فيسقط حلّ الفئة في إنشاء المصروف. idempotent وآمن للتكرار.
  "drizzle/migrations/0203_managed_expense_categories.sql",
  // ١٨/٨/٢٦: db:push يمثل لقطة انتهاء حجز طلب المتجر وفهرسها لكنه لا يمثل BEFORE UPDATE trigger.
  // repair مستقل idempotent يستبدل final تحت pre-trigger ثم يزيل المؤقت، فيطابق قواعد CI/الاختبار
  // مسار migrator الحاكم في 0208 بلا نافذة حماية.
  "drizzle/migrations/extras/0208_online_order_reservation_guard.sql",
  // ٢٠/٨/٢٦: db:push قد يترك فهرس FK افتراضياً لمحفظة البطاقات الرقمية بدلاً من الاسم التعاقدي
  // idx_dwt_wallet؛ الإصلاح idempotent ويحافظ على فهرس قراءات المحفظة واختبار الحماية.
  "drizzle/migrations/extras/0212_repair_digital_wallet_index.sql",
  // ٢٠/٨/٢٦: موجة **التراجع** عن موجة تسعير. سببان لوجودها هنا لا في مسار migrator وحده:
  //   ١) `db:push` لا يوسّع enum موثوقاً على MySQL 8 (قيمة `REVERT`).
  //   ٢) والأهمّ: قيدا CHECK للموجات يُنشئهما `extras/0057_0060_bundle_check_constraints.sql`
  //      أعلاه **بصيغتهما القديمة** التي ترفض `changeValue = 0` ⇒ لولا هذا السطر لبَنت قاعدةُ
  //      CI/الاختبار القيدَ القديم فيسقط كل تراجعٍ بـER_CHECK_CONSTRAINT_VIOLATED بينما الإنتاج
  //      (مسار migrator) يعمل. **يجب أن يبقى بعد 0057_0060 في الترتيب.** idempotent وآمن للتكرار.
  "drizzle/migrations/0226_price_wave_revert.sql",
  // ٢٥/٨/٢٦: صور مستقلّة لكل بديل/متغيّر — يُبدّل مفتاحاً فريداً على `productImageJobs`
  // بمفتاحٍ مركَّبٍ يستعمل عموداً مولَّداً STORED (`variantScope = COALESCE(variantId, 0)`).
  // `db:push` لا يُمثّل GENERATED columns، فيبني الجدول بعمودٍ عاديّ نصّياً ⇒ صراعُ نمطٍ
  // بين المخطط والقيد الفريد. هذه الهجرة idempotent (تسقط المفتاح القديم بعد التحقّق
  // من وجوده، وتضيف العمود المولّد والمفتاح الجديد بحرّاس INFORMATION_SCHEMA).
  "drizzle/migrations/0268_studio_variant_scoped_jobs.sql",
  // ٢٦/٨/٢٦: توسيعُ الحملة — سياسة الصور (ONLY_MISSING/ANY_REGARDLESS) + تعدّد الفئات.
  // `db:push` لا يُوسّع enum موثوقاً على MySQL 8 (قيم `CATEGORIES`/`ANY_REGARDLESS`)،
  // فنُعيد التطبيق idempotently. الجدول الجانبيّ `productStudioCampaignCategories`
  // يُبنيه db:push من schema.ts؛ الهجرة تتحقّق من وجوده لا تُعيد إنشاءه.
  "drizzle/migrations/0269_studio_multi_category_and_any_policy.sql",
  // ٢٨/٨/٢٦: PAUSED للحملة (تجميدٌ ذكيّ) — نفس منطق ٠٢٦٩: db:push لا يُوسّع enum
  // موثوقاً على MySQL 8، فالقيمة الجديدة تلزم إعادةَ التطبيق يدوياً على قاعدة الاختبار
  // كي يمرّ `check:migrations` وتقبل الخدمة الانتقالات الجديدة.
  "drizzle/migrations/0283_add_paused_studio_campaign_status.sql",
  // ٣١/٨/٢٦: الحالة الصادقة RESOLVED_WITH_ADJUSTMENT توسّع enum المطابقة اليومية.
  // الملف idempotent: ALTER إلى التعريف نفسه آمن، والجدولان CREATE IF NOT EXISTS، لذا
  // يعيد تطبيق عقد enum على قاعدة db:push ويترك جداولها وقيودها القائمة بلا استبدال.
  "drizzle/migrations/0297_cash_variance_resolution.sql",
  // db:push لا ينشئ triggers؛ هذه المرآة تثبت أن رأس القضية وسجل أحداثها append-only فعلياً.
  "drizzle/migrations/extras/0297_cash_variance_append_only_triggers.sql",
  // ٣١/٨/٢٦: db:push ينشئ العمود والجدول لكنه لا ينشئ trigger نسخة أمر الشغل.
  // إعادة التطبيق idempotent وتضمن أن كل كاتب قديم أو جديد يرفع version مركزياً.
  "drizzle/migrations/0298_work_order_control_requests.sql",
  // ٣١/٨/٢٦: جداول نسخ التصميم/الاعتماد CREATE IF NOT EXISTS؛ يلزم تطبيقها أيضاً بعد db:push.
  "drizzle/migrations/0299_work_order_design_approvals.sql",
  // ٣١/٨/٢٦: مراجعات PO وطلبات الشراء؛ يعيد بناء trigger النسخة بعد db:push.
  "drizzle/migrations/0300_purchase_order_revisions_requisitions.sql",
  // ٣١/٨/٢٦: إذن الاستلام المستقل/GRNI وعكسه؛ يعيد trigger النسخة ويرحّل القيود القديمة بصدق.
  "drizzle/migrations/0301_goods_receipts_grni.sql",
  // ٣١/٨/٢٦: فاتورة المورد والمطابقة الثلاثية؛ يعيد trigger النسخة ويبني رؤوس LEGACY بلا رقم خارجي مختلق.
  "drizzle/migrations/0302_supplier_invoices_three_way_match.sql",
  // ٣١/٨/٢٦: مرتجعات الشراء الموثقة وعكسها؛ الأعمدة IF NOT EXISTS وtrigger النسخة صالحان بعد db:push.
  "drizzle/migrations/0303_purchase_return_governance.sql",
  // ٣١/٨/٢٦: تخصيصات سداد المورد والاستردادات؛ يعيد حارسي POSTED وtrigger نسخة الدفعة.
  "drizzle/migrations/0304_supplier_invoice_payment_allocations.sql",
  // ٣١/٨/٢٦: مصروفات الشراء EXPENSE-only؛ يعيد حارسي نوع الحساب ونسخة المستند.
  "drizzle/migrations/0305_purchase_ancillary_cost_allocations.sql",
  // ٣١/٨/٢٦: قضايا النزاهة؛ يعيد حارسي append-only لسجل الأحداث.
  "drizzle/migrations/0306_purchase_integrity_cases.sql",
  // ٣١/٨/٢٦: توسيع قناة إثبات الدفع وإتاحة عدة محاولات جزئية للفاتورة مع إيصال أحادي.
  "drizzle/migrations/0307_external_payment_collection_channels.sql",
  // ٣١/٨/٢٦: حارس خطة نشطة واحدة لكل فاتورة مرتبطة؛ legacy ACTIVE بلا invoiceId يبقى متوافقاً.
  "drizzle/migrations/0308_installment_invoice_active_guard.sql",
  // ٣١/٨/٢٦: يضمن trigger نسخة عهدة COD بعد db:push.
  "drizzle/migrations/0309_delivery_writeoff_control_requests.sql",
  // ٣١/٨/٢٦: يضمن trigger نسخة تشغيلات العمولات بعد db:push.
  "drizzle/migrations/0310_commission_branch_runs.sql",
  // ٣١/٨/٢٦: db:push ينشئ الجداول؛ هذه المرآة تعيد حراس الاستثناء اليومي append-only.
  "drizzle/migrations/extras/0314_missed_daily_count_exception_triggers.sql",
  // ٣١/٨/٢٦: db:push ينشئ حقول/جدول مراجعات فاتورة المورد؛ هذه المرآة تعيد حراس السجل append-only.
  "drizzle/migrations/extras/0315_supplier_invoice_draft_revision_triggers.sql",
  // قيود الحجم/MIME وحرّاس append-only لمستندات دليل فرق النقد لا يمثلها db:push بالكامل.
  "drizzle/migrations/0317_cash_variance_evidence.sql",
  // ١/٩/٢٦: تُعدّل CHECKين قائمَين على `salesControlRequests` (شكل القرار + Maker-Checker)
  // لتمثيل حالة WITHDRAWN. `db:push` يبني الصيغة القديمة من المخطّط فتسقط اختبارات السحب
  // على قاعدة CI بينما الإنتاج (migrator) سليم — نفس فخّ #675.
  "drizzle/migrations/0326_returns_withdraw_and_owner_override.sql",
  // ١/٩/٢٦: يوسّع enum قناة طابور الاسترداد بـRETURN. `db:push` يبنيه من المخطّط فتنشأ
  // الصيغة الجديدة على قاعدة الاختبار، لكن المرآة تُبقي المسارين متطابقين.
  "drizzle/migrations/0327_offline_recovery_return_channel.sql",
  // Run after 0128 so the reference owner, not each basket member, holds uniqueness.
  "drizzle/migrations/0332_digital_card_baskets.sql",
  // ٤/٩/٢٦: تُسقط ستّة قيود CHECK maker-checker قائمة (راجع رأس الملف) — إتمامُ قرار
  // المالك ٣/٩/٢٦ (PR #962) الذي طبّقته طبقة التطبيق فقط. `db:push` الطازج (test:db:init)
  // يبني الصيغة الصحيحة أصلاً من schema.ts بعد إزالة check()، لكن قاعدةً بها هذه القيود
  // مسبقاً (كإنتاج، أو دفعٍ تزايديّ لم يُعِد بناء الجدول) تبقى على الصيغة القديمة بصمتٍ —
  // نفس فخّ #675/0326.
  "drizzle/migrations/0333_owner_selfapproval_checkconstraints.sql",
  // ٤/٩/٢٦: تُسقط ثلاثة قيود CHECK maker-checker قائمة (توسيعُ قرار المالك ٣/٩/٢٦ على
  // مسارات حوكمة مشترياتٍ إضافية) — نفس فخّ #675/0326/0333.
  "drizzle/migrations/0334_purchases_owner_selfapproval_checkconstraints.sql",
];

// Production deploys may need one narrowly-scoped, idempotent repair without
// replaying the complete CI reconciliation bundle. The requested path must be
// a member of the audited allow-list above; arbitrary filesystem input is
// rejected.
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const requestedOnly = onlyArg?.slice("--only=".length);
if (process.argv.filter((arg) => arg.startsWith("--only=")).length > 1) {
  console.error("⛔ يُسمح بخيار --only واحد فقط.");
  process.exit(1);
}
if (requestedOnly && !EXTRA_MIGRATIONS.includes(requestedOnly)) {
  console.error(`⛔ الهجرة المطلوبة غير موجودة في القائمة المسموحة: ${requestedOnly}`);
  process.exit(1);
}
const migrationsToApply = requestedOnly ? [requestedOnly] : EXTRA_MIGRATIONS;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد.");
  process.exit(1);
}

// multipleStatements: true لأن الكَتلة الواحدة بَين breakpoints قد تَحتوي على عدّة أوامر
// (SET @var؛ PREPARE؛ EXECUTE؛ DEALLOCATE) — كلها تَستعمل مُتغيّر مُستخدم مُشترَك فيَجب
// تَنفيذها على نَفس الاتصال بَالتَتابع. هذا سكريبت إعداد لا يَستقبل مُدخلات مُستخدم،
// فلا خطر SQL injection من تَفعيل الخاصية.
const conn = await createConnection({ uri: url, multipleStatements: true });

try {
  for (const path of migrationsToApply) {
    const abs = resolve(path);
    const sql = await readFile(abs, "utf-8");
    // تَقسيم على الـbreakpoint الذي يَستعمله drizzle-kit (نفس النَمط للهَجرات اليَدوية).
    const stmts = sql.split(/-->\s*statement-breakpoint/g)
      .map((s) => s.trim())
      .filter(Boolean)
      // إزالة تَعليقات وحدها (لو سطر بَقي --... بدون SQL فعلي).
      .filter((s) => !s.split("\n").every((line) => line.trim().startsWith("--") || line.trim() === ""));
    console.log(`→ تَطبيق ${path} (${stmts.length} statement(s))…`);
    for (const stmt of stmts) {
      await conn.query(stmt);
    }
  }
  console.log("✓ كل الهَجرات الإضافية مُطبَّقة.");
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ فشلت هَجرة إضافية:", e?.message ?? e);
  if (e?.sqlMessage) console.error("   SQL:", e.sqlMessage);
  process.exit(1);
}
