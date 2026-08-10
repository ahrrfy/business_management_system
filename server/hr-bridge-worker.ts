/**
 * دورة حياة عامل جسر أجهزة الحضور.
 *
 * هذا الملف entrypoint مستقل يُجمَّع إلى dist/hr-bridge-worker.cjs. جميع الاستيرادات
 * ثابتة، لذلك توجد نسخة واحدة فقط من registry وDB داخل العملية ولا يوجد runtime TS loader.
 */
import { closeDb } from "./db";
import { logger } from "./logger";
import policy from "../scripts/hr-bridge-runtime-policy.cjs";
import { assertEnabledDeviceIdentityReadiness } from "./services/hrDevices/readiness";
import {
  assertHrDeviceBridgeStartupConfig,
  startHrDeviceBridge,
} from "./services/hrDevices/bridge";
import {
  pumpCommands,
  stopAndDrainCommandPumps,
} from "./services/hrDevices/commands";
import {
  foldSoon,
  stopAndDrainAttendanceFolds,
} from "./services/hrDevices/attendanceFold";
import { onlineDeviceIds } from "./services/hrDevices/registry";
import { resolveBridgeConfig } from "./services/hrDevices/types";

type WorkerResult = "running" | "disabled" | "preflight-complete";

export interface HrBridgeWorkerOptions {
  bootId: string;
  preflightOnly: boolean;
  databaseTimeoutMs: number;
  listenTimeoutMs: number;
  shutdownTimeoutMs: number;
  onReady: () => void;
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function assertManagedEnvironmentIsolated(): void {
  if (process.env.HR_BRIDGE_LOAD_DOTENV !== "0") {
    throw new Error("HR_BRIDGE_MANAGED_ENVIRONMENT_REQUIRED");
  }
  const allowed = new Set(policy.allowedEnvironmentKeys);
  const unexpected = Object.keys(process.env).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    // لا نطبع الأسماء أو القيم؛ العدد كافٍ للتشخيص ولا يوسّع كشف أسرار البيئة.
    throw new Error(`HR_BRIDGE_ENVIRONMENT_NOT_ISOLATED:${unexpected.length}`);
  }
}

export async function runHrBridgeWorker(
  options: HrBridgeWorkerOptions,
): Promise<WorkerResult> {
  const startedAt = Date.now();
  const checkpoint = (phase: string, details: Record<string, unknown> = {}) => {
    logger.info(
      {
        phase,
        bootId: options.bootId,
        pid: process.pid,
        elapsedMs: Date.now() - startedAt,
        ...details,
      },
      `hrDevices: ${phase}`,
    );
  };

  const cfg = resolveBridgeConfig();
  if (!cfg.enabled) {
    checkpoint("HR_BRIDGE_DISABLED");
    logger.info(
      "hrDevices: عامل الجسر غير مفعّل (اضبط HR_DEVICE_BRIDGE=1 أو HR_DEVICE_PORT)",
    );
    return "disabled";
  }

  assertHrDeviceBridgeStartupConfig(cfg.port);
  checkpoint("HR_BRIDGE_CONFIG_OK", { port: cfg.port });

  if (!options.preflightOnly) {
    assertManagedEnvironmentIsolated();
    checkpoint("HR_BRIDGE_ENVIRONMENT_OK");
  }

  checkpoint("HR_BRIDGE_DB_CHECK_START");
  await withTimeout(
    assertEnabledDeviceIdentityReadiness(),
    options.databaseTimeoutMs,
    "HR_BRIDGE_DB_READINESS_TIMEOUT",
  );
  checkpoint("HR_BRIDGE_DB_CHECK_OK");

  if (options.preflightOnly) {
    let probe: Awaited<ReturnType<typeof startHrDeviceBridge>> | null = null;
    try {
      // المنفذ 0 يجعل النواة تختار منفذاً عابراً: نثبت أن HR_DEVICE_HOST صالح
      // وأن العملية قادرة على bind بلا مزاحمة العامل القديم على منفذ الإنتاج.
      checkpoint("HR_BRIDGE_BIND_PROBE_START");
      probe = await startHrDeviceBridge(0, {
        listenTimeoutMs: options.listenTimeoutMs,
      });
      checkpoint("HR_BRIDGE_BIND_PROBE_OK");
    } finally {
      try {
        await probe?.stop();
      } finally {
        await withTimeout(
          closeDb(),
          options.databaseTimeoutMs,
          "HR_BRIDGE_DB_CLOSE_TIMEOUT",
        );
      }
    }
    checkpoint("HR_BRIDGE_PREFLIGHT_OK");
    return "preflight-complete";
  }

  checkpoint("HR_BRIDGE_LISTEN_START", { port: cfg.port });
  const bridge = await startHrDeviceBridge(cfg.port, {
    listenTimeoutMs: options.listenTimeoutMs,
  });
  checkpoint("HR_BRIDGE_LISTEN_OK", { port: cfg.port });

  // enqueueCommand يكتب من عمال الويب إلى DB، وهذه النبضة تجعل عملية المقبس الوحيدة
  // تلتقط الأوامر للأجهزة المتصلة. الاستيرادات الثابتة تضمن أنها خريطة bridge نفسها.
  const commandPump = setInterval(() => {
    for (const deviceId of onlineDeviceIds()) pumpCommands(deviceId);
  }, 1_000);
  commandPump.unref();

  let shuttingDown = false;
  async function shutdown(signal: string, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(commandPump);
    checkpoint("HR_BRIDGE_SHUTDOWN_START", { signal });

    // يبقى referenced كي يفرض سقف الإغلاق حتى لو علقت closeDb بعد إغلاق الخادم.
    const force = setTimeout(() => {
      checkpoint("HR_BRIDGE_SHUTDOWN_TIMEOUT", {
        timeoutMs: options.shutdownTimeoutMs,
      });
      process.exit(1);
    }, options.shutdownTimeoutMs);

    try {
      // أغلق بوابة claims لـAiface/iClock تزامنياً قبل أول await؛ ثم أوقف ingress وانتظر كل
      // جلسة/claim/sweep، وبعدها استنزف طيّ الحضور قبل إغلاق pool قاعدة البيانات.
      const commandDrain = stopAndDrainCommandPumps();
      await Promise.all([bridge.stop(), commandDrain]);
      await stopAndDrainAttendanceFolds();
      await closeDb();
      clearTimeout(force);
      checkpoint("HR_BRIDGE_SHUTDOWN_OK", { signal });
      process.exit(exitCode);
    } catch (error) {
      clearTimeout(force);
      logger.error(
        { err: error, signal, bootId: options.bootId },
        "hrDevices: فشل الإيقاف الرشيق لعامل الجسر",
      );
      process.exit(1);
    }
  }

  bridge.server.once("error", () => void shutdown("bridge-error", 1));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // ثبّت معالجات الإغلاق أولاً، ثم ابدأ reconciliation. بذلك لا توجد نافذة يشرع
  // فيها fold باستخدام DB قبل أن يصبح SIGTERM/SIGINT قادراً على استنزافه.
  foldSoon();

  // لا تُرسل الجاهزية إلا بعد نجاح DB وTCP وتثبيت معالجات الإغلاق ومضخة الأوامر.
  options.onReady();
  logger.info(
    { port: cfg.port, bootId: options.bootId },
    "hrDevices: بدأ عامل الجسر المستقل وأصبح جاهزاً",
  );
  return "running";
}
