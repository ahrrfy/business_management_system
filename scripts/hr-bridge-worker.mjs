/**
 * العملية الوحيدة المالكة لجسر أجهزة الحضور.
 *
 * تُشغَّل كـ PM2 fork واحد مستقل عن عنقود erp-server، لأن منفذ الأجهزة ووصلات
 * WebSocket حالتها حيّة داخل العملية ولا يجوز توزيعها بين عمّال الويب.
 */
import "dotenv/config";
import { tsImport } from "tsx/esm/api";

const { logger } = await tsImport("../server/logger.ts", import.meta.url);
const { closeDb } = await tsImport("../server/db.ts", import.meta.url);
const { startHrDeviceBridge } = await tsImport(
  "../server/services/hrDevices/bridge.ts",
  import.meta.url,
);
const { pumpCommands } = await tsImport(
  "../server/services/hrDevices/commands.ts",
  import.meta.url,
);
const { onlineDeviceIds } = await tsImport(
  "../server/services/hrDevices/registry.ts",
  import.meta.url,
);
const { resolveBridgeConfig } = await tsImport(
  "../server/services/hrDevices/types.ts",
  import.meta.url,
);
const { assertEnabledDeviceIdentityReadiness } = await tsImport(
  "../server/services/hrDeviceService.ts",
  import.meta.url,
);

const cfg = resolveBridgeConfig();
if (!cfg.enabled) {
  logger.info(
    "hrDevices: عامل الجسر غير مفعّل (اضبط HR_DEVICE_BRIDGE=1 أو HR_DEVICE_PORT)",
  );
  process.exit(0);
}

try {
  await assertEnabledDeviceIdentityReadiness();
} catch (error) {
  logger.error(
    { err: error },
    "hrDevices: فشل تدقيق ربط هويات الأجهزة المفعّلة قبل فتح المنفذ",
  );
  process.exit(1);
}

const bridge = startHrDeviceBridge(cfg.port);
if (!bridge) {
  logger.error("hrDevices: تعذّر إنشاء عامل الجسر المستقل");
  process.exit(1);
}

// enqueueCommand يُكتب من أي عامل ويب إلى قاعدة البيانات. هذه النبضة تجعل
// العملية المالكة للمقبس تلتقط الأمر سريعاً حتى إن كان الجهاز متصلاً وخاملاً.
const commandPump = setInterval(() => {
  for (const deviceId of onlineDeviceIds()) pumpCommands(deviceId);
}, 1_000);
commandPump.unref();

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(commandPump);
  logger.info({ signal }, "hrDevices: إيقاف عامل الجسر المستقل");

  const force = setTimeout(() => {
    logger.error("hrDevices: تجاوز مهلة إيقاف عامل الجسر (10ث)");
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    await bridge.stop();
    await closeDb();
    clearTimeout(force);
    process.exit(exitCode);
  } catch (error) {
    logger.error({ err: error }, "hrDevices: فشل الإيقاف الرشيق لعامل الجسر");
    process.exit(1);
  }
}

// فشل الاستماع (مثل EADDRINUSE) يجب أن يُسقط العملية كي يعيد PM2 تشغيلها؛
// الاكتفاء بسجل خطأ يترك عملية تبدو online بينما منفذ 7788 متوقف.
bridge.server.once("error", () => void shutdown("bridge-error", 1));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info(
  { port: cfg.port },
  "hrDevices: بدأ عامل الجسر المستقل (عملية واحدة)",
);
