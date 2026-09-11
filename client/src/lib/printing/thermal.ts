// ناقل WebUSB للطابعات الحرارية. مُغلّف بحراسة قدرات المتصفّح؛ يعمل في Chrome/Edge
// فوق HTTPS أو localhost وبإذن المستخدم.
//
// **طابعتان بدورين:** "receipt" (إيصالات الكاشير — Epson، الدور الافتراضي) و"label"
// (ملصقات الباركود — HPRT). كل دور يحفظ جهازه ومنفذه ومعرّفه المحفوظ مستقلاً ⇒ ترسل
// الإيصالات لطابعة الإيصالات والملصقات لطابعة الملصقات في آنٍ واحد. كل الدوال تأخذ الدور
// كوسيط أخير افتراضه "receipt" ⇒ المنادون القدامى (الكاشير) بلا تغيير سلوك.
//
// **عزل الدورين (مهمّ للكاشير):** مع وجود طابعتين مُصرَّح بهما على نفس الأصل، إعادة الربط
// الصامتة **تُلزِم مطابقة الجهاز المحفوظ** متى وُجد محفوظ (لكلا الدورين) لئلا يخطف دورٌ طابعة
// الآخر (مثلاً إيصالٌ يُطبع على طابعة الملصقات ٥٨مم). بلا محفوظ: الإيصالات تربط أوّل جهاز
// صالح (سلوك أوّل ربط)، والملصقات لا تربط شيئاً تلقائياً (تتطلّب ربطاً يدوياً). ولا نطمس
// المعرّف المحفوظ في إعادة الربط (نحفظ فقط عند الربط اليدوي pairPrinter).
//
// الربط التلقائي: WebUSB يحفظ إذن الجهاز للأصل بعد أوّل ربط يدوي، فـgetDevices() يُرجِع
// الطابعة المُصرَّح بها بلا نافذة اختيار. عند فصل الجهاز يُصفَّر دوره (مستمع disconnect)
// ليعكس isPaired الواقع ويُعاد الربط لاحقاً.

export type PrinterRole = "receipt" | "label";

interface Slot {
  device: any;
  endpointOut: number | null;
}

const slots: Record<PrinterRole, Slot> = {
  receipt: { device: null, endpointOut: null },
  label: { device: null, endpointOut: null },
};

// المفتاح "thermalPrinter.default" مُبقىً للإيصالات للتوافق الخلفي (طابعة مربوطة سابقاً).
const LS_KEY: Record<PrinterRole, string> = {
  receipt: "thermalPrinter.default",
  label: "thermalPrinter.label",
};

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).usb;
}

export function isPaired(role: PrinterRole = "receipt"): boolean {
  const s = slots[role];
  return !!s.device && s.endpointOut != null;
}

function rememberDevice(role: PrinterRole, dev: any): void {
  try {
    localStorage.setItem(LS_KEY[role], JSON.stringify({ vendorId: dev.vendorId, productId: dev.productId }));
  } catch {
    /* localStorage غير متاح ⇒ نتجاهل (الربط يبقى يعمل لهذه الجلسة) */
  }
}

function readRemembered(role: PrinterRole): { vendorId: number; productId: number } | null {
  try {
    const raw = localStorage.getItem(LS_KEY[role]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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

/** هل هذا الجهاز مربوط أصلاً في الدور الآخر؟ (نمنع ادّعاء نفس الطابعة لدورين). */
function claimedByOtherRole(role: PrinterRole, dev: any): boolean {
  const other = role === "receipt" ? "label" : "receipt";
  return sameDevice(slots[other].device, dev);
}

/** يصفّر أيّ دور يحمل هذا الجهاز (عند فشل النقل أو فصل الجهاز) ليُعاد ربطه. */
function resetSlotsForDevice(dev: any): void {
  (Object.keys(slots) as PrinterRole[]).forEach((r) => {
    if (sameDevice(slots[r].device, dev)) slots[r] = { device: null, endpointOut: null };
  });
}

// مستمع فصل لمرّة واحدة: عند نزع طابعة يُصفَّر دورها فيعود isPaired صادقاً ويُعاد الربط لاحقاً.
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

/** يفتح الجهاز ويُهيّئ منفذ الإخراج (bulk OUT). يضبط slot الدور عند النجاح. */
async function claimDevice(role: PrinterRole, dev: any): Promise<boolean> {
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
  slots[role].device = dev;
  slots[role].endpointOut = out;
  return true;
}

/** يطلب من المستخدم اختيار طابعة USB للدور المحدّد ويُهيّئها. يُستدعى ضمن تفاعل مستخدم. */
export async function pairPrinter(role: PrinterRole = "receipt"): Promise<boolean> {
  if (!isWebUsbSupported()) {
    throw new Error("المتصفّح لا يدعم WebUSB — استخدم Chrome أو Edge");
  }
  ensureDisconnectListener();
  const usb = (navigator as any).usb;
  const dev = await usb.requestDevice({ filters: [] });
  // امنع ربط نفس الجهاز الفيزيائي لدورين (يتشاركان مقبضاً واحداً ⇒ فساد متبادل).
  if (claimedByOtherRole(role, dev)) {
    throw new Error("هذا الجهاز مربوط أصلاً بدور الطابعة الأخرى — اختر طابعة مختلفة لكل دور.");
  }
  let ok = false;
  try {
    ok = await claimDevice(role, dev);
  } catch {
    throw new Error("تعذّر فتح الطابعة (قد تكون مستخدَمة من تطبيق آخر أو تحتاج تعريف WinUSB عبر Zadig).");
  }
  if (!ok) {
    throw new Error("لم يُعثر على منفذ طباعة USB مناسب على هذا الجهاز");
  }
  rememberDevice(role, dev);
  return true;
}

/**
 * إعادة ربط صامتة بلا نافذة اختيار:
 * - متى وُجد جهاز محفوظ للدور: يُفحص أولاً لمطابقته وربطه فوراً.
 * - بالنسبة لدور الإيصالات ("receipt"): إن لم يتطابق الجهاز المحفوظ (مثلاً تم استبدال الطابعة بموديل حراري آخر
 *   أو توصيل طابعة حرارية جديدة مثل POS-80 / Rongta / Xprinter / Epson عبر Zadig WinUSB):
 *   يتم فحص باقي الأجهزة المصرّح بها في المتصفّح (التي لم تُحجز لدور الملصقات) وربط أول جهاز صالح وتثبيته.
 * - بالنسبة لدور الملصقات ("label"): يُلزم مطابقة الجهاز المحفوظ لئلا يطبع ملصقات 50مم على ورق إيصالات 80مم.
 * يُرجِع false بهدوء إن لم يتوفر جهاز مناسب — لا يرمي.
 */
export async function tryReconnectPrinter(role: PrinterRole = "receipt"): Promise<boolean> {
  if (!isWebUsbSupported()) return false;
  if (isPaired(role)) return true;
  ensureDisconnectListener();
  let devices: any[] = [];
  try {
    devices = await (navigator as any).usb.getDevices();
  } catch {
    return false;
  }
  if (!devices.length) return false;

  const remembered = readRemembered(role);

  // ١) المحاولة الأولى: رتّب الأجهزة بحيث يُفحص المطابق للمحفوظ أولاً
  if (remembered) {
    devices.sort((a, b) => {
      const am = a.vendorId === remembered.vendorId && a.productId === remembered.productId ? 0 : 1;
      const bm = b.vendorId === remembered.vendorId && b.productId === remembered.productId ? 0 : 1;
      return am - bm;
    });

    for (const dev of devices) {
      const matches = dev.vendorId === remembered.vendorId && dev.productId === remembered.productId;
      if (!matches) continue;
      if (claimedByOtherRole(role, dev)) continue;
      try {
        if (await claimDevice(role, dev)) {
          return true;
        }
      } catch {
        /* جرّب الجهاز التالي */
      }
    }
  }

  // ٢) المحاولة الثانية: لدور الإيصالات، إن لم يتطابق المحفوظ (أو لم يكن هناك محفوظ)، اربط أول جهاز صالح غير محجوز
  if (role === "receipt") {
    for (const dev of devices) {
      if (claimedByOtherRole(role, dev)) continue;
      try {
        if (await claimDevice(role, dev)) {
          rememberDevice(role, dev); // ثبّت كطابعة إيصالات افتراضية للمستقبل
          return true;
        }
      } catch {
        /* جرّب الجهاز التالي */
      }
    }
  }

  return false;
}

export async function sendBytes(bytes: Uint8Array, role: PrinterRole = "receipt"): Promise<void> {
  const s = slots[role];
  if (!s.device || s.endpointOut == null) throw new Error("لا توجد طابعة حرارية مربوطة");
  try {
    await s.device.transferOut(s.endpointOut, bytes);
  } catch (e) {
    // فشل النقل (غالباً جهاز مفصول) ⇒ صفّر الدور ليعكس isPaired الواقع ويُعاد الربط.
    resetSlotsForDevice(s.device);
    throw e;
  }
}
