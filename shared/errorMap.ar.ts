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

/** يحوّل أي خطأ إلى رسالة عربية. الأولوية: رسالة الأعمال الصريحة ← MySQL ← كود tRPC ← عام. */
export function toArabicMessage(opts: {
  trpcCode?: string;
  originalMessage?: string;
  cause?: unknown;
}): string {
  const { trpcCode, originalMessage, cause } = opts;

  // رسالة أعمال عربية صريحة من الخدمات (تحتوي حرفاً عربياً) ⇒ نستعملها كما هي.
  if (originalMessage && /[؀-ۿ]/.test(originalMessage)) return originalMessage;

  const code = mysqlCodeFrom(cause);
  if (code && MYSQL_AR[code]) return MYSQL_AR[code];

  if (trpcCode && TRPC_CODE_AR[trpcCode]) return TRPC_CODE_AR[trpcCode];

  return TRPC_CODE_AR.INTERNAL_SERVER_ERROR;
}
