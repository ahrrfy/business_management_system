/* ============================================================================
 * طابور أوامر الخادم→الجهاز (server/services/hrDevices/commands.ts)
 * الجهاز خلف NAT يبادر بالاتصال ⇒ الأوامر تُصفّ في hrDeviceCommands وتُدفع إليه
 * لحظة توفر وصلة حية (aiface) أو عند نبضة getrequest (iclock). أمر واحد قيد
 * التنفيذ لكل جهاز — البروتوكول طلب/استجابة متسلسل على مقبس واحد.
 * ========================================================================== */
import { and, asc, eq, sql } from "drizzle-orm";
import { hrDeviceCommands } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import { getLink } from "./registry";
import type { DeviceCommandName, DeviceLink } from "./types";
import { DEVICE_COMMANDS, baghdadNow } from "./types";

/** الأوامر المدعومة لكل بروتوكول — iclock النصي يدعم رقعة أضيق حالياً (تتوسع مع جهاز حقيقي). */
export const PROTOCOL_COMMANDS: Record<string, readonly DeviceCommandName[]> = {
  AIFACE_WS: DEVICE_COMMANDS,
  ZKTECO_PUSH: ["getnewlog", "getalllog", "reboot"],
};

// بوابة claims مشتركة للبروتوكولين. إغلاقها عند SIGTERM يمنع Aiface وiClock معاً
// من تحويل queued→sent بينما يجري تصريف bridge وقبل closeDb.
let commandClaimsAccepting = true;
const activeCommandPumps = new Set<Promise<void>>();
/** بعد هذه المهلة يصبح أمر iclock بلا رد قابلاً للاسترداد عند النبضة التالية. */
export const ICLOCK_COMMAND_LEASE_SECONDS = 300;

function canUseLink(deviceId: number, link: DeviceLink): boolean {
  return commandClaimsAccepting && getLink(deviceId) === link;
}

export async function enqueueCommand(
  deviceId: number,
  cmd: DeviceCommandName,
  payload: Record<string, unknown> | null,
  createdBy: number | null
): Promise<number> {
  const db = requireDb();
  const [res] = await db.insert(hrDeviceCommands).values({
    deviceId,
    cmd,
    payload: payload ?? null,
    status: "queued",
    createdBy,
  });
  const id = Number((res as { insertId?: number }).insertId ?? 0);
  // إن كان الجهاز متصلاً الآن (aiface) ندفع فوراً — وإلا تلتقطه نبضته القادمة.
  pumpCommands(deviceId);
  return id;
}

/** رسالة aiface السلكية لأمر مصفوف. */
export function buildAifaceCommand(cmd: string, payload: unknown): Record<string, unknown> {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  switch (cmd) {
    case "settime":
      return { cmd, cloudtime: baghdadNow() };
    case "getalllog":
    case "getnewlog":
    case "getuserlist":
      return { cmd, stn: true };
    case "getuserinfo":
      return { cmd, enrollid: p.enrollid, backupnum: p.backupnum ?? 0 };
    default:
      return { cmd, ...p };
  }
}

async function runCommandPump(deviceId: number, link: DeviceLink): Promise<void> {
  const db = requireDb();
  // ادّعاء ذرّي: قد يتسابق نداءان (enqueue متتاليان) فيختاران نفس الصفّ الأقدم. المطالبة
  // بـUPDATE مشروط status='queued' تضمن فائزاً واحداً (affectedRows=1) فلا يُرسَل أمرٌ مرتين.
  for (let guard = 0; guard < 50; guard++) {
    if (!canUseLink(deviceId, link) || link.inflight) return;
    const [next] = await db
      .select()
      .from(hrDeviceCommands)
      .where(and(eq(hrDeviceCommands.deviceId, deviceId), eq(hrDeviceCommands.status, "queued")))
      .orderBy(asc(hrDeviceCommands.id))
      .limit(1);
    if (!next || !canUseLink(deviceId, link) || link.inflight) return;
    const res = await db
      .update(hrDeviceCommands)
      .set({ status: "sent", sentAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(hrDeviceCommands.id, next.id), eq(hrDeviceCommands.status, "queued")));
    const claimed = (res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
    if (claimed !== 1) continue;

    // قد يُغلق المقبس أو يبدأ shutdown أثناء await UPDATE. أعد الصف فوراً ولا ترسل
    // إلى وصلة ميتة؛ هذا الفحص وما بعده متزامنان فلا تتداخل بينهما دورة event-loop.
    if (!canUseLink(deviceId, link) || link.inflight) {
      await db
        .update(hrDeviceCommands)
        .set({ status: "queued", sentAt: null })
        .where(and(eq(hrDeviceCommands.id, next.id), eq(hrDeviceCommands.status, "sent")));
      return;
    }
    link.inflight = { commandId: next.id, cmd: next.cmd, received: 0, expected: null };
    link.send(buildAifaceCommand(next.cmd, next.payload));
    logger.info({ deviceId, cmd: next.cmd, commandId: next.id }, "hrDevices: أمر أُرسل للجهاز");
    return;
  }
}

/** دفع الأمر التالي لجهاز متصل (aiface) — تُستدعى بعد التسجيل وبعد اكتمال كل أمر. */
export function pumpCommands(deviceId: number): void {
  if (!commandClaimsAccepting) return;
  const link = getLink(deviceId);
  if (!link || link.inflight) return;
  let tracked!: Promise<void>;
  tracked = runCommandPump(deviceId, link)
    .catch((e) => logger.error({ err: e, deviceId }, "hrDevices: فشل دفع أمر"))
    .finally(() => activeCommandPumps.delete(tracked));
  activeCommandPumps.add(tracked);
}

/** يغلق بوابة claims للبروتوكولين نهائياً وينتظر مضخات Aiface الجارية. */
export async function stopAndDrainCommandPumps(): Promise<void> {
  commandClaimsAccepting = false;
  while (activeCommandPumps.size > 0) {
    await Promise.all(Array.from(activeCommandPumps));
  }
}

/** إتمام الأمر الجاري على وصلة (نجاحاً أو فشلاً) ثم دفع التالي. */
export async function completeInflight(
  link: DeviceLink,
  ok: boolean,
  result: unknown,
  error?: string
): Promise<void> {
  const inflight = link.inflight;
  if (!inflight) return;
  link.inflight = null;
  const db = requireDb();
  await db
    .update(hrDeviceCommands)
    .set({
      status: ok ? "done" : "failed",
      result: result ?? null,
      error: error ?? null,
      doneAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(hrDeviceCommands.id, inflight.commandId));
  pumpCommands(link.deviceId);
}

/** انقطاع الوصلة والأمر جارٍ ⇒ يعود queued ليُعاد إرساله عند الاتصال التالي (لا أمر يضيع). */
export async function requeueInflight(link: DeviceLink): Promise<void> {
  const inflight = link.inflight;
  if (!inflight) return;
  link.inflight = null;
  const db = requireDb();
  await db
    .update(hrDeviceCommands)
    .set({ status: "queued", sentAt: null })
    .where(and(eq(hrDeviceCommands.id, inflight.commandId), eq(hrDeviceCommands.status, "sent")));
}

/**
 * اتصال aiface جديد = لا ردّ قادم لأي أمر sent سابق (المقبس القديم مات أو العملية أُعيد تشغيلها)
 * ⇒ تُعاد كلها queued فتُرسل من جديد. لا تُستدعى لمسار iclock (ردّه يأتي بطلب HTTP مستقل).
 */
export async function requeueStaleSentCommands(deviceId: number): Promise<void> {
  const db = requireDb();
  await db
    .update(hrDeviceCommands)
    .set({ status: "queued", sentAt: null })
    .where(and(eq(hrDeviceCommands.deviceId, deviceId), eq(hrDeviceCommands.status, "sent")));
}

type CommandDb = ReturnType<typeof requireDb>;

async function requeueIclockCommandWithDb(
  db: CommandDb,
  deviceId: number,
  commandId: number,
): Promise<void> {
  await db
    .update(hrDeviceCommands)
    .set({ status: "queued", sentAt: null })
    .where(
      and(
        eq(hrDeviceCommands.id, commandId),
        eq(hrDeviceCommands.deviceId, deviceId),
        eq(hrDeviceCommands.status, "sent"),
      ),
    );
}

/** يعيد claim لم يصل إلى الجهاز بسبب abort/انقطاع HTTP؛ الشرط يمنع قلب أمر اكتمل بالتزامن. */
export async function requeueIclockCommand(
  deviceId: number,
  commandId: number,
): Promise<void> {
  await requeueIclockCommandWithDb(requireDb(), deviceId, commandId);
}

/** iclock: التقاط الأمر التالي عند نبضة getrequest ضمن lease قابلة للاسترداد. */
export async function popIclockCommand(
  deviceId: number,
  signal?: AbortSignal,
): Promise<{ id: number; cmd: string } | null> {
  if (!commandClaimsAccepting || signal?.aborted) return null;
  const db = requireDb();
  // انقطاع الطلب بعد إرسال الأمر قد يمنع devicecmd إلى الأبد. كل نبضة تسترد claims
  // المنتهية أولاً، فتضمن at-least-once بدلاً من صف sent يتيم بلا حد.
  await db
    .update(hrDeviceCommands)
    .set({ status: "queued", sentAt: null })
    .where(
      and(
        eq(hrDeviceCommands.deviceId, deviceId),
        eq(hrDeviceCommands.status, "sent"),
        sql`(${hrDeviceCommands.sentAt} IS NULL OR ${hrDeviceCommands.sentAt} < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${ICLOCK_COMMAND_LEASE_SECONDS} SECOND))`,
      ),
    );
  if (!commandClaimsAccepting || signal?.aborted) return null;

  // ادّعاء ذرّي مطابق لـpumpCommands: نبضتا getrequest متزامنتان لا تلتقطان نفس الأمر مرتين.
  for (let guard = 0; guard < 50; guard++) {
    if (!commandClaimsAccepting || signal?.aborted) return null;
    const [next] = await db
      .select({ id: hrDeviceCommands.id, cmd: hrDeviceCommands.cmd })
      .from(hrDeviceCommands)
      .where(and(eq(hrDeviceCommands.deviceId, deviceId), eq(hrDeviceCommands.status, "queued")))
      .orderBy(asc(hrDeviceCommands.id))
      .limit(1);
    if (!next || !commandClaimsAccepting || signal?.aborted) return null;
    const res = await db
      .update(hrDeviceCommands)
      .set({ status: "sent", sentAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(hrDeviceCommands.id, next.id), eq(hrDeviceCommands.status, "queued")));
    const claimed = (res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
    if (claimed !== 1) continue;
    if (!commandClaimsAccepting || signal?.aborted) {
      await requeueIclockCommandWithDb(db, deviceId, next.id);
      return null;
    }
    return next;
  }
  return null;
}

/** iclock: إتمام أمر بمعرّفه من ردّ devicecmd (Return=0 نجاح). */
export async function completeIclockCommand(
  deviceId: number,
  commandId: number,
  returnCode: number,
): Promise<boolean> {
  const db = requireDb();
  const result = await db
    .update(hrDeviceCommands)
    .set({
      status: returnCode === 0 ? "done" : "failed",
      result: { returnCode },
      error: returnCode === 0 ? null : `الجهاز أعاد رمز ${returnCode}`,
      doneAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(hrDeviceCommands.id, commandId),
        eq(hrDeviceCommands.deviceId, deviceId),
        eq(hrDeviceCommands.status, "sent"),
      ),
    );
  const affectedRows = (result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
  return affectedRows === 1;
}
