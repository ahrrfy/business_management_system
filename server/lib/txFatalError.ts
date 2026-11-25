/**
 * حارس أخطاء المعاملات القاتلة في MySQL/InnoDB.
 *
 * في InnoDB، أخطاء مثل `ER_LOCK_DEADLOCK` (1213) تتراجع تلقائياً عن المعاملة النشطة كاملةً
 * وتعيد الاتصال إلى وضع التنفيذ خارج المعاملة. ابتلاع هذه الأخطاء داخل `catch {}` ("أفضل جهد")
 * داخل `withTx` يدمّر ذرّية المعاملة المالية (تضيع الكتابات السابقة وتُحفظ الكتابات اللاحقة منفردة).
 */

const FATAL_TX_ERRNOS = new Set<number>([
  1213, // ER_LOCK_DEADLOCK — InnoDB تراجع عن المعاملة كاملةً بالفعل
  1205, // ER_LOCK_WAIT_TIMEOUT — لا يجوز المتابعة بصمت داخل معاملة مالية
  1290, // ER_OPTION_PREVENTS_STATEMENT — super_read_only / read_only
  1053, // ER_SERVER_SHUTDOWN
  2006, // CR_SERVER_GONE_ERROR
  2013, // CR_SERVER_LOST
]);

const FATAL_TX_CODES = new Set<string>([
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_OPTION_PREVENTS_STATEMENT",
  "ER_SERVER_SHUTDOWN",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

/** هل يمثّل الخطأ (أو سلسلة `.cause` تحته، مثل `DrizzleQueryError`) عطباً قاتلاً للمعاملة/الاتصال؟ */
export function isTransactionFatalError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null && typeof cur === "object"; depth += 1) {
    const rec = cur as {
      errno?: unknown;
      code?: unknown;
      fatal?: unknown;
      sqlState?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (rec.fatal === true) return true;
    if (typeof rec.errno === "number" && FATAL_TX_ERRNOS.has(rec.errno)) return true;
    if (typeof rec.code === "string" && FATAL_TX_CODES.has(rec.code)) return true;
    if (rec.sqlState === "40001") return true;
    if (
      typeof rec.message === "string" &&
      /Deadlock found when trying to get lock|Lock wait timeout exceeded|The MySQL server is running with the --super-read-only/i.test(
        rec.message,
      )
    ) {
      return true;
    }
    cur = rec.cause;
  }
  return false;
}

/** يعيد رمي الخطأ فوراً إن كان قاتلاً للمعاملة النشطة كي لا يُبتلع داخل كتل أفضل-جهد. */
export function rethrowIfTransactionFatal(err: unknown): void {
  if (isTransactionFatalError(err)) {
    throw err;
  }
}
