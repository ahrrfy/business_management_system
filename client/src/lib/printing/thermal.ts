// ناقل WebUSB للطابعات الحرارية. مُغلّف بحراسة قدرات المتصفّح؛ يعمل في Chrome/Edge فوق HTTPS أو localhost.
//
// **معمّم لـN طابعة بمفتاح ملفّ (profileId):** بدل دورين جامدين، تُحفظ فتحة لكل ملفّ طابعة في خريطة.
// كل ملفّ webusb يحمل usb {vendorId,productId,serial?} في سجلّ الملفّات (printerProfiles.ts) ⇒ إعادة ربط
// صامتة بالمطابقة، وعزلٌ بين الطابعات (لا يخطف ملفٌّ طابعة آخر).
//
// **توافق خلفي تامّ:** الدوال القديمة (isPaired/pairPrinter/tryReconnectPrinter/sendBytes) تبقى وتُحوَّل
// إلى الملفّ المُسنَد للمهمة (receipt↔RECEIPT, label↔LABEL) عبر resolveProfile ⇒ المؤشّر في الواجهة
// والطباعة الفعلية يعملان على **نفس الفتحة** (لا انحراف). الربط اليدوي القديم يُنشئ/يحدّث ملفّاً حقيقياً.

import {
  resolveProfile,
  upsertProfile,
  setAssignment,
  LEGACY_RECEIPT_ID,
  type PrinterProfile,
  type PrinterUsbId,
  type PrintPurpose,
} from "./printerProfiles";
import { getLabelSize } from "./labelSize";

export type PrinterRole = "receipt" | "label";

interface Slot {
  device: any;
  endpointOut: number | null;
}

/** فتحة لكل ملفّ طابعة (المفتاح = profile.id). */
const slots = new Map<string, Slot>();

function slotOf(key: string): Slot {
  let s = slots.get(key);
  if (!s) {
    s = { device: null, endpointOut: null };
    slots.set(key, s);
  }
  return s;
}

// مفاتيح قديمة للكتابة عند الربط (rollback-safe — تبقى مقروءة من الإصدار القديم).
const LEGACY_LS: Record<PrinterRole, string> = {
  receipt: "thermalPrinter.default",
  label: "thermalPrinter.label",
};

function roleToPurpose(role: PrinterRole): PrintPurpose {
  return role === "label" ? "LABEL" : "RECEIPT";
}

function rememberLegacy(role: PrinterRole, usb: PrinterUsbId): void {
  try {
    localStorage.setItem(LEGACY_LS[role], JSON.stringify({ vendorId: usb.vendorId, productId: usb.productId }));
  } catch {
    /* تجاهل */
  }
}

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).usb;
}

/** هل ملفّ الطابعة (webusb) مربوط في الذاكرة؟ */
export function isPairedProfile(key: string): boolean {
  const s = slots.get(key);
  return !!s && !!s.device && s.endpointOut != null;
}

/** هل (a) و(b) نفس الجهاز الفيزيائي؟ (مرجعاً، أو بمطابقة vid/pid/الرقم التسلسلي). */
function sameDevice(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    (a.serialNumber ?? "") === (b.serialNumber ?? "")
  );
}

/** هل هذا الجهاز مربوط أصلاً في ملفّ آخر؟ (نمنع ادّعاء نفس الطابعة لملفّين). */
function claimedByOtherProfile(key: string, dev: any): boolean {
  let claimed = false;
  slots.forEach((s, k) => {
    if (!claimed && k !== key && sameDevice(s.device, dev)) claimed = true;
  });
  return claimed;
}

/** يصفّر أيّ فتحة تحمل هذا الجهاز (عند فشل النقل أو فصل الجهاز) ليُعاد ربطه. */
function resetSlotsForDevice(dev: any): void {
  slots.forEach((s, k) => {
    if (sameDevice(s.device, dev)) slots.set(k, { device: null, endpointOut: null });
  });
}

// مستمع فصل لمرّة واحدة: عند نزع طابعة تُصفَّر فتحتها فيعود isPaired صادقاً ويُعاد الربط لاحقاً.
let disconnectHooked = false;
function ensureDisconnectListener(): void {
  if (disconnectHooked || !isWebUsbSupported()) return;
  disconnectHooked = true;
  try {
    (navigator as any).usb.addEventListener("disconnect", (e: any) => {
      if (e && e.device) resetSlotsForDevice(e.device);
    });
  } catch {
    /* تجاهل — البيئة لا تدعم المستمع */
  }
}

/** يفتح الجهاز ويُهيّئ منفذ الإخراج (bulk OUT). يضبط فتحة المفتاح عند النجاح. */
async function claimDevice(key: string, dev: any): Promise<boolean> {
  await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);

  let out: number | null = null;
  for (const iface of dev.configuration.interfaces) {
    const alt = iface.alternate ?? iface.alternates?.[0];
    const ep = alt?.endpoints?.find((e: any) => e.direction === "out" && e.type === "bulk");
    if (ep) {
      await dev.claimInterface(iface.interfaceNumber);
      out = ep.endpointNumber;
      break;
    }
  }
  if (out == null) {
    try { await dev.close(); } catch { /* تجاهل */ }
    return false;
  }
  slotOf(key).device = dev;
  slotOf(key).endpointOut = out;
  return true;
}

function devUsbId(dev: any): PrinterUsbId {
  return { vendorId: dev.vendorId, productId: dev.productId, serial: dev.serialNumber || undefined };
}

/**
 * يطلب من المستخدم اختيار طابعة USB لملفّ محدّد ويُهيّئها. يُستدعى ضمن تفاعل مستخدم.
 * يعيد معرّفات USB (ليحفظها سجلّ الملفّات) — مصدر الحقيقة للحفظ هو printerProfiles.
 */
export async function pairPrinterProfile(key: string): Promise<PrinterUsbId> {
  if (!isWebUsbSupported()) {
    throw new Error("المتصفّح لا يدعم WebUSB — استخدم Chrome أو Edge");
  }
  ensureDisconnectListener();
  const usb = (navigator as any).usb;
  const dev = await usb.requestDevice({ filters: [] });
  if (claimedByOtherProfile(key, dev)) {
    throw new Error("هذا الجهاز مربوط أصلاً بملفّ طابعة آخر — اختر طابعة مختلفة لكل ملفّ.");
  }
  let ok = false;
  try {
    ok = await claimDevice(key, dev);
  } catch {
    throw new Error("تعذّر فتح الطابعة (قد تكون مستخدَمة من تطبيق آخر أو تحتاج تعريف WinUSB عبر Zadig).");
  }
  if (!ok) throw new Error("لم يُعثر على منفذ طباعة USB مناسب على هذا الجهاز");
  return devUsbId(dev);
}

/**
 * إعادة ربط صامتة لملفّ webusb بلا نافذة اختيار:
 * - متى وُجد usb على الملفّ ⇒ **يُلزَم مطابقته** لئلا يخطف ملفٌّ طابعة آخر.
 * - الإيصال القديم (LEGACY_RECEIPT_ID) بلا usb ⇒ يقبل أوّل جهاز صالح (سلوك أوّل ربط) ويحفظه.
 * يُرجِع false بهدوء إن لا جهاز مناسب — لا يرمي.
 */
export async function tryReconnectProfile(profile: PrinterProfile): Promise<boolean> {
  if (!isWebUsbSupported() || profile.transport !== "webusb") return false;
  const key = profile.id;
  if (isPairedProfile(key)) return true;
  ensureDisconnectListener();

  let devices: any[] = [];
  try {
    devices = await (navigator as any).usb.getDevices();
  } catch {
    return false;
  }
  if (!devices.length) return false;

  const want = profile.usb;
  const allowFirst = !want && profile.id === LEGACY_RECEIPT_ID;
  const requireMatch = !!want;

  if (want) {
    devices.sort((a, b) => {
      const am = a.vendorId === want.vendorId && a.productId === want.productId ? 0 : 1;
      const bm = b.vendorId === want.vendorId && b.productId === want.productId ? 0 : 1;
      return am - bm;
    });
  }

  for (const dev of devices) {
    const matches =
      !!want &&
      dev.vendorId === want.vendorId &&
      dev.productId === want.productId &&
      (want.serial ? (dev.serialNumber ?? "") === want.serial : true);
    if (requireMatch && !matches) continue;
    if (!want && !allowFirst) continue;
    if (claimedByOtherProfile(key, dev)) continue;
    try {
      if (await claimDevice(key, dev)) {
        if (!want && allowFirst) rememberLegacy("receipt", devUsbId(dev)); // ثبّت أوّل ربط
        return true;
      }
    } catch {
      /* جرّب الجهاز التالي */
    }
  }
  return false;
}

/** إرسال بايتات لملفّ webusb بالمفتاح. */
export async function sendBytesProfile(key: string, bytes: Uint8Array): Promise<void> {
  const s = slots.get(key);
  if (!s || !s.device || s.endpointOut == null) throw new Error("لا توجد طابعة حرارية مربوطة لهذا الملفّ");
  try {
    await s.device.transferOut(s.endpointOut, bytes);
  } catch (e) {
    resetSlotsForDevice(s.device);
    throw e;
  }
}

// ── محوّلات الـAPI القديم (الدور → المهمة → الملفّ) ──────────────────────────────
// تُبقي مستدعي الكاشير (isPaired/pairPrinter/tryReconnectPrinter/sendBytes) يعملون كما هم،
// لكنهم الآن يعملون على **نفس** الملفّ الذي تستعمله مسارات الطباعة الجديدة ⇒ لا انحراف.

export function isPaired(role: PrinterRole = "receipt"): boolean {
  const p = resolveProfile(roleToPurpose(role));
  return !!p && p.transport === "webusb" && isPairedProfile(p.id);
}

export async function pairPrinter(role: PrinterRole = "receipt"): Promise<boolean> {
  const purpose = roleToPurpose(role);
  let prof = resolveProfile(purpose);
  // أنشئ ملفّاً حقيقياً إن لم يوجد ملفّ webusb مُسنَد (أو كان مُركَّباً عابراً).
  if (!prof || prof.transport !== "webusb" || prof.transient) {
    prof = upsertProfile({
      name: role === "label" ? "طابعة الملصقات" : "طابعة الإيصالات",
      transport: "webusb",
      purposes: role === "label" ? ["LABEL"] : ["RECEIPT", "ORDER_TICKET"],
      paper: role === "label" ? { ...getLabelSize(), dpmm: 8 } : undefined,
      outputFormat: "escpos",
    });
    setAssignment(purpose, prof.id);
    if (role !== "label") setAssignment("ORDER_TICKET", prof.id);
  }
  const usb = await pairPrinterProfile(prof.id);
  upsertProfile({ ...prof, usb });
  rememberLegacy(role, usb);
  return true;
}

export async function tryReconnectPrinter(role: PrinterRole = "receipt"): Promise<boolean> {
  const p = resolveProfile(roleToPurpose(role));
  if (!p || p.transport !== "webusb") return false;
  return tryReconnectProfile(p);
}

export async function sendBytes(bytes: Uint8Array, role: PrinterRole = "receipt"): Promise<void> {
  const p = resolveProfile(roleToPurpose(role));
  if (!p || p.transport !== "webusb") throw new Error("لا توجد طابعة حرارية مربوطة");
  return sendBytesProfile(p.id, bytes);
}
