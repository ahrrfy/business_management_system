export type PwaUpdateAction =
  | "ACTIVATE_WAITING"
  | "RELOAD_ACTIVE"
  | "CHECK_AGAIN"
  | "UNAVAILABLE";

export type PwaRegistrationState = {
  hasRegistration: boolean;
  hasWaitingWorker: boolean;
  hasActivatingWorker?: boolean;
  hasActiveWorker: boolean;
  updateWasSignaled: boolean;
};

export type WorkerActivationResult =
  | { status: "activated"; acknowledged: boolean }
  | { status: "superseded"; acknowledged: boolean }
  | { status: "failed"; acknowledged: boolean }
  | { status: "timeout"; acknowledged: boolean };

export type RegistrationActivationResult =
  | { status: "activated"; attempts: number; acknowledged: boolean }
  | { status: "unavailable"; attempts: number; acknowledged: boolean }
  | { status: "no-waiting-worker"; attempts: number; acknowledged: boolean }
  | { status: "failed"; attempts: number; acknowledged: boolean }
  | { status: "timeout"; attempts: number; acknowledged: boolean };

const DEFAULT_ACTIVATION_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const REDUNDANT_RECHECK_MS = 250;

/**
 * يحدد الإجراء من حالة التسجيل الفعلية، لا من وجود بنر الواجهة وحده.
 *
 * قد يعلن Workbox عن تحديث في صفحة لم يكن العامل القديم يسيطر عليها. عندها
 * يصبح الإصدار الجديد active مباشرةً ولا يوجد waiting؛ إعادة فتح الصفحة هي
 * الإجراء الصحيح، بينما إرسال SKIP_WAITING يكون no-op.
 */
export function decidePwaUpdateAction(
  state: PwaRegistrationState,
): PwaUpdateAction {
  if (!state.hasRegistration) return "UNAVAILABLE";
  if (state.hasWaitingWorker || state.hasActivatingWorker) {
    return "ACTIVATE_WAITING";
  }
  if (state.updateWasSignaled && state.hasActiveWorker) return "RELOAD_ACTIVE";
  return "CHECK_AGAIN";
}

function createRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * يطلب التفعيل بقناتين متوافقتين:
 * - PWA_ACTIVATE: بروتوكولنا ذو إقرار الاستلام للعامل الحديث.
 * - SKIP_WAITING: مسار Workbox القياسي كي يظل أول تحديث بعد نشر هذا الإصلاح قابلاً للتفعيل.
 */
function requestActivation(
  worker: ServiceWorker,
  onAcknowledged: () => void,
): () => void {
  let port: MessagePort | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof MessageChannel !== "undefined") {
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event) => {
        if (event.data?.type === "PWA_ACTIVATION_ACCEPTED") {
          onAcknowledged();
        }
      };
      worker.postMessage(
        { type: "PWA_ACTIVATE", requestId: createRequestId() },
        [channel.port2],
      );
    }
  } catch {
    port?.close();
    port = null;
  }

  // العامل المنشور قبل إضافة بروتوكول الإقرار لا يعرف إلا رسالة Workbox هذه.
  worker.postMessage({ type: "SKIP_WAITING" });
  // الإقرار لا يثبت activated؛ أعد تحرير التدفق حتى يثبت الانتظار التفعيل أو ينتهي.
  let stopped = false;
  const retry = () => {
    if (stopped) return;
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch {
      // الانتقال إلى activated/redundant قبل المؤقت يجعل الإرسال غير لازم.
    }
    retryTimer = setTimeout(retry, 3_000);
  };
  retryTimer = setTimeout(retry, 3_000);
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    port?.close();
  };
}

/**
 * ينتظر انتقال عامل بعينه إلى active مع polling احتياطي إلى جانب statechange.
 * بعض WebViews تفوّت statechange عند انتقال التطبيق إلى الخلفية؛ قراءة التسجيل
 * الفعلية تمنع تحويل حدث مفقود إلى فشل وهمي.
 */
export function waitForWorkerActivation(
  registration: ServiceWorkerRegistration,
  worker: ServiceWorker,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    sendActivation?: (
      worker: ServiceWorker,
      onAcknowledged: () => void,
    ) => void | (() => void);
  } = {},
): Promise<WorkerActivationResult> {
  if (worker.state === "activated") {
    return Promise.resolve({ status: "activated", acknowledged: false });
  }

  const previousActive = registration.active;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return new Promise((resolve) => {
    let acknowledged = false;
    let settled = false;
    let redundantTimer: ReturnType<typeof setTimeout> | undefined;
    let stopActivationRequest: void | (() => void);

    const finish = (status: WorkerActivationResult["status"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      if (redundantTimer) clearTimeout(redundantTimer);
      worker.removeEventListener("statechange", inspect);
      stopActivationRequest?.();
      resolve({ status, acknowledged } as WorkerActivationResult);
    };

    const inspect = () => {
      if (worker.state === "activated") {
        finish("activated");
        return;
      }

      // إن أصبح عامل آخر active أثناء المحاولة، فالغاية تحققت بإصدار أحدث.
      if (
        registration.active?.state === "activated" &&
        registration.active !== previousActive
      ) {
        finish("activated");
        return;
      }

      if (registration.waiting && registration.waiting !== worker) {
        finish("superseded");
        return;
      }

      if (worker.state === "redundant" && !redundantTimer) {
        // خصائص registration تتحدّث أحياناً بعد statechange بمهمة لاحقة.
        redundantTimer = setTimeout(() => {
          redundantTimer = undefined;
          if (registration.active && registration.active !== previousActive) {
            // active يُعيَّن قبل اكتمال activate؛ اترك polling ينتظر activated.
            if (registration.active.state === "activated") finish("activated");
          } else if (registration.waiting && registration.waiting !== worker) {
            finish("superseded");
          } else {
            finish("failed");
          }
        }, REDUNDANT_RECHECK_MS);
      }
    };

    const timeout = setTimeout(() => finish("timeout"), timeoutMs);
    const poll = setInterval(inspect, pollIntervalMs);
    worker.addEventListener("statechange", inspect);

    try {
      stopActivationRequest = (options.sendActivation ?? requestActivation)(
        worker,
        () => {
          acknowledged = true;
          inspect();
        },
      );
    } catch {
      finish("failed");
      return;
    }
    inspect();
  });
}

/**
 * يفعّل العامل المنتظر مع معالجة سباق «عامل صار redundant لأن إصداراً أحدث
 * سبقه». نعيد قراءة التسجيل ونفعّل البديل بدلاً من عرض فشل كاذب للمستخدم.
 */
export async function activateRegistrationUpdate(options: {
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  sendActivation?: (
    worker: ServiceWorker,
    onAcknowledged: () => void,
  ) => void | (() => void);
}): Promise<RegistrationActivationResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  let acknowledged = false;

  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const registration = await options.getRegistration();
    if (!registration) {
      return { status: "unavailable", attempts, acknowledged };
    }

    const worker =
      registration.waiting ??
      (registration.active?.state === "activating"
        ? registration.active
        : null);
    if (!worker) {
      return { status: "no-waiting-worker", attempts, acknowledged };
    }

    const result = await waitForWorkerActivation(registration, worker, {
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      sendActivation: options.sendActivation,
    });
    acknowledged ||= result.acknowledged;

    if (result.status === "activated") {
      return { status: "activated", attempts, acknowledged };
    }
    if (result.status === "timeout") {
      return { status: "timeout", attempts, acknowledged };
    }
    if (result.status === "failed") {
      return { status: "failed", attempts, acknowledged };
    }
    // superseded: اقرأ registration مجدداً وفعّل العامل الأحدث.
  }

  return { status: "failed", attempts: maxAttempts, acknowledged };
}

const AUTO_ATTEMPT_KEY = "alroya.pwa-update.auto-attempt.v1";
const STOREFRONT_PERSIST_REQUEST_EVENT = "alroya:storefront-persist-request";

export type PwaAutoAttempt = {
  version: string;
  status: "ATTEMPTING" | "FAILED" | "RELOADING";
  attemptedAt: number;
};

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readPwaAutoAttempt(
  storage: AttemptStorage = localStorage,
): { ok: true; value: PwaAutoAttempt | null } | { ok: false; value: null } {
  try {
    const raw = storage.getItem(AUTO_ATTEMPT_KEY);
    if (!raw) return { ok: true, value: null };
    const parsed = JSON.parse(raw) as Partial<PwaAutoAttempt>;
    if (
      typeof parsed.version !== "string" ||
      !["ATTEMPTING", "FAILED", "RELOADING"].includes(parsed.status ?? "") ||
      typeof parsed.attemptedAt !== "number"
    ) {
      storage.removeItem(AUTO_ATTEMPT_KEY);
      return { ok: true, value: null };
    }
    return { ok: true, value: parsed as PwaAutoAttempt };
  } catch {
    return { ok: false, value: null };
  }
}

export function writePwaAutoAttempt(
  attempt: PwaAutoAttempt,
  storage: AttemptStorage = localStorage,
): boolean {
  try {
    storage.setItem(AUTO_ATTEMPT_KEY, JSON.stringify(attempt));
    return true;
  } catch {
    return false;
  }
}

export function clearPwaAutoAttempt(
  storage: AttemptStorage = localStorage,
): boolean {
  try {
    storage.removeItem(AUTO_ATTEMPT_KEY);
    return true;
  } catch {
    return false;
  }
}

export const PWA_FAILED_AUTO_RETRY_COOLDOWN_MS = 60_000;

export function shouldAutoApplyWaitingVersion(
  version: string,
  attempt: PwaAutoAttempt | null,
  options?: {
    unattended?: boolean;
    now?: number;
    retryCooldownMs?: number;
  },
): boolean {
  if (attempt?.version !== version) return true;
  if (!options?.unattended || attempt.status !== "FAILED") return false;
  const now = options.now ?? Date.now();
  const cooldownMs =
    options.retryCooldownMs ?? PWA_FAILED_AUTO_RETRY_COOLDOWN_MS;
  return now - attempt.attemptedAt >= cooldownMs;
}

export function shouldClearPwaAutoAttempt(input: {
  hasWaitingWorker: boolean;
  activeWorkerState?: ServiceWorkerState;
  activationVerified: boolean;
}): boolean {
  return (
    input.activationVerified &&
    !input.hasWaitingWorker &&
    input.activeWorkerState === "activated"
  );
}

function hashWorkerScript(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export async function resolveWaitingWorkerVersion(
  worker: Pick<ServiceWorker, "scriptURL">,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetcher(worker.scriptURL, { cache: "no-store" });
    if (!response.ok) return null;
    const etag = response.headers.get("etag");
    if (etag) return `${worker.scriptURL}|etag:${etag}`;
    return `${worker.scriptURL}|hash:${hashWorkerScript(await response.text())}`;
  } catch {
    // بلا بصمة نسخة موثوقة لا نغامر بمحاولة صامتة قد تتكرر بعد إعادة التحميل.
    return null;
  }
}

export function requestStorefrontPersistence(
  target: Pick<Window, "dispatchEvent"> = window,
): { attempted: number; ok: boolean; inFlight: boolean } {
  let attempted = 0;
  let ok = true;
  let inFlight = false;
  const event = new CustomEvent<{
    report: (saved: boolean, state?: { inFlight: boolean }) => void;
  }>(STOREFRONT_PERSIST_REQUEST_EVENT, {
    detail: {
      report(saved, state) {
        attempted += 1;
        ok = saved && ok;
        inFlight = inFlight || state?.inFlight === true;
      },
    },
  });
  target.dispatchEvent(event);
  return { attempted, ok, inFlight};
}

export function automaticStorefrontPersistenceIsSafe(result: {
  attempted: number;
  ok: boolean;
  inFlight: boolean;
}): boolean {
  return result.attempted > 0 && result.ok && !result.inFlight;
}

/**
 * عند نقر المستخدم يدوياً على «تحديث الآن» أو «إعادة المحاولة بأمان»، إذا أقرّ
 * العامل استلام skipWaiting أو دخل حالة activating لكن الصفحة الحالية ما زالت
 * تحتجز العامل القديم، فإن إعادة فتح الصفحة تحرر العميل القديم ليكتمل الانتقال
 * دون إغراق المستخدم في حلقة فشل يدوية. أما التحديث التلقائي الصامت فلا يعيد
 * التحميل عند انتهاء المهلة منعاً لحلقات التحميل التلقائية.
 */
export function shouldReloadAfterActivationTimeout(input: {
  manual: boolean;
  acknowledged: boolean;
  activeWorkerState?: ServiceWorkerState;
}): boolean {
  if (!input.manual) return false;
  return input.acknowledged || input.activeWorkerState === "activating";
}

