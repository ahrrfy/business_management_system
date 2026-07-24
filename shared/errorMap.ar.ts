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

  // ── المستخدمون والموظفون ──
  users_email_unique: { field: "البريد الإلكتروني", entity: "المستخدمون", hint: "مستخدم آخر مسجّل بنفس البريد — استعمل بريداً مختلفاً أو عدّل حساب المستخدم الموجود." },
  users_username_unique: { field: "اسم المستخدم", entity: "المستخدمون", hint: "اسم الدخول محجوز لمستخدم آخر — اختر اسماً مختلفاً." },
  users_openId_unique: { msg: "معرّف مستخدم داخلي مكرّر (خطأ داخلي) — أعد المحاولة، وإن تكرّر أبلغ الدعم." },
  roles_key_unique: { field: "رمز الدور", entity: "الأدوار المخصّصة" },
  employees_email_unique: { field: "البريد الإلكتروني", entity: "الموظفون" },
  uq_employee_national_id: { field: "الرقم الوطني", entity: "الموظفون", hint: "موظف آخر مسجّل بنفس الرقم الوطني — تحقّق من عدم تكرار الملف." },
  uq_employee_user: { msg: "حساب المستخدم مربوط بموظف آخر — لكل حساب دخول ملفُّ موظفٍ واحد؛ اختر حساباً آخر أو فكّ الربط القديم." },
  uq_delivery_party_user: { msg: "حساب المستخدم مربوط بمندوب توصيل آخر — اختر حساباً آخر أو فكّ الربط القديم." },
  uq_att_employee_date: { msg: "سُجّل حضور لهذا الموظف في نفس اليوم مسبقاً — عدّل سجلّ الحضور الموجود بدل إضافة سجلّ جديد." },
  uq_fpdev_serial: { field: "الرقم التسلسلي", entity: "أجهزة الحضور", hint: "جهاز آخر مسجّل بنفس الرقم التسلسلي (SN) — لكل جهاز رقمٌ فريد." },
  uq_punch_sn_enroll_time: { msg: "هذه البصمة مستلَمة مسبقاً من الجهاز — تكرارها بلا أثر (الجهاز يعيد الدفع بعد الانقطاع)." },
  uq_devuser_device_enroll: { msg: "رقم المستخدم هذا مسجّل مسبقاً على الجهاز — عدّل ربطه بدل إضافته من جديد." },

  // ── الفروع والتشغيل ──
  branches_code_unique: { field: "رمز الفرع", entity: "الفروع" },
  uq_shift_open_guard: { msg: "توجد وردية مفتوحة من نفس النوع لهذا الموظف على هذا الفرع — أغلق الوردية المفتوحة أولاً ثم افتح الجديدة." },
  uq_year_branch: { msg: "السنة المالية مفتوحة مسبقاً لهذا الفرع — راجع شاشة الفترات المالية." },
  uq_kiosk_token_hash: { msg: "رمز الكشك مستعمل مسبقاً — ولّد رمزاً جديداً." },
  pushSubscriptions_endpoint_unique: { msg: "اشتراك الإشعارات مسجّل مسبقاً لهذا المتصفح — لا حاجة لإعادة التفعيل." },

  // ── الترقيم التسلسلي للمستندات (تصادم لحظي — الراوتر يعيد المحاولة تلقائياً) ──
  invoices_invoiceNumber_unique: { field: "رقم الفاتورة", entity: "الفواتير", hint: "تصادم ترقيم لحظي بين عمليتين متزامنتين — أعد المحاولة، وإن تكرّر أبلغ الدعم." },
  quotations_quoteNumber_unique: { field: "رقم عرض السعر", entity: "عروض الأسعار", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  receipts_voucherNumber_unique: { field: "رقم السند", entity: "السندات", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
  purchaseOrders_poNumber_unique: { field: "رقم أمر الشراء", entity: "أوامر الشراء", hint: "تصادم ترقيم لحظي — أعد المحاولة." },
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
  uq_entry_dedupe: { msg: "قيد محاسبي مكرّر لنفس العملية — العملية مسجّلة مسبقاً في الدفتر (حماية من الازدواج)." },
  uq_stkcount_request: { msg: "طلب العدّ نُفِّذ مسبقاً (حماية من الازدواج) — لا حاجة لإعادة الإرسال." },

  // ── قيود «سجلّ واحد لكل …» المركّبة ──
  uq_stock_variant_branch: { msg: "رصيد هذا المتغيّر مهيّأ مسبقاً لهذا الفرع (خطأ داخلي في تهيئة الرصيد) — أبلغ الدعم." },
  uq_tline_transfer_variant: { msg: "المتغيّر مُدرَج مسبقاً في نفس التحويل — عدّل كمية السطر الموجود بدل إضافته مرّة ثانية." },
  uq_stkitem_session_variant: { msg: "الصنف مُدرَج مسبقاً في نفس جلسة الجرد — عدّل السطر الموجود." },
  uq_stkdecision_session_variant: { msg: "قرار الجرد مسجّل مسبقاً لهذا الصنف في نفس الجلسة." },
  uq_wo_invoice: { msg: "لأمر الشغل هذا فاتورة صادرة مسبقاً — لا يمكن إصدار فاتورة ثانية لنفس الأمر." },
  uq_consignment_invoice: { msg: "لهذه الفاتورة إرسالية توصيل مسبقاً — راجع شاشة التوصيل." },
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

  // ── السندات ──
  uq_vchcat_name: { field: "اسم الفئة", entity: "فئات السندات" },

  // ── الكوبونات (هجرة 0078) ──
  uq_coupon_code: { field: "رمز الكوبون", entity: "الكوبونات", hint: "كوبون آخر يحمل نفس الرمز — ولّد رمزاً مختلفاً." },
  uq_coupon_hash: { msg: "رمز الكوبون مستعمل مسبقاً (تطابق البصمة) — ولّد رمزاً مختلفاً." },
  uq_coupon_redemption_invoice: { msg: "لهذه الفاتورة كوبون مستخدَم مسبقاً — كوبون واحد لكل فاتورة." },
  uq_coupon_redemption_coupon_invoice: { msg: "هذا الكوبون مستخدَم مسبقاً على نفس الفاتورة (حماية من الازدواج)." },

  // ── منصّة تعدّد الشركات (قاعدة التحكّم) ──
  uq_provision_active_code: { msg: "يوجد طلب توفير نشط أو شركة قائمة بنفس الرمز — اختر رمز شركة مختلفاً." },
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

/** يحاول استخراج رمز خطأ MySQL من سلسلة الأسباب. */
export function mysqlCodeFrom(err: unknown): string | null {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e?.code === "string" && (MYSQL_AR[e.code] || /^ER_|^E[A-Z]+$/.test(e.code))) return e.code;
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
