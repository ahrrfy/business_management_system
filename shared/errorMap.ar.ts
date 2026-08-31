// خريطة أخطاء عربية موحّدة — يستعملها errorFormatter في tRPC ليرى المستخدم رسالة مفهومة
// بدل رمز فنّي أو «Something went wrong». مشتركة بين الخادم والعميل.
//
// (١٥/٧/٢٦) ترقية تشخيصية بطلب المالك: الرسالة تسمّي «أين» (الحقل/الشاشة) و«ما» (القيمة
// المرفوضة) و«لماذا» (السبب) و«الإجراء» — بدل «هذا السجلّ موجود مسبقاً» العامة:
//   • ER_DUP_ENTRY: يفكّ اسم القيد الفريد عبر سجلّ UNIQUE_AR (كل قيود UNIQUE في المخطط)
//     ويستخرج القيمة المتصادمة من رسالة MySQL.
//   • ER_BAD_NULL_ERROR / ER_NO_REFERENCED_ROW_2 / ER_ROW_IS_REFERENCED_2: يسمّي
//     الحقل/الجدول المعنيّ بالعربية (COLUMN_AR / TABLE_AR).
//   • أخطاء تحقق zod (مدخلات الراوترات): تُترجم بأسماء الحقول بدل «طلب غير صالح» العامة.
// ⚠️ عند إضافة قيد UNIQUE جديد في drizzle/schema.ts أضِف مدخله هنا في UNIQUE_AR.

/** رموز أخطاء MySQL (mysql2) → رسالة عربية (المستوى الاحتياطي حين يتعذّر التفكيك الأدقّ). */
const MYSQL_AR: Record<string, string> = {
  ER_DUP_ENTRY: "هذا السجلّ موجود مسبقاً (قيمة مكرّرة).",
  ER_LOCK_WAIT_TIMEOUT: "العملية مشغولة الآن، أعد المحاولة بعد لحظات.",
  ER_LOCK_DEADLOCK: "تعارض مؤقّت في قاعدة البيانات، أعد المحاولة.",
  ER_NO_REFERENCED_ROW_2: "قيمة مرتبطة غير موجودة (تحقّق من الاختيار).",
  ER_ROW_IS_REFERENCED_2: "لا يمكن الحذف: السجلّ مستعمَل في مكان آخر.",
  ER_DATA_TOO_LONG: "قيمة أطول من المسموح.",
  ER_BAD_NULL_ERROR: "حقل مطلوب تُرك فارغاً.",
  ECONNREFUSED: "تعذّر الاتصال بقاعدة البيانات.",
  PROTOCOL_CONNECTION_LOST: "انقطع الاتصال بقاعدة البيانات، أعد المحاولة.",
  ETIMEDOUT: "انتهت مهلة الاتصال بقاعدة البيانات.",
};

/** أسماء عربية للأعمدة الشائعة — تُعرض في «الحقل …» (تكرار/فارغ/أطول من المسموح/zod). */
const COLUMN_AR: Record<string, string> = {
  url: "الصورة",
  sku: "SKU",
  name: "الاسم",
  barcode: "الباركود",
  phone: "الهاتف",
  phone2: "الهاتف ٢",
  phone3: "الهاتف ٣",
  whatsapp: "واتساب",
  email: "البريد الإلكتروني",
  address: "العنوان",
  city: "المدينة",
  district: "المنطقة",
  notes: "الملاحظات",
  description: "الوصف",
  caption: "وصف الصورة",
  legacyCode: "الرقم القديم",
  variantName: "اسم المتغيّر",
  unitName: "اسم الوحدة",
  title: "العنوان",
  customizationText: "نصّ التخصيص",
  payee: "جهة الصرف",
  referenceNumber: "الرقم المرجعي",
  // إضافات الترقية التشخيصية (تُستعمل أيضاً لمسارات zod وأخطاء FK):
  quantity: "الكمية",
  baseQuantity: "الكمية بالوحدة الأساس",
  price: "السعر",
  unitPrice: "سعر الوحدة",
  costPrice: "التكلفة",
  conversionFactor: "معامل التحويل",
  branchId: "الفرع",
  customerId: "العميل",
  supplierId: "المورّد",
  productId: "المنتج",
  variantId: "متغيّر المنتج",
  productUnitId: "وحدة المنتج",
  invoiceId: "الفاتورة",
  employeeId: "الموظف",
  userId: "المستخدم",
  categoryId: "الفئة",
  amount: "المبلغ",
  paidAmount: "المبلغ المدفوع",
  total: "الإجمالي",
  discount: "الخصم",
  taxRate: "نسبة الضريبة",
  exchangeRate: "سعر الصرف",
  creditLimit: "سقف الائتمان",
  openingBalance: "الرصيد الافتتاحي",
  period: "الفترة",
  date: "التاريخ",
  dueDate: "تاريخ الاستحقاق",
  password: "كلمة المرور",
  role: "الدور",
  code: "الرمز",
  username: "اسم المستخدم",
  nationalId: "الرقم الوطني",
  firstName: "الاسم الأول",
  lastName: "اللقب",
  fatherName: "اسم الأب",
  position: "المنصب",
  department: "القسم",
  salary: "الراتب",
  hireDate: "تاريخ التعيين",
  items: "البنود",
};

/** أسماء عربية للجداول — تُعرض في أخطاء المفاتيح الأجنبية (حذف/اختيار مرتبط). */
const TABLE_AR: Record<string, string> = {
  products: "المنتجات",
  productVariants: "متغيّرات المنتج",
  productUnits: "وحدات المنتج",
  productUnitBarcodes: "بدائل الباركود",
  productPrices: "أسعار المنتج",
  categories: "فئات المنتجات",
  customers: "العملاء",
  suppliers: "الموردون",
  invoices: "الفواتير",
  invoiceItems: "بنود الفواتير",
  receipts: "السندات",
  quotations: "عروض الأسعار",
  purchaseOrders: "أوامر الشراء",
  purchaseOrderItems: "بنود أوامر الشراء",
  workOrders: "أوامر الشغل",
  onlineOrders: "طلبات المتجر",
  stockMovements: "حركات المخزون",
  branchStock: "أرصدة المخزون",
  stockTransfers: "التحويلات المخزنية",
  branches: "الفروع",
  users: "المستخدمون",
  employees: "الموظفون",
  accountingEntries: "القيود المحاسبية",
  salesPromotions: "العروض والخصومات",
  bundles: "البكجات",
  fixedAssets: "الأصول الثابتة",
  recipes: "وصفات الإنتاج",
  payrollRuns: "مسيّرات الرواتب",
  commissionRuns: "تشغيلات العمولات",
  exchangeTransactions: "حركات الصيرفة",
  deliveryConsignments: "إرساليات التوصيل",
  deliveryRemittances: "حوالات التوصيل",
  stocktakeSessions: "جلسات الجرد",
};

/**
 * سجلّ القيود الفريدة (UNIQUE) في المخطط → تشخيص عربي كامل.
 * مدخلان: `{ field, entity, hint? }` لرسالة «قيمة مكرّرة في حقل …»، أو `{ msg }` لرسالة
 * أعمال كاملة جاهزة (للقيود الداخلية/المركّبة حيث «اسم الحقل» لا يفيد المستخدم).
 * الأسماء مأخوذة حرفياً من drizzle/migrations (هي ما يظهر في رسالة MySQL).
 */
type UniqueInfo = { field: string; entity: string; hint?: string } | { msg: string };
/** مُصدَّر للاختبار الحارس (errorMap.ar.test.ts) الذي يضمن تغطية كل قيود UNIQUE في الهجرات. */
export const UNIQUE_AR: Record<string, UniqueInfo> = {
  uq_custom_template_product: { msg: "قالب التخصيص لهذا المنتج موجود مسبقاً." },
  uq_custom_field_template_key: { msg: "مفتاح حقل التخصيص مستخدم مسبقاً داخل هذا القالب." },
  uq_prod_related_pair: { msg: "هذا المنتج مرتبط مسبقاً بهذا المنتج المكمل — عدّل العلاقة الموجودة بدل تكرارها." },
  uq_loyalty_program_customer: { msg: "حساب الولاء لهذا العميل في هذا البرنامج موجود مسبقاً." },
  uq_loyalty_order_earn: { msg: "نقاط الولاء لهذا الطلب مُنحت مسبقاً." },
  uq_storefront_push_token_hash: { msg: "هذا الجهاز مسجّل مسبقاً لإشعارات المتجر." },
  uq_storefront_push_delivery: { msg: "تم إنشاء تسليم هذه الحملة لهذا الجهاز مسبقاً." },
  uq_coupon_reservation_order: {
    msg: "هذا الطلب مرتبط بحجز قسيمة مسبقاً — حدّث الطلب ولا تعِد إنشاء الحجز.",
  },
  uq_online_order_guest_tracking_hash: {
    msg: "تعارض نادر عند إنشاء رمز تتبّع الضيف — أعد المحاولة لتوليد رمز جديد.",
  },
  uq_online_order_guest_tracking_public_id: {
    msg: "تعارض نادر عند إنشاء معرّف تتبّع الضيف — أعد المحاولة لتوليد معرّف جديد.",
  },
  uq_storefront_review_order_product: {
    msg: "أرسلتَ مراجعةً لهذا المنتج من هذا الطلب مسبقاً — عدّل المراجعة الموجودة بدلاً من إرسال أخرى.",
  },
  uq_storefront_wishlist_share_token: {
    msg: "تعارض نادر عند إنشاء رابط مشاركة قائمة الرغبات — أعد المحاولة لتوليد رابط جديد.",
  },
  uq_storefront_cart_share_token: {
    msg: "تعارض نادر عند إنشاء رابط مشاركة السلة — أعد المحاولة لتوليد رابط جديد.",
  },
  // ── موجات الأسعار (0226) ──
  // يُصاب حين يضغط مديران «تراجع» على الموجة نفسها في اللحظة ذاتها: الخدمة تفحص أوّلاً
  // وتردّ برسالةٍ واضحة، لكنّ السباق قد يبلغ القيدَ نفسه ⇒ هذه رسالتُه بدل خطأ MySQL خامّ.
  uq_wave_reverts: { msg: "سبق التراجع عن هذه الموجة — حدّث الصفحة لترى موجة التراجع المسجَّلة." },
  uq_image_studio_usage_daily_service: { msg: "سجلّ حصة خدمة الاستوديو لهذا اليوم موجود مسبقاً." },
  // 0268 (٢٥/٨): استُبدل `uq_pijob_product_active` بـ`uq_pijob_product_variant_active`
  // ليعزل كل (منتج، متغيّر). الرسالة أدناه غطّت العزل الجديد.
  uq_pijob_product_variant_active: {
    msg: "توجد مهمّةُ استوديو نشطةٌ لهذا البديل بالفعل — افتح المهمّة الحالية بدل إنشاء مهمّةٍ مكرّرة.",
  },
  uq_pssq_user_day: { msg: "سجلّ سقف إرسال الاستوديو لهذا الموظف اليوم موجود مسبقاً." },
  uq_pscp_campaign_product: { msg: "هذا المنتج مُدرَجٌ في نطاق الحملة بالفعل." },
  uq_psca_campaign_user: { msg: "هذا الموظف من مصوّري الحملة بالفعل." },
  uq_pscc_campaign_category: { msg: "هذه الفئة مُدرَجةٌ في نطاق الحملة بالفعل." },
  // ── الرواتب/الإقفال/الاستحقاقات (0185–0194) ──
  uq_payroll_obligation_source: { msg: "التزام الرواتب لهذا المصدر مسجّل مسبقاً." },
  uq_payroll_obligation_revision: { msg: "مراجعة التزام الرواتب مسجّلة مسبقاً." },
  uq_payroll_remittance_source: { msg: "طلب التحويل القانوني لهذا المصدر مسجّل مسبقاً." },
  uq_payroll_remittance_receipt: { msg: "هذا الإيصال مرتبط بتحويل قانوني آخر." },
  uq_payroll_accounting_event_source: { msg: "حدث الرواتب المحاسبي لهذا المصدر مسجّل مسبقاً." },
  uq_payroll_accounting_event_entry: { msg: "هذا القيد مرتبط بحدث رواتب آخر." },
  uq_payroll_allocation_source: { msg: "تخصيص الرواتب لهذا المصدر مسجّل مسبقاً." },
  uq_payroll_allocation_event: { msg: "حدث تخصيص الرواتب مسجّل مسبقاً." },
  uq_advsettle_source: { msg: "تسوية السلفة لهذا المصدر مسجّلة مسبقاً." },
  uq_payroll_event_reversal_once: { msg: "حدث الرواتب معكوس مسبقاً." },
  uq_payroll_allocation_reversal_once: { msg: "تخصيص الرواتب معكوس مسبقاً." },
  uq_period_close_revision: { msg: "مراجعة إقفال هذه الفترة مسجّلة مسبقاً." },
  uq_year_scope_revision: { msg: "مراجعة إقفال هذه السنة مسجّلة مسبقاً." },
  uq_month_close_certificate_number: { msg: "رقم شهادة الإقفال الشهري مستخدم مسبقاً." },
  uq_month_close_certificate_request: { msg: "طلب الإقفال مرتبط بشهادة أخرى." },
  uq_month_close_certificate_period: { msg: "شهادة مراجعة هذه الفترة مسجّلة مسبقاً." },
  uq_month_close_certificate_hash: { msg: "بصمة شهادة الإقفال مسجّلة مسبقاً." },
  uq_month_close_certificate_revision: { msg: "مراجعة شهادة الإقفال مسجّلة مسبقاً." },
  uq_month_close_event_key: { msg: "حدث الإقفال بهذا المفتاح مسجّل مسبقاً." },
  uq_month_close_event_hash: { msg: "بصمة حدث الإقفال مسجّلة مسبقاً." },
  uq_termadv_source: { msg: "استرداد السلفة في التسوية النهائية مسجّل مسبقاً." },
  uq_termadv_reversal: { msg: "استرداد سلفة التسوية النهائية معكوس مسبقاً." },
  uq_advsettle_reversal_once: { msg: "تسوية السلفة معكوسة مسبقاً." },
  uq_advrep_req_source: { msg: "طلب سداد السلفة لهذا المصدر مسجّل مسبقاً." },
  uq_advrep_req_external_ref: { msg: "مرجع سداد السلفة مستخدم مسبقاً." },
  uq_advrep_req_receipt: { msg: "إيصال سداد السلفة مرتبط بطلب آخر." },
  uq_advrep_req_entry: { msg: "قيد سداد السلفة مرتبط بطلب آخر." },
  uq_advrep_alloc_source: { msg: "تخصيص سداد السلفة لهذا المصدر مسجّل مسبقاً." },
  uq_advrep_alloc_reversal: { msg: "تخصيص سداد السلفة معكوس مسبقاً." },
  uq_asset_client_req: { msg: "طلب إنشاء الأصل مسجّل مسبقاً." },
  uq_maint_client_req: { msg: "طلب صيانة الأصل مسجّل مسبقاً." },
  uq_accrual_obligation_source: { msg: "التزام الاستحقاق لهذا المصدر مسجّل مسبقاً." },
  uq_accrual_obligation_request: { msg: "طلب إنشاء التزام الاستحقاق مسجّل مسبقاً." },
  uq_accrual_event_dedupe: { msg: "حدث الاستحقاق مسجّل مسبقاً." },
  uq_accrual_event_entry: { msg: "قيد الاستحقاق مرتبط بحدث آخر." },
  uq_accrual_correction_request: { msg: "طلب تصحيح الاستحقاق مسجّل مسبقاً." },
  uq_yerr_client_request: { msg: "طلب إعادة فتح السنة مسجّل مسبقاً." },
  uq_yerr_pending_snapshot: { msg: "يوجد طلب إعادة فتح معلّق لهذه اللقطة." },
  uq_yerr_reversal_entry: { msg: "قيد عكس إقفال السنة مستخدم مسبقاً." },
  uq_yerr_reopen_event: { msg: "حدث إعادة فتح السنة مسجّل مسبقاً." },
  // محاولات الدفع الخارجية (0183): المرجع أحادي الاستعمال عالمياً، والربط أحادي.
  uq_extpay_reference: { msg: "مرجع الدفع الخارجي مستخدَم في محاولة أخرى — لا يمكن تسجيل القبض مرتين." },
  uq_extpay_request: { msg: "طلب محاولة الدفع هذا سُجّل مسبقاً — أعد تحميل حالته ولا تنشئ محاولة ثانية." },
  uq_extpay_invoice: { msg: "هذه الفاتورة مرتبطة بمحاولة دفع خارجية أخرى بالفعل." },
  uq_extpay_receipt: { msg: "هذا الإيصال مرتبط بمحاولة دفع خارجية أخرى بالفعل." },
  uq_dsi_extpay_attempt: { msg: "محاولة دفع البطاقة مرتبطة بنيّة بيع رقمي أخرى بالفعل." },
  // ── استعادة كلمات المرور والسير الذاتية للمتقدمين (0174–0175) ──
  passwordResetTokens_lookupId_unique: {
    msg: "رمز استعادة كلمة المرور مسجّل مسبقاً — اطلب إصدار رمز جديد.",
  },
  passwordResetTokens_tokenHash_unique: {
    msg: "رمز استعادة كلمة المرور مكرّر داخلياً — اطلب إصدار رمز جديد.",
  },
  uq_jobApplicantCv_applicant: {
    msg: "يوجد ملف سيرة ذاتية محفوظ لهذا المتقدّم — استبدل الملف الحالي بدلاً من إضافة ملف ثانٍ.",
  },
  uq_jobApplicantCv_publicKey: {
    msg: "حدث تعارض نادر في معرّف ملف السيرة الذاتية — أعد رفع الملف.",
  },
  // ── عمليات العدّ غير المتصلة في الجرد (0162) ──
  uq_stkcountop_request: {
    msg: "طلب العدّ هذا مسجّل مسبقًا في جلسة الجرد — حدّث الشاشة لعرض النتيجة المحفوظة بدل إعادة إرساله.",
  },
  // ── الباركود المجهول في الجرد (0250) ──
  uq_stkunknown_request: {
    msg: "هذا المسح مسجّل مسبقًا في طابور الباركود المجهول لهذه الجلسة — لا حاجة لإعادة إرساله.",
  },
  // ── معالجة عمليات بيع البطاقات والاشتراكات (0161) ──
  uq_dsrr_intent: {
    msg: "توجد معالجة مسجلة لهذه العملية بالفعل — افتح المعالجة الحالية بدلاً من إنشاء معالجة مكررة.",
  },
  uq_dsrri_item: {
    msg: "نتيجة هذا البند مسجلة ضمن المعالجة بالفعل — عدّل السطر الموجود بدلاً من إضافته مرة ثانية.",
  },
  // ── إشعارات السوبر تطبيق الأصلية (0159–0160) ──
  nativePushDevices_tokenHash_unique: {
    msg: "رمز إشعارات هذا الجهاز مسجّل مسبقاً — أعد تفعيل الإشعارات من الجهاز نفسه.",
  },
  nativePushOutbox_eventKey_unique: {
    msg: "حدث الإشعار سبق إدراجه للتسليم — لم يُنشأ إرسال مكرّر.",
  },
  appNotificationOutbox_eventKey_unique: {
    msg: "نية إشعار التطبيق لهذا الحدث مسجّلة مسبقاً — ستُستكمل المحاولة القائمة دون تكرار.",
  },
  appNotifications_eventKey_unique: {
    msg: "هذا الإشعار سبق تسجيله — لم يُنشأ إشعار مكرّر.",
  },
  // ── سجلّ أحداث أمر الشغل (Slice 6 — 0278) ──
  workOrderEvents_eventKey_unique: {
    msg: "حدث دورة الحياة سبق تسجيله لهذا الأمر — إعادةُ محاولةٍ نظيفةٌ لا تُنشئ سطراً مكرّراً في الخطّ الزمنيّ.",
  },
  invoiceEvents_eventKey_unique: {
    msg: "حدث دورة حياة الفاتورة سبق تسجيله — إعادةُ محاولةٍ نظيفةٌ لا تُنشئ سطراً مكرّراً.",
  },
  // ── مناطق التوصيل + تسعيره (Slice 7 — 0279) ──
  deliveryZones_code_unique: {
    field: "رمز المنطقة",
    entity: "مناطق التوصيل",
    hint: "منطقة توصيل أخرى مسجّلة بنفس الرمز — اختر رمزاً مختلفاً أو حرِّر المنطقة القائمة.",
  },
  // ── مسوّدات محطة خدمة الزبائن (ش٢ — 0152) ──
  uq_draft_number: { field: "رقم المسوّدة", entity: "مسوّدات المحطة", hint: "تعارضٌ نادر في ترقيم المسوّدة — أعد المحاولة." },
  uq_draft_commit_request: { msg: "مفتاح تثبيت المسوّدة مستعمَل — أعد فتح المسوّدة وحاول ثانية." },
  uq_draft_committed_invoice: { msg: "هذه الفاتورة مربوطة بمسوّدةٍ أخرى مثبَّتة — لا يُعاد ربطها." },
  // ── عرابين المسوّدات (ش٤ — 0153) ──
  uq_orderpay_receipt: { msg: "هذا الإيصال مربوطٌ بعربونٍ آخر — لا يُعاد ربطه." },
  uq_orderpay_request: { msg: "طلب قبض/ردّ العربون هذا سبق تنفيذه — لم يُكرَّر، راجع سجلّ عرابين الطلب." },
  // ── شجرة الحسابات (الدفتر المزدوج) ──
  uq_account_code: { field: "رمز الحساب", entity: "شجرة الحسابات", hint: "رمز الحساب مستعمل لحسابٍ آخر — اختر رمزاً فريداً." },
  uq_account_system_role: { field: "الدور النظاميّ للحساب", entity: "شجرة الحسابات", hint: "هذا الدور النظاميّ مرتبطٌ بحسابٍ آخر — كل دورٍ نظاميّ لحسابٍ واحد فقط." },
  uq_journal_entry: { msg: "قيدٌ مزدوجٌ مكرّرٌ لنفس الحدث المالي — الحدث مُرحَّلٌ مسبقاً في دفتر القيود (حماية من الازدواج)." },
  uq_journal_source_key: { msg: "مصدر يومية الدفتر مسجّل مسبقاً — لم يُكرّر الرصيد الافتتاحي." },
  uq_stat_profile_key_version: { msg: "يوجد إصدار نظامي بنفس المفتاح ورقم الإصدار — افتح الإصدار الموجود أو اختر رقماً أعلى." },
  uq_stat_profile_active_guard: { msg: "أصبح إصدار نظامي آخر نافذاً أثناء الاعتماد — حدّث الصفحة وراجع الإصدار النافذ قبل إعادة المحاولة." },
  uq_stat_account_profile_code: { msg: "رمز الحساب النظامي مكرّر داخل الإصدار نفسه — لكل حساب في الإصدار رمز فريد." },
  uq_stat_mapping_internal: { msg: "الحساب التشغيلي مربوط مسبقاً داخل هذا الإصدار — عدّل الربط الموجود بدل إضافة ربط ثانٍ." },
  uq_month_close_pending: { msg: "يوجد طلب إقفالٍ معلَّقٌ لهذا الشهر — اعتمِده أو ارفُضه قبل تقديم طلبٍ جديد." },
  // ── الكتالوج ──
  productUnits_barcode_unique: {
    field: "الباركود",
    entity: "المنتجات / وحدات المنتج",
    hint: "الباركود مستعمل لسلعة/وحدة أخرى — امسحه في البحث العالمي لمعرفة السلعة الحاملة له، أو غيّره.",
  },
  uq_unit_barcode_alias: {
    field: "الباركود البديل",
    entity: "المنتجات / بدائل الباركود",
    hint: "الباركود مستعمل (أساسياً أو بديلاً) لسلعة أخرى — امسحه في البحث العالمي لمعرفة صاحبه، أو غيّره.",
  },
  uq_price_unit_tier: { msg: "لهذه الوحدة سعر مسجّل مسبقاً لنفس فئة التسعير — عدّل السعر الموجود بدل إضافة سطر جديد." },
  categories_name_unique: { field: "اسم الفئة", entity: "فئات المنتجات" },
  uq_recipe_name: { field: "اسم الوصفة", entity: "وصفات الإنتاج" },
  uq_bundle_component: { msg: "هذا المكوّن مُضاف مسبقاً لنفس البكج — عدّل كمية السطر الموجود بدل إضافته مرّة ثانية." },

  // ── تسعير الطباعة الرقمية ──
  uq_print_face_price: { msg: "لهذا المقاس والنمط سعر وجه مسجّل مسبقاً — عدّل السعر الموجود بدل إضافة سطر جديد." },

  // ── الأطراف (عملاء/موردون/صيرفة) ──
  uq_customer_legacy: { field: "الرقم القديم", entity: "العملاء", hint: "عميل آخر مسجّل بنفس الرقم القديم — ابحث به في شاشة العملاء." },
  uq_supplier_legacy: { field: "الرقم القديم", entity: "الموردون", hint: "مورّد آخر مسجّل بنفس الرقم القديم — ابحث به في شاشة الموردين." },
  uq_exchange_legacy: { field: "الرقم القديم", entity: "جهات الصيرفة" },
  uq_customer_client_request: { msg: "طلب إنشاء العميل نُفِّذ مسبقاً (حماية من التكرار) — ابحث عن العميل في القائمة بدل إعادة الإرسال." },
  uq_supplier_client_request: { msg: "طلب إنشاء المورّد نُفِّذ مسبقاً (حماية من التكرار) — ابحث عن المورّد في القائمة بدل إعادة الإرسال." },
  // بضاعة الأمانة (ش٢، هجرة 0092):
  uq_consign_note_number: { field: "رقم السند", entity: "سندات الأمانة", hint: "سند أمانة آخر مسجّل بنفس الرقم — أعِد المحاولة (يُولَّد رقمٌ جديد)." },
  uq_consign_note_request: { msg: "طلب إنشاء سند الأمانة نُفِّذ مسبقاً (حماية من التكرار) — ابحث عن السند في القائمة بدل إعادة الإرسال." },
  // إعلانات الموظفين (هجرة 0180):
  uq_announcement_read: { msg: "سُجّلت قراءتك لهذا الإعلان مسبقاً — التكرار بلا أثر." },

  // ── المستخدمون والموظفون ──
  users_email_unique: { field: "البريد الإلكتروني", entity: "المستخدمون", hint: "مستخدم آخر مسجّل بنفس البريد — استعمل بريداً مختلفاً أو عدّل حساب المستخدم الموجود." },
  users_username_unique: { field: "اسم المستخدم", entity: "المستخدمون", hint: "اسم الدخول محجوز لمستخدم آخر — اختر اسماً مختلفاً." },
  users_openId_unique: { msg: "معرّف مستخدم داخلي مكرّر (خطأ داخلي) — أعد المحاولة، وإن تكرّر أبلغ الدعم." },
  roles_key_unique: { field: "رمز الدور", entity: "الأدوار المخصّصة" },
  employees_email_unique: { field: "البريد الإلكتروني", entity: "الموظفون" },
  uq_employee_national_id: { field: "الرقم الوطني", entity: "الموظفون", hint: "موظف آخر مسجّل بنفس الرقم الوطني — تحقّق من عدم تكرار الملف." },
  uq_employee_user: { msg: "حساب المستخدم مربوط بموظف آخر — لكل حساب دخول ملفُّ موظفٍ واحد؛ اختر حساباً آخر أو فكّ الربط القديم." },
  uq_delivery_party_user: { msg: "حساب المستخدم مربوط بمندوب توصيل آخر — اختر حساباً آخر أو فكّ الربط القديم." },
  uq_delivery_party_member: { msg: "هذا المستخدم عضو في جهة التوصيل نفسها مسبقاً — عدّل العضوية الموجودة بدل إضافتها من جديد." },
  uq_delivery_party_member_user: { msg: "حساب المستخدم مربوط بعضوية جهة توصيل أخرى — انقل العضوية أو عطّلها أولاً." },
  uq_att_employee_date: { msg: "سُجّل حضور لهذا الموظف في نفس اليوم مسبقاً — عدّل سجلّ الحضور الموجود بدل إضافة سجلّ جديد." },
  uq_fpdev_serial: { field: "الرقم التسلسلي", entity: "أجهزة الحضور", hint: "جهاز آخر مسجّل بنفس الرقم التسلسلي (SN) — لكل جهاز رقمٌ فريد." },
  uq_punch_sn_enroll_time: { msg: "هذه البصمة مستلَمة مسبقاً من الجهاز — تكرارها بلا أثر (الجهاز يعيد الدفع بعد الانقطاع)." },
  uq_hr_origin_sn_ip: { msg: "محاولة الاتصال من هذا العنوان مُسجَّلة مسبقاً لهذا الجهاز — يُرفَع عدّادها ولا يُنشأ صفٌّ جديد." },
  uq_devuser_device_enroll: { msg: "رقم المستخدم هذا مسجّل مسبقاً على الجهاز — عدّل ربطه بدل إضافته من جديد." },
  uq_devuser_device_employee: {
    msg: "هذا الموظف مربوط برقمٍ آخر على الجهاز نفسه — لكل موظف رقمٌ واحد لكل جهاز. افكك الربط القديم أولاً (رقمان لموظفٍ واحد يُنتجان يومَي حضور منفصلين ويُضاعفان ساعاته في الراتب).",
  },
  // ── priceSanity L2.2: استثناءات لوحة تدقيق شذوذ الكتالوج ──
  uq_anomaly_override: { msg: "هذا المتغيّر له استثناء مسجّل مسبقاً لنفس العدسة — عدّل الاستثناء الموجود بدل إضافة صفٍّ جديد." },

  // ── الفروع والتشغيل ──
  branches_code_unique: { field: "رمز الفرع", entity: "الفروع" },
  uq_shift_open_guard: { msg: "توجد وردية مفتوحة من نفس النوع لهذا الموظف على هذا الفرع — أغلق الوردية المفتوحة أولاً ثم افتح الجديدة." },
  uq_shift_funding_link_request: { msg: "طلب تمويل الوردية مرتبط بمصدر نقدي مسبقاً — حدّث القائمة ولا تُعد إرسال الطلب." },
  uq_shift_funding_link_active_source: { msg: "مصدر النقد المحدد محجوز أو استُهلك في طلب تمويل آخر — اختر مصدراً متاحاً." },
  uq_shift_funding_link_active_target: { msg: "توجد معاملة تمويل إضافي معلّقة لهذه الوردية — أكملها أو ألغها قبل إنشاء طلب جديد." },
  uq_kiosk_token_hash: { msg: "رمز الكشك مستعمل مسبقاً — ولّد رمزاً جديداً." },
  pushSubscriptions_endpoint_unique: { msg: "اشتراك الإشعارات مسجّل مسبقاً لهذا المتصفح — لا حاجة لإعادة التفعيل." },

  // ── الترقيم التسلسلي للمستندات (تصادم لحظي — الراوتر يعيد المحاولة تلقائياً) ──
  invoices_invoiceNumber_unique: { field: "رقم الفاتورة", entity: "الفواتير", hint: "تصادم ترقيم لحظي بين عمليتين متزامنتين — أعد المحاولة، وإن تكرّر أبلغ الدعم." },
  quotations_quoteNumber_unique: { field: "رقم عرض السعر", entity: "عروض الأسعار", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  receipts_voucherNumber_unique: { field: "رقم السند", entity: "السندات", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  purchaseOrders_poNumber_unique: { field: "رقم أمر الشراء", entity: "أوامر الشراء", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  purchaseReturns_returnNumber_unique: { field: "رقم مرتجع الشراء", entity: "مرتجعات الشراء", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  purchaseReturns_clientRequestId_unique: { msg: "طلب مرتجع الشراء هذا مسجّل مسبقاً — أعد تحميل المستند بدل تكرار العملية." },
  purchaseReturns_accountingEntryId_unique: { msg: "قيد مرتجع الشراء مرتبط بمستند مرتجع آخر — راجع المستند المسجّل." },
  uq_print_event_request_outcome: { msg: "نتيجة طلب الطباعة هذه مسجّلة مسبقاً — لم يُكرّر سجل التدقيق." },
  workOrders_orderNumber_unique: { field: "رقم أمر الشغل", entity: "أوامر الشغل", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  onlineOrders_orderNumber_unique: { field: "رقم طلب المتجر", entity: "طلبات المتجر", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  cashTransfers_transferNumber_unique: { field: "رقم التحويل النقدي", entity: "التحويلات النقدية", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  uq_transfer_number: { field: "رقم التحويل المخزني", entity: "التحويلات بين الفروع", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  exchangeTransactions_txnNumber_unique: { field: "رقم حركة الصيرفة", entity: "الصيرفة", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  deliveryRemittances_remittanceNumber_unique: { field: "رقم الحوالة", entity: "حوالات التوصيل", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  deliveryConsignments_consignmentNumber_unique: { field: "رقم الإرسالية", entity: "إرساليات التوصيل", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  uq_production_docnum: { field: "رقم مستند الإنتاج", entity: "الإنتاج", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  stocktakeSessions_code_unique: { field: "رمز جلسة الجرد", entity: "الجرد", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  fixedAssets_code_unique: { field: "رمز الأصل", entity: "الأصول الثابتة" },

  // ── حمايات التكرار الداخلية (idempotency) — «مكرّر» هنا يعني: العملية نُفِّذت فعلاً ──
  uq_invoice_source: { msg: "هذه العملية نُفِّذت مسبقاً (حماية من الازدواج) — تحقّق من وجود الفاتورة في القائمة بدل إعادة الإرسال." },
  uq_idempotency_op_key: { msg: "هذه العملية نُفِّذت مسبقاً (حماية من الازدواج) — تحقّق من نتيجتها في القوائم بدل إعادة الإرسال." },
  uq_online_order_client_req: { msg: "الطلب مُسجَّل مسبقاً (حماية من الازدواج) — لا حاجة لإعادة الإرسال." },
  // 0185 (المسار أ): تفرّد رقم السحب النقديّ لكل (رقم × اتجاه). اصطدامه يعني محاولة تسجيل
  // ساقٍ ثانية لسحبٍ قائم — لا خطأ إدخال، بل حمايةٌ من عهدةٍ مزدوجة.
  uq_receipt_cash_drop: {
    msg: "رقم السحب النقديّ مُسجَّل سلفاً بهذا الاتجاه — راجع سند السحب بدل إعادة تسجيله.",
  },
  uq_entry_dedupe: { msg: "قيد محاسبي مكرّر لنفس العملية — العملية مسجّلة مسبقاً في الدفتر (حماية من الازدواج)." },
  // 0186 (و-٤): العنصر المرفوض يُلتقط مرّةً واحدة مهما أعاد الجهاز المحاولة ⇒ الطابور يعكس
  // عدد العمليات لا عدد المحاولات. اصطدامه ليس خطأ مستخدم بل تأكيدُ أنّ الالتقاط تمّ سلفاً.
  uq_offline_recovery_request: {
    msg: "هذه العملية الأوفلاينية مُسجَّلة سلفاً في طابور الاسترداد — راجعها من تقرير المبيعات الأوفلاين.",
  },
  uq_stkcount_request: { msg: "طلب العدّ نُفِّذ مسبقاً (حماية من الازدواج) — لا حاجة لإعادة الإرسال." },

  // ── قيود «سجلّ واحد لكل …» المركّبة ──
  uq_stock_variant_branch: { msg: "رصيد هذا المتغيّر مهيّأ مسبقاً لهذا الفرع (خطأ داخلي في تهيئة الرصيد) — أبلغ الدعم." },
  uq_tline_transfer_variant: { msg: "المتغيّر مُدرَج مسبقاً في نفس التحويل — عدّل كمية السطر الموجود بدل إضافته مرّة ثانية." },
  uq_vbt_variant_branch: { msg: "لهذا المتغيّر عتبةٌ مخصّصة سلفاً لهذا الفرع — عدّل القيمة الموجودة بدل إنشاءِ صفٍّ ثانٍ (خطأ داخليّ في upsert؛ أبلغ الدعم)." },
  uq_valuation_period_scope: { msg: "لهذه الفترة لقطةُ تقييمٍ للنطاق نفسه مسجّلةٌ سلفاً — لقطةٌ واحدةٌ لكل (فترة × نطاق). إن أردت إعادة الالتقاط، ألغِ الإقفال (revision جديد) أوّلاً." },
  uq_stkitem_session_variant: { msg: "الصنف مُدرَج مسبقاً في نفس جلسة الجرد — عدّل السطر الموجود." },
  uq_stkdecision_session_variant: { msg: "قرار الجرد مسجّل مسبقاً لهذا الصنف في نفس الجلسة." },
  uq_wo_invoice: { msg: "لأمر الشغل هذا فاتورة صادرة مسبقاً — لا يمكن إصدار فاتورة ثانية لنفس الأمر." },
  uq_role_branch: { msg: "الفرع مُدرَج مسبقاً لهذا الدور (نطاق الفرع)." },
  uq_consignment_invoice: { msg: "لهذه الفاتورة إرسالية توصيل مسبقاً — راجع شاشة التوصيل." },
  uq_consignment_source: { msg: "لهذا الطلب إرسالية توصيل مسبقاً — راجع شاشة التوصيل بدل إنشاء إرسالية ثانية." },
  uq_delivery_remittance_line: { msg: "هذه الإرسالية مدرجة مسبقاً في سند التوريد نفسه — عدّل السطر الموجود." },
  uq_remittance_party_statement: { msg: "كشف الشركة بهذا الرقم مُسجَّلٌ سلفاً لهذه الجهة — راجع سند التوريد الصادر عنه بدل إدخاله مرّةً ثانية." },
  uq_delivery_ledger_event: { msg: "قيد حركة التوصيل لهذه العملية مسجّل مسبقاً (حماية من الازدواج)." },
  uq_delivery_event_key: { msg: "حدث التوصيل لهذه العملية مسجّل مسبقاً (حماية من الازدواج)." },
  uq_payroll_period: { msg: "يوجد مسيّر رواتب لنفس الفترة — افتح المسيّر الموجود أو احذفه (إن كان مسودة) قبل إنشاء جديد." },
  uq_target_emp_period: { msg: "للموظف هدف مسجّل لنفس الشهر — عدّل الهدف الموجود بدل إضافة جديد." },
  uq_commission_period: { msg: "توجد تشغيلة عمولات لنفس الفترة — راجع التشغيلة الموجودة." },
  uq_cline_run_emp: { msg: "سطر عمولة الموظف موجود مسبقاً في هذه التشغيلة (حماية من الازدواج)." },
  uq_ctier_plan_sort: { msg: "ترتيب الشريحة مكرّر داخل خطة العمولة — لكل شريحة ترتيب فريد." },
  uq_ctier_plan_threshold: { msg: "عتبة الشريحة مكرّرة داخل خطة العمولة — لكل شريحة عتبة مختلفة." },
  uq_contract_customer_unit: { msg: "يوجد سعر تعاقدي لنفس العميل ونفس الوحدة — عدّل السعر التعاقدي الموجود بدل إضافة جديد." },
  uq_conv_channel_handle: { msg: "توجد محادثة مفتوحة لنفس جهة الاتصال على هذه القناة — افتح المحادثة الموجودة." },
  uq_msg_external: { msg: "الرسالة الواردة مسجّلة مسبقاً (حماية من الازدواج)." },
  uq_int_branch_channel: { msg: "يوجد تكامل مفعّل لنفس القناة على هذا الفرع — عدّل التكامل الموجود بدل إضافة جديد." },
  // مركز واتساب الأعمال — نواة Cloud API (هجرة 0106):
  uq_wa_outbox_dedupe: { msg: "طلب إرسال واتساب مكرّر (حماية من الازدواج) — لا حاجة لإعادة الإرسال." },
  uq_wa_media_message: { msg: "وسائط هذه الرسالة محفوظة مسبقاً — لا حاجة لإعادة الجلب." },
  // نظام المهام الموحّد — الأساس (هجرة 0107):
  uq_task_number: { field: "رقم المهمة", entity: "المهام والتذاكر", hint: "مهمة أخرى مسجّلة بنفس الرقم — أعِد المحاولة (يُولَّد رقمٌ جديد)." },
  uq_service_type_name: { field: "اسم نوع الخدمة", entity: "أنواع الخدمة" },
  // قوالب Meta — مركز واتساب الأعمال (هجرة 0109):
  uq_wa_template_name_lang: { msg: "قالب واتساب بنفس الاسم واللغة موجود مسبقاً — المزامنة idempotent (تُحدِّث الموجود بدل التكرار)؛ إن ظهر هذا الخطأ فهو تعارض داخلي في المزامنة، أعد المحاولة." },
  // البث التسويقي — واتساب (هجرة 0110):
  uq_wa_broadcast_recipient: { msg: "هذا المستلم مُدرَج مسبقاً في نفس البثّ (حماية من الازدواج) — لا حاجة لإعادة الإدراج." },

  // ── الحجوزات (هجرة 0117) ──
  uq_reservation_number: { field: "رقم الحجز", entity: "الحجوزات", hint: "تصادم ترقيم لحظي بين عمليتين متزامنتين — أعد المحاولة." },
  uq_reservation_stock_variant_branch: { msg: "رصيد الحجز لهذا المتغيّر مهيّأ مسبقاً لهذا الفرع (خطأ داخلي في تهيئة المحجوز) — أبلغ الدعم." },

  // ── الهدايا/المجانيات (هجرة 0116) ──
  uq_gift_number: { field: "رقم سند الهدية", entity: "سندات الهدايا", hint: "تصادم ترقيم لحظيّ بين عمليتين متزامنتين — أعد المحاولة." },
  // ── حملات الهدايا (هجرة 0119) ──
  uq_gift_campaign_name: { field: "اسم الحملة", entity: "حملات الهدايا", hint: "حملة أخرى مسجّلة بنفس الاسم — اختر اسماً مختلفاً." },

  // ── السندات ──
  uq_vchcat_name: { field: "اسم الفئة", entity: "فئات السندات" },

  // ── فئات المصروفات المُدارة (هجرة 0203) ──
  // الخدمة تفحص الاسم مسبقاً برسالة ودّية، وهذا القيد هو الحارس الأخير: طلبان متزامنان
  // بنفس الاسم يمرّان الفحص معاً ويصطدم أحدهما بالقيد ⇒ يلزمه ترجمةٌ عربية لا خطأ خام.
  uq_expcat_name: {
    field: "اسم الفئة",
    entity: "فئات المصروفات",
    hint: "قد تكون الفئة موجودة معطّلة — فعّلها من «الخزينة ← فئات المصروفات» بدل إنشاء نسخة ثانية.",
  },

  // ── الكوبونات (هجرة 0078) ──
  uq_coupon_code: { field: "رمز الكوبون", entity: "الكوبونات", hint: "كوبون آخر يحمل نفس الرمز — ولّد رمزاً مختلفاً." },
  uq_coupon_hash: { msg: "رمز الكوبون مستعمل مسبقاً (تطابق البصمة) — ولّد رمزاً مختلفاً." },
  uq_coupon_redemption_invoice: { msg: "لهذه الفاتورة كوبون مستخدَم مسبقاً — كوبون واحد لكل فاتورة." },
  uq_coupon_redemption_coupon_invoice: { msg: "هذا الكوبون مستخدَم مسبقاً على نفس الفاتورة (حماية من الازدواج)." },

  // ── منصّة تعدّد الشركات (قاعدة التحكّم) ──
  uq_provision_active_code: { msg: "يوجد طلب توفير نشط أو شركة قائمة بنفس الرمز — اختر رمز شركة مختلفاً." },

  // ── البطاقات الرقمية والاشتراكات (هجرات 0126/0127/0128) ──
  // التعريفات (مزوّد/محفظة/بطاقة):
  uq_digital_provider_supplier: { msg: "هذا المورّد مُعرَّف مزوّداً رقمياً مسبقاً — لكل مورّد مزوّدٌ واحد. عدّل المزوّد القائم بدل إنشاء ثانٍ." },
  uq_wallet_provider_branch_code: { field: "رمز المحفظة", entity: "محافظ المزوّدين", hint: "محفظة أخرى لنفس المزوّد في نفس الفرع تحمل هذا الرمز — اختر رمزاً مختلفاً." },
  uq_doffering_variant: { msg: "متغيّر المنتج هذا مرتبطٌ ببطاقة رقمية أخرى — لكل بطاقة متغيّرها الخاص (خطأ داخلي في الإنشاء، أبلغ الدعم)." },
  uq_doffering_unit: { msg: "وحدة المنتج هذه مرتبطة ببطاقة رقمية أخرى — لكل بطاقة وحدتها الخاصة (خطأ داخلي في الإنشاء، أبلغ الدعم)." },

  // حركات المحفظة:
  uq_dwt_number: { field: "رقم حركة المحفظة", entity: "حركات المحافظ", hint: "تصادم ترقيم لحظيّ بين عمليتين متزامنتين — أعد المحاولة." },
  uq_dwt_wallet_client: { msg: "هذه الحركة مسجّلة مسبقاً على المحفظة (حماية من الازدواج عند النقر المتكرّر) — لا تُعِد الإرسال، راجع كشف الحساب." },
  uq_dwr_wallet_intent: { msg: "لهذه العملية حجزٌ قائم على المحفظة نفسها — الحجز يُنشأ مرّةً واحدة (خطأ داخلي، أعد المحاولة)." },
  uq_dwrecon_wallet_date: { msg: "لهذه المحفظة مطابقةٌ مسجّلة لنفس اليوم — المطابقة مرّةٌ واحدة لكل يوم عمل. راجع المطابقة القائمة أو اختر يوماً آخر." },

  // التسعير اليوميّ:
  uq_dpv_batch_offering: { msg: "لهذه البطاقة سعرٌ مُدخَل في نفس الدُفعة — لا يتكرّر السعر داخل الدُفعة الواحدة." },
  uq_dpbatch_draft: { msg: "توجد مسودّة أسعار مفتوحة لنفس الفرع والمزوّد وهذا اليوم — أكمِل المسودّة القائمة أو ألغِها بدل فتح ثانية." },
  uq_dpbatch_published: { msg: "توجد دُفعة أسعار منشورة سارية لنفس الفرع والمزوّد — النشر يُسوّد السابقة تلقائياً؛ إن ظهر هذا الخطأ فهو تعارضٌ لحظيّ بين نشرين متزامنين، أعد المحاولة." },

  // الطلاب:
  uq_student_customer: { msg: "هذا العميل له ملفّ طالب مسبقاً — لكل عميل ملفٌّ واحد. ابحث عن الملفّ القائم بدل إنشاء ثانٍ." },
  uq_student_phone: { field: "هاتف الطالب", entity: "ملفّات الطلاب", hint: "طالبٌ آخر مسجّل بنفس الهاتف — ابحث عنه واربط البيع بملفّه، ولا تُسجّل الإخوة بهاتفٍ واحد." },

  // نيّة البيع والتنفيذ الخارجيّ:
  uq_dsi_client_request: { msg: "هذه العملية مسجّلة مسبقاً (حماية من الازدواج عند النقر المتكرّر) — لا تُعِد الإرسال، راجع طابور العمليات." },
  uq_dsi_invoice: { msg: "هذه الفاتورة مرتبطة بعملية بيعٍ رقميّ أخرى — لا تُثبَّت الفاتورة مرّتين." },
  uq_dsii_intent_line: { msg: "هذا السطر مُدرَج مسبقاً في العملية نفسها (حماية من الازدواج) — راجع سطور السلة." },
  uq_dsii_provider_ref: { msg: "مرجع التنفيذ هذا مسجَّل مسبقاً لدى المزوّد نفسه — الكرت لا يُسجَّل مرّتين. تحقّق من الرقم أو راجع الكرت السابق." },
  uq_dsec_claim_token: { msg: "رمز قفل إصدار البطاقة مستخدم في مطالبة أخرى — أعد المحاولة لبدء إصدار آمن جديد." },
  uq_dsec_provider_idempotency_key: { msg: "مفتاح منع تكرار إصدار البطاقة مستخدم مسبقاً — راجع العملية القائمة ولا تُصدر الكرت مرةً ثانية." },
  uq_dsd_invoice_item: { msg: "بند الفاتورة هذا مربوطٌ بتفاصيل كرتٍ مسبقاً (حماية من الازدواج) — لا حاجة لإعادة التثبيت." },
  uq_dsub_invoice_item: { msg: "بند الفاتورة هذا مرتبط بعقد اشتراك مسبقاً (حماية من الازدواج) — لا حاجة لإعادة التثبيت." },
  uq_dsd_intent_item: { msg: "هذا الكرت مثبَّتٌ في فاتورةٍ مسبقاً — لا يُثبَّت الكرت الواحد مرّتين." },
};

// ── مستخرجات من سلسلة الأسباب (Drizzle يلفّ خطأ mysql2 داخل cause) ──────────

/** يمشي على سلسلة cause ويعيد sqlMessage الخام إن وُجد. */
function sqlMessageFrom(err: unknown): string | null {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e?.sqlMessage === "string") return e.sqlMessage;
    e = e?.cause;
  }
  return null;
}

/** يستخرج اسم العمود من sqlMessage لخطأ ER_DATA_TOO_LONG (مثل: Data too long for column 'url' at row 1). */
function dataTooLongColumnFrom(err: unknown): string | null {
  const m = /Data too long for column '([^']+)'/.exec(sqlMessageFrom(err) ?? "");
  return m ? m[1] : null;
}

/** يقصّ القيمة المعروضة في الرسالة (باركود/رقم طويل يكفي منه طرفه للتعرّف عليه). */
function truncateValue(v: string, max = 48): string {
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** اسم الحقل بالعربية (وإلا الاسم التقني كما هو — أفضل من لا شيء). */
function fieldLabel(col: string): string {
  return COLUMN_AR[col] ?? col;
}

/**
 * يفكّ ER_DUP_ENTRY إلى رسالة تشخيصية: الحقل + الشاشة + القيمة + السبب + الإجراء.
 * صيغة MySQL: Duplicate entry 'VALUE' for key 'table.key_name' (قد يغيب بادئ الجدول).
 */
function decodeDupEntry(cause: unknown): string | null {
  const m = /Duplicate entry '([\s\S]*)' for key '([^']+)'/.exec(sqlMessageFrom(cause) ?? "");
  if (!m) return null;
  const value = truncateValue(m[1]);
  const key = m[2].includes(".") ? m[2].split(".").pop()! : m[2];

  if (key === "PRIMARY") {
    return "سجلّ بنفس المعرّف الداخلي موجود مسبقاً (تعارض لحظي) — أعد المحاولة، وإن تكرّر أبلغ الدعم.";
  }

  const info = UNIQUE_AR[key];
  if (!info) {
    return (
      `قيمة مكرّرة: «${value}» — سجلّ آخر موجود مسبقاً بنفس القيمة (القيد: ${key}).\n` +
      "الإجراء: عدّل القيمة أو ابحث بها في النظام للوصول إلى السجلّ الحامل لها."
    );
  }
  if ("msg" in info) return info.msg;
  return (
    `قيمة مكرّرة في حقل «${info.field}» (${info.entity}): «${value}».\n` +
    "السبب: سجلّ آخر موجود مسبقاً بنفس القيمة، والنظام يشترط تفرّدها.\n" +
    `الإجراء: ${info.hint ?? "عدّل القيمة، أو ابحث بها في النظام للوصول إلى السجلّ الحامل لها."}`
  );
}

/** يفكّ ER_NO_REFERENCED_ROW_2: القيمة المختارة تشير لسجلّ محذوف/غير موجود — يسمّي الحقل والجدول. */
function decodeFkMissing(cause: unknown): string | null {
  const m = /CONSTRAINT `[^`]+` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)`/.exec(sqlMessageFrom(cause) ?? "");
  if (!m) return null;
  const table = TABLE_AR[m[2]] ?? m[2];
  return `القيمة المختارة في «${fieldLabel(m[1])}» تشير إلى سجلّ غير موجود في «${table}» (ربما حُذف أو تغيّر) — حدّث الصفحة وأعد الاختيار.`;
}

/** يفكّ ER_ROW_IS_REFERENCED_2: الحذف مرفوض لأن السجلّ مستعمَل — يسمّي الجدول المستعمِل. */
function decodeFkInUse(cause: unknown): string | null {
  const m = /constraint fails \(`[^`]+`\.`([^`]+)`, CONSTRAINT/.exec(sqlMessageFrom(cause) ?? "");
  if (!m) return null;
  const table = TABLE_AR[m[1]] ?? m[1];
  return `لا يمكن الحذف: السجلّ مستعمَل في «${table}» — أزل الارتباط أولاً، أو عطّل السجلّ بدل حذفه.`;
}

// ── ترجمة أخطاء تحقق zod (مدخلات الراوترات) بأسماء الحقول ─────────────────────

// يغطي شكلَي zod v3 وv4 معاً: v3 يحمل received/type/validation، وv4 يحمل origin/format/values
// ولا يحمل received (الغياب يُستدَل عليه من نص الرسالة «received undefined»).
type ZodIssueLite = {
  code?: string;
  path?: Array<string | number>;
  message?: string;
  expected?: unknown;
  received?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  type?: string; // v3
  origin?: string; // v4
  validation?: unknown; // v3
  format?: unknown; // v4
};

/** يلتقط ZodError (الملاحظات + رسالته الذاتية) من سلسلة cause بلا اعتماد على صنف zod نفسه. */
function zodErrorFrom(err: unknown): { issues: ZodIssueLite[]; message: string | null } | null {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e?.name === "ZodError" && Array.isArray(e.issues) && e.issues.length) {
      return { issues: e.issues, message: typeof e.message === "string" ? e.message : null };
    }
    e = e?.cause;
  }
  return null;
}

const ZOD_TYPE_AR: Record<string, string> = {
  string: "نص",
  number: "رقم",
  integer: "عدد صحيح",
  boolean: "نعم/لا",
  date: "تاريخ",
  array: "قائمة",
  object: "كائن",
};

function zodIssueReason(issue: ZodIssueLite): string {
  // رسالة عربية صريحة من المخطط (message مخصّصة في zod) تُعرض كما هي.
  if (issue.message && /[؀-ۿ]/.test(issue.message)) return issue.message;
  const kind = issue.type ?? issue.origin; // v3: type، v4: origin
  switch (issue.code) {
    case "invalid_type": {
      // v3: received="undefined"؛ v4: لا received — الغياب في نص الرسالة «received undefined».
      const missing =
        issue.received === "undefined" ||
        issue.received === "null" ||
        /received (undefined|null)/i.test(issue.message ?? "");
      return missing
        ? "حقل مطلوب تُرك فارغاً"
        : `نوع القيمة غير صالح (المطلوب: ${ZOD_TYPE_AR[String(issue.expected)] ?? String(issue.expected)})`;
    }
    case "too_small":
      if (kind === "string") return `النص أقصر من الحدّ الأدنى (${String(issue.minimum)})`;
      if (kind === "array") return `عدد العناصر أقل من المطلوب (${String(issue.minimum)})`;
      return `القيمة أصغر من الحدّ المسموح (${String(issue.minimum)})`;
    case "too_big":
      if (kind === "string") return `النص أطول من الحدّ الأقصى (${String(issue.maximum)})`;
      if (kind === "array") return `عدد العناصر أكثر من المسموح (${String(issue.maximum)})`;
      return `القيمة أكبر من الحدّ المسموح (${String(issue.maximum)})`;
    case "invalid_string": // v3
    case "invalid_format": { // v4
      const fmt = issue.validation ?? issue.format;
      if (fmt === "email") return "بريد إلكتروني غير صالح";
      if (fmt === "url") return "رابط غير صالح";
      return "صيغة النص غير صالحة";
    }
    case "invalid_enum_value": // v3
    case "invalid_value": // v4
      return "القيمة خارج الخيارات المسموحة";
    default:
      return "قيمة غير صالحة";
  }
}

/** «حقل «الكمية» — السطر ٣» من مسار zod مثل ["items", 2, "quantity"]. */
function zodIssueWhere(path: Array<string | number>): string {
  const lastField = [...path].reverse().find((p): p is string => typeof p === "string");
  const rowIdx = path.find((p): p is number => typeof p === "number");
  if (lastField == null) return "";
  const row = rowIdx != null ? ` — السطر ${rowIdx + 1}` : "";
  return `حقل «${fieldLabel(lastField)}»${row}: `;
}

/** يبني رسالة عربية من ملاحظات zod: يسمّي كل حقل وسبب رفضه (حتى ٣ ملاحظات). */
function zodToArabic(issues: ZodIssueLite[]): string {
  const lines = issues.slice(0, 3).map((i) => `— ${zodIssueWhere(i.path ?? [])}${zodIssueReason(i)}`);
  const extra = issues.length > 3 ? `\n… و${issues.length - 3} ملاحظات أخرى.` : "";
  return `مدخلات غير صالحة — راجع:\n${lines.join("\n")}${extra}`;
}

// ── الواجهة العامة ────────────────────────────────────────────────────────────

/** رسائل عامة بحسب كود tRPC حين لا تتوفّر رسالة عربية أدقّ. */
const TRPC_CODE_AR: Record<string, string> = {
  BAD_REQUEST: "طلب غير صالح — تحقّق من المدخلات.",
  UNAUTHORIZED: "يجب تسجيل الدخول.",
  FORBIDDEN: "ليست لديك صلاحية لهذا الإجراء.",
  NOT_FOUND: "العنصر المطلوب غير موجود.",
  TIMEOUT: "انتهت مهلة العملية.",
  CONFLICT: "تعارض مع الحالة الحالية للبيانات.",
  TOO_MANY_REQUESTS: "محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة.",
  INTERNAL_SERVER_ERROR: "حدث خطأ غير متوقّع في النظام.",
};

/** الرسالة العامة غير التشخيصية — يقارنها errorFormatter ليُلحق «رمز المتابعة» بها وحدها
 *  (رفض قواعد الأعمال برسالة عربية مفهومة لا يحتاج دعماً؛ إلحاق الرمز بكل شيء = ضجيج). */
export const GENERIC_INTERNAL_AR = TRPC_CODE_AR.INTERNAL_SERVER_ERROR;

/** أرقام أخطاء MySQL التي تُطبَّع إلى رمزها النصّي حين يصل الخطأ بلا `code` نصّي —
 *  بعض الأغلفة تُبقي `errno`/`sqlState` فقط، فيعمى كاشفا الإعادة (isDupEntry/isDeadlock)
 *  عن خطأ قابلٍ للإعادة ويصل المستخدمَ 500 بدل محاولةٍ ثانية صامتة (فحص الحمل ٣٠/٨/٢٦). */
const MYSQL_ERRNO_TO_CODE: Record<number, string> = {
  1062: "ER_DUP_ENTRY",
  1213: "ER_LOCK_DEADLOCK",
  1205: "ER_LOCK_WAIT_TIMEOUT",
};

/** يحاول استخراج رمز خطأ MySQL من سلسلة الأسباب (code نصّي ← errno رقمي ← sqlState). */
export function mysqlCodeFrom(err: unknown): string | null {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e?.code === "string" && (MYSQL_AR[e.code] || /^ER_|^E[A-Z]+$/.test(e.code))) return e.code;
    if (typeof e?.errno === "number" && MYSQL_ERRNO_TO_CODE[e.errno]) return MYSQL_ERRNO_TO_CODE[e.errno];
    // SQLSTATE 40001 = فشل تسلسل (ضحية deadlock) بحسب المعيار — يعادل ER_LOCK_DEADLOCK.
    if (e?.sqlState === "40001") return "ER_LOCK_DEADLOCK";
    e = e?.cause;
  }
  return null;
}

/**
 * هل الخطأ انتهاك قيد فريد (Duplicate entry)؟
 *
 * ⚠️ **الفحص الآمن الوحيد:** Drizzle 0.45.x يلفّ خطأ mysql2 داخل `DrizzleQueryError`،
 * فيصبح `e.code` على المستوى الأعلى `undefined` والرمز الحقيقي على `e.cause.code`
 * (أو أعمق). الفحص العاري `e?.code === "ER_DUP_ENTRY"` **لا يلتقطه أبداً** ⇒ تموت
 * شبكة إعادة المحاولة. استعمل هذه الدالة (تمشي على سلسلة `cause`) لا الفحص المباشر.
 */
export function isDupEntry(err: unknown): boolean {
  return mysqlCodeFrom(err) === "ER_DUP_ENTRY";
}

/** هل الخطأ deadlock أو انتظار قفل انتهت مهلته؟ (قابل لإعادة المحاولة، عبر سلسلة cause). */
export function isDeadlock(err: unknown): boolean {
  const code = mysqlCodeFrom(err);
  return code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT";
}

/** أخطاء قاعدة البيانات القابلة لإعادة المحاولة الآمنة (تكرار مفتاح أو تعارض قفل مؤقّت). */
export function isRetryableDbError(err: unknown): boolean {
  return isDupEntry(err) || isDeadlock(err);
}

/**
 * يحوّل أي خطأ إلى رسالة عربية تشخيصية.
 * الأولوية: رسالة الأعمال الصريحة ← zod (بأسماء الحقول) ← تفكيك MySQL (الحقل/القيمة/السبب)
 * ← خريطة رموز MySQL ← كود tRPC ← عام.
 */
export function toArabicMessage(opts: {
  trpcCode?: string;
  originalMessage?: string;
  cause?: unknown;
}): string {
  const { trpcCode, originalMessage, cause } = opts;

  // أخطاء تحقق المدخلات (zod) تُفكّ **قبل** ممرّ «الرسالة العربية الصريحة»: في zod v4 رسالة
  // ZodError نفسها = JSON.stringify(issues) الخام، وحين يحمل المخطط رسالة عربية مخصّصة
  // (مثل min(1, "الاسم مطلوب")) يحوي الـJSON حرفاً عربياً فيخدع الممرّ ويتسرّب JSON كاملاً
  // للمستخدم (مراجعة عدائية ١٥/٧). الاستثناء الوحيد: رسالة أعمال عربية متعمَّدة مغايرة
  // لرسالة ZodError الذاتية وليست JSON — تلك تمرّ كما هي.
  const zodErr = zodErrorFrom(cause);
  if (zodErr) {
    const explicitBusiness =
      !!originalMessage &&
      /[؀-ۿ]/.test(originalMessage) &&
      !/^\s*\[/.test(originalMessage) &&
      originalMessage !== zodErr.message;
    if (!explicitBusiness) return zodToArabic(zodErr.issues);
  }

  // رسالة أعمال عربية صريحة من الخدمات (تحتوي حرفاً عربياً) ⇒ نستعملها كما هي.
  // استثناء: «Failed query: …» غلاف Drizzle الخام — قد يحمل معاملات عربية (مثل «قطعة»)
  // فيخدع الكشف ويُسرّب نصّ SQL والقيم للمستخدم؛ نحيله لخريطة رموز MySQL أدناه.
  const isRawQueryError = !!originalMessage && /^Failed query:/i.test(originalMessage);
  if (originalMessage && !isRawQueryError && /[؀-ۿ]/.test(originalMessage)) return originalMessage;

  const code = mysqlCodeFrom(cause);

  // ER_DUP_ENTRY: تفكيك كامل (الحقل + الشاشة + القيمة + السبب + الإجراء) عبر سجلّ القيود.
  if (code === "ER_DUP_ENTRY") {
    const decoded = decodeDupEntry(cause);
    if (decoded) return decoded;
  }

  // ER_DATA_TOO_LONG: نسمّي الحقل المقصود بالعربية بدل رسالة عامة لا تدلّ المستخدم على شيء.
  if (code === "ER_DATA_TOO_LONG") {
    const col = dataTooLongColumnFrom(cause);
    if (col) return `قيمة أطول من المسموح في الحقل «${fieldLabel(col)}».`;
  }

  // ER_BAD_NULL_ERROR: نسمّي الحقل الفارغ.
  if (code === "ER_BAD_NULL_ERROR") {
    const m = /Column '([^']+)' cannot be null/.exec(sqlMessageFrom(cause) ?? "");
    if (m) return `حقل مطلوب تُرك فارغاً: «${fieldLabel(m[1])}».`;
  }

  // أخطاء المفاتيح الأجنبية: نسمّي الحقل/الجدول المعنيّ.
  if (code === "ER_NO_REFERENCED_ROW_2") {
    const decoded = decodeFkMissing(cause);
    if (decoded) return decoded;
  }
  if (code === "ER_ROW_IS_REFERENCED_2") {
    const decoded = decodeFkInUse(cause);
    if (decoded) return decoded;
  }

  if (code && MYSQL_AR[code]) return MYSQL_AR[code];

  if (trpcCode && TRPC_CODE_AR[trpcCode]) return TRPC_CODE_AR[trpcCode];

  return TRPC_CODE_AR.INTERNAL_SERVER_ERROR;
}
