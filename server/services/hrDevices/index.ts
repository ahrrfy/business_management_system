/* برميل حزمة جسر أجهزة الحضور — الاستهلاك الخارجي (راوتر/جسر/اختبارات) من هنا حصراً. */
export { startHrDeviceBridge } from "./bridge";
export { createAifaceSession } from "./aifaceDriver";
export { handleIclock, parseAttlog, parseOperlogUsers, formatIclockCommand } from "./iclockDriver";
export { ingestPunches, upsertDeviceUser, mapDeviceUserToEmployee } from "./punchStore";
export { processPendingFolds, foldSoon } from "./attendanceFold";
export {
  enqueueCommand,
  buildAifaceCommand,
  completeIclockCommand,
  popIclockCommand,
  PROTOCOL_COMMANDS,
} from "./commands";
export { resolveDeviceBySn, touchDevice, onlineDeviceIds, sweepOffline } from "./registry";
export { DEVICE_COMMANDS, baghdadNow, normalizePunchTime } from "./types";
export type { RawPunch, RawDeviceUser, DeviceCommandName } from "./types";
