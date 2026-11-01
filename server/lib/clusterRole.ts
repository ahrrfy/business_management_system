/**
 * أدوار عمليات PM2 في وضع العنقود (cluster) — منطق نقيّ قابل للاختبار بمعزل عن الخادم الكامل.
 *
 * الغرض: توزيع الأحمال **داخل الخادم** — كل نواةٍ عاملٌ (worker) يخدم الطلبات — مع ضمان أنّ
 * الوظائف الخلفيّة (الكنّاسات + الكرون + جسر الحضور) تعمل في **عاملٍ واحدٍ فقط**، وإلّا تكرّرت
 * في كل عامل ⇒ إرسالٌ مزدوج (واتساب/دفع)، كرونٌ مضاعف، وتضارب منفذ جسر الحضور (7788).
 *
 * PM2 في وضع cluster يضبط `NODE_APP_INSTANCE = 0..N-1` لكل عامل؛ ووضع fork (التطوير أو العملية
 * الوحيدة) لا يضبطه (undefined).
 */

/**
 * هل يُشغّل هذا العامل الوظائف الخلفيّة؟
 *
 * نعم في: (أ) العامل رقم "0" من العنقود، أو (ب) عملية fork وحيدة (لا `NODE_APP_INSTANCE`).
 * لا في: عمّال العنقود 1..N-1. هكذا تعمل كل وظيفةٍ خلفيّةٍ **مرّةً واحدةً بالضبط** على مستوى
 * الخادم مهما بلغ عدد العمّال.
 */
export type WebRuntimeRole = "legacy" | "public" | "admin";

export function webRuntimeRole(
  env: NodeJS.ProcessEnv = process.env,
): WebRuntimeRole {
  const role = env.WEB_RUNTIME_ROLE || "legacy";
  if (role !== "legacy" && role !== "public" && role !== "admin")
    throw new Error("Invalid WEB_RUNTIME_ROLE");
  return role;
}

export function runtimeWorkerCounts(
  env: NodeJS.ProcessEnv = process.env,
  context: "http" | "database" = "http",
) {
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 32)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  const split = env.WEB_RUNTIME_MODE === "split";
  if (
    env.WEB_RUNTIME_MODE &&
    !["legacy", "split"].includes(env.WEB_RUNTIME_MODE)
  )
    throw new Error("Invalid WEB_RUNTIME_MODE");
  const publicWorkers = split ? number("PUBLIC_WEB_INSTANCES", 1) : 0;
  const adminWorkers = split
    ? number("ADMIN_WEB_INSTANCES", 2)
    : number("WEB_INSTANCES", 2);
  const total = number("WEB_INSTANCES", split ? 3 : 2);
  if (
    split &&
    (total !== publicWorkers + adminWorkers || (webRuntimeRole(env) === "legacy" && (context === "http" || !!env.WEB_RUNTIME_ROLE)))
  )
    throw new Error(
      "Split runtime requires an explicit role and global WEB_INSTANCES equal to both groups",
    );
  if (!split && webRuntimeRole(env) !== "legacy")
    throw new Error("Explicit runtime roles require WEB_RUNTIME_MODE=split");
  return { split, publicWorkers, adminWorkers, total };
}

export function isBackgroundJobRunner(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (webRuntimeRole(env) === "public") return false;
  const instance = env.NODE_APP_INSTANCE;
  return instance === undefined || instance === "0";
}

/**
 * هل نعمل ضمن عنقود PM2 (عدّة عمّال يتقاسمون منفذاً واحداً عبر مقبض مشترك)؟
 * يُستعمَل لتخطّي فحص توفّر المنفذ (الفحص المنفصل يلتبس بمشاركة المقبض بين العمّال) والربط
 * مباشرةً على `PORT`.
 */
export function isClustered(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_APP_INSTANCE !== undefined;
}

/**
 * هل نعمل بأكثر من عاملِ ويبٍ واحد؟ (يُقرأ من `WEB_INSTANCES` الذي يُمرَّر في ecosystem)
 *
 * يُستعمَل لحجب المفردات ذات **الحالة الحيّة داخل العملية** (جسر أجهزة الحضور: مقابس WebSocket
 * حيّة + سجلّ أجهزةٍ في الذاكرة تقرأه نقاطُ `hrDevices.bridgeStatus/enqueueCommand`) عن العنقود
 * متعدّد العمّال: لا يمكن لعاملٍ آخر رؤية حالة العامل 0 الحيّة، ومنفذ الجسر (7788) يتسابق عند
 * إعادة التحميل المتدحرجة. حتى يُبنى تخزينٌ مشترك/توجيهٌ لمالك الجسر، يعمل الجسر في وضع
 * **العامل الواحد** فقط. الأمان أوّلاً: أيّ قيمةٍ غير «1» صريحة (بما فيها "max"/"0"=كل النوى أو
 * قيمةٌ مجهولة) تُعامَل كعنقودٍ متعدّد.
 */
export function isMultiWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (webRuntimeRole(env) !== "legacy") return true;
  const n = env.WEB_INSTANCES;
  if (n === undefined || n === "" || n === "1") return false;
  return true;
}
