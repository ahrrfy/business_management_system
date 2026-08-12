export type PwaUpdateAction =
  | "ACTIVATE_WAITING"
  | "RELOAD_ACTIVE"
  | "CHECK_AGAIN"
  | "UNAVAILABLE";

export type PwaRegistrationState = {
  hasRegistration: boolean;
  hasWaitingWorker: boolean;
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
  if (state.hasWaitingWorker) return "ACTIVATE_WAITING";
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
          if (retryTimer) clearTimeout(retryTimer);
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
  // إعادة واحدة توقظ بعض WebViews التي جمّدت العامل فور انتقال التطبيق للخلفية.
  retryTimer = setTimeout(() => {
    try {
      worker.postMessage({ type: "SKIP_WAITING" });
    } catch {
      // الانتقال إلى activated/redundant قبل المؤقت يجعل الإرسال غير لازم.
    }
  }, 3_000);
  return () => {
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
  if (worker.state === "activated" || registration.active === worker) {
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
      if (registration.active === worker || worker.state === "activated") {
        finish("activated");
        return;
      }

      // إن أصبح عامل آخر active أثناء المحاولة، فالغاية تحققت بإصدار أحدث.
      if (registration.active && registration.active !== previousActive) {
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
            finish("activated");
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

    const worker = registration.waiting;
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
