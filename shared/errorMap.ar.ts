// خريطة أخطاء عربية موحّدة — يستعملها errorFormatter في tRPC ليرى المستخدم رسالة مفهومة
// بدل رمز فنّي أو «Something went wrong». مشتركة بين الخادم والعميل.

/** رموز أخطاء MySQL (mysql2) → رسالة عربية. */
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

/** أسماء عربية للأعمدة الشائعة — تُعرض في رسالة «قيمة أطول من المسموح في الحقل …». */
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
};

/** يستخرج اسم العمود من sqlMessage لخطأ ER_DATA_TOO_LONG (مثل: Data too long for column 'url' at row 1). */
function dataTooLongColumnFrom(err: unknown): string | null {
  let e: any = err;
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e?.sqlMessage === "string") {
      const m = /Data too long for column '([^']+)'/.exec(e.sqlMessage);
      if (m) return m[1];
    }
    e = e?.cause;
  }
  return null;
}

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

/** يحوّل أي خطأ إلى رسالة عربية. الأولوية: رسالة الأعمال الصريحة ← MySQL ← كود tRPC ← عام. */
export function toArabicMessage(opts: {
  trpcCode?: string;
  originalMessage?: string;
  cause?: unknown;
}): string {
  const { trpcCode, originalMessage, cause } = opts;

  // رسالة أعمال عربية صريحة من الخدمات (تحتوي حرفاً عربياً) ⇒ نستعملها كما هي.
  // استثناء: «Failed query: …» غلاف Drizzle الخام — قد يحمل معاملات عربية (مثل «قطعة»)
  // فيخدع الكشف ويُسرّب نصّ SQL والقيم للمستخدم؛ نحيله لخريطة رموز MySQL أدناه.
  const isRawQueryError = !!originalMessage && /^Failed query:/i.test(originalMessage);
  if (originalMessage && !isRawQueryError && /[؀-ۿ]/.test(originalMessage)) return originalMessage;

  const code = mysqlCodeFrom(cause);

  // ER_DATA_TOO_LONG: نسمّي الحقل المقصود بالعربية بدل رسالة عامة لا تدلّ المستخدم على شيء.
  if (code === "ER_DATA_TOO_LONG") {
    const col = dataTooLongColumnFrom(cause);
    if (col) return `قيمة أطول من المسموح في الحقل «${COLUMN_AR[col] ?? col}».`;
  }

  if (code && MYSQL_AR[code]) return MYSQL_AR[code];

  if (trpcCode && TRPC_CODE_AR[trpcCode]) return TRPC_CODE_AR[trpcCode];

  return TRPC_CODE_AR.INTERNAL_SERVER_ERROR;
}
