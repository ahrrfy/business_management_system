// سجلّ ملفّات الطابعات — **محلي لكل جهاز** (localStorage)، مصدر الحقيقة لتخصيص الطابعات.
//
// الفكرة: التطبيق يعرف **المهمة** فقط (RECEIPT/LABEL/ORDER_TICKET/DOCUMENT)، وكل جهاز يُعرّف
// **ملفّات طابعات مُسمّاة** ويُسند كل مهمة لملفّ. كل ملفّ يحمل:
//   - الناقل (transport): webusb (USB مباشر) / bridge (جسر محلي بالاسم) / browser (حوار الطباعة).
//   - صيغة الإخراج (outputFormat): escpos الآن؛ zpl/epl مقبس مستقبلي (يُولَّد client-side عند وصول Zebra/TSC).
//   - ربط الجهاز: usb {vendorId,productId,serial?} لـwebusb، أو bridgePrinterName لـbridge.
//
// **عام وشامل لكل الطابعات** — لا vendorId/productId مثبّت، لا موديل بعينه. الوحدة نقيّة بلا DOM
// (قابلة للاختبار في node كـlabelSize.ts): كل وصول لـlocalStorage داخل try/catch ولا يرمي.
//
// التوافق الخلفي: الدوران القديمان (receipt/label) يُحوَّلان لمهمتَي RECEIPT/LABEL عبر resolveProfile،
// وهجرة لمرّة واحدة تستورد thermalPrinter.default/.label + labelSize إلى ملفّات حقيقية ⇒ صفر انحدار.

import { getLabelSize } from "./labelSize";

export type PrintPurpose = "RECEIPT" | "LABEL" | "ORDER_TICKET" | "DOCUMENT";
export type PrintTransport = "webusb" | "bridge" | "browser";
/** لغة/صيغة الإخراج. escpos فعّال الآن؛ zpl/epl مقبس مستقبلي. */
export type PrintOutputFormat = "escpos" | "zpl" | "epl";

export interface PrinterPaper {
  widthMm: number;
  heightMm?: number;
  /** كثافة الطباعة (نقاط/مم): 8 ≈ 203dpi. */
  dpmm: number;
}

export interface PrinterUsbId {
  vendorId: number;
  productId: number;
  serial?: string;
}

export interface PrinterProfile {
  id: string;
  name: string;
  transport: PrintTransport;
  /** المهام التي يصلح لها هذا الملف (إرشادي للواجهة؛ الإسناد هو المُحدِّد الفعلي). */
  purposes: PrintPurpose[];
  /** ربط WebUSB (transport==="webusb"). */
  usb?: PrinterUsbId;
  /** اسم طابعة Windows من الجسر (transport==="bridge"). */
  bridgePrinterName?: string;
  paper?: PrinterPaper;
  outputFormat: PrintOutputFormat;
  createdAt: number;
  updatedAt: number;
  /** ملفّ مُركَّب عابر (رجوع للقديم) — غير محفوظ. لا يظهر في القوائم. */
  transient?: boolean;
}

export type AssignmentMap = Partial<Record<PrintPurpose, string | null>>;

export const ALL_PURPOSES: readonly PrintPurpose[] = [
  "RECEIPT",
  "LABEL",
  "ORDER_TICKET",
  "DOCUMENT",
];

export const PURPOSE_LABEL_AR: Record<PrintPurpose, string> = {
  RECEIPT: "إيصال/فاتورة حرارية",
  LABEL: "ملصق باركود",
  ORDER_TICKET: "تذكرة طلب/أمر شغل",
  DOCUMENT: "مستند A4 (فاتورة/عرض/تقرير)",
};

// ── مفاتيح التخزين (بمساحة أسماء؛ لا تصطدم بالقديمة) ───────────────────────────
const LS_PROFILES = "printer.profiles.v1";
const LS_ASSIGN = "printer.assign.v1";
const LS_MIGRATED = "printer.migrated.v1";

// مفاتيح قديمة (تبقى مقروءة ولا تُحذف — رجوع آمن).
const LEGACY_RECEIPT_KEY = "thermalPrinter.default";
const LEGACY_LABEL_KEY = "thermalPrinter.label";

// معرّفات مُركَّبة ثابتة للرجوع للقديم (تُستعمل أيضاً كمفاتيح فتحات في thermal.ts).
export const LEGACY_RECEIPT_ID = "__legacy_receipt";
export const LEGACY_LABEL_ID = "__legacy_label";
export const BROWSER_DOCUMENT_ID = "__browser_document";

// ── أدوات داخلية ──────────────────────────────────────────────────────────────
function hasLS(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readLS<T>(key: string, fallback: T): T {
  if (!hasLS()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown): void {
  if (!hasLS()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* تجاهل — التخزين غير متاح (يبقى يعمل لهذه الجلسة) */
  }
}

/** الآن (ms). دالة منفصلة لتسهيل أي ضبط لاحق. */
function now(): number {
  return Date.now();
}

/** معرّف فريد (UUID حين يتوفّر، وإلا بديل آمن — المعرّفات هنا ليست حسّاسة أمنياً). */
function genId(): string {
  try {
    const c: any = typeof crypto !== "undefined" ? crypto : undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    /* تجاهل */
  }
  return `prn-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** تطبيع ملفّ قادم من التخزين (حقول ناقصة في إصدارات أقدم). */
function normalizeProfile(p: any): PrinterProfile | null {
  if (!p || typeof p !== "object" || typeof p.id !== "string") return null;
  const transport: PrintTransport =
    p.transport === "webusb" || p.transport === "bridge" || p.transport === "browser"
      ? p.transport
      : "browser";
  const outputFormat: PrintOutputFormat =
    p.outputFormat === "escpos" || p.outputFormat === "zpl" || p.outputFormat === "epl"
      ? p.outputFormat
      : "escpos";
  const purposes: PrintPurpose[] = Array.isArray(p.purposes)
    ? p.purposes.filter((x: any): x is PrintPurpose => (ALL_PURPOSES as readonly string[]).includes(x))
    : [];
  return {
    id: p.id,
    name: typeof p.name === "string" && p.name.trim() ? p.name : "طابعة",
    transport,
    purposes,
    usb: p.usb && typeof p.usb.vendorId === "number" && typeof p.usb.productId === "number"
      ? { vendorId: p.usb.vendorId, productId: p.usb.productId, serial: p.usb.serial }
      : undefined,
    bridgePrinterName: typeof p.bridgePrinterName === "string" ? p.bridgePrinterName : undefined,
    paper: p.paper && typeof p.paper.widthMm === "number"
      ? { widthMm: p.paper.widthMm, heightMm: p.paper.heightMm, dpmm: typeof p.paper.dpmm === "number" ? p.paper.dpmm : 8 }
      : undefined,
    outputFormat,
    createdAt: typeof p.createdAt === "number" ? p.createdAt : now(),
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : now(),
  };
}

// ── CRUD الملفّات ─────────────────────────────────────────────────────────────
export function listProfiles(): PrinterProfile[] {
  ensureMigrated();
  const raw = readLS<any[]>(LS_PROFILES, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeProfile).filter((p): p is PrinterProfile => !!p);
}

export function getProfile(id: string): PrinterProfile | null {
  return listProfiles().find((p) => p.id === id) ?? null;
}

/**
 * إنشاء/تحديث ملفّ. إن لم يكن للملفّ id يُولَّد جديد. يعيد الملفّ المحفوظ (بـid وطوابع زمنية).
 * يتجاهل الحقل transient (الملفّات المُركَّبة لا تُحفظ).
 */
export function upsertProfile(
  input: Partial<PrinterProfile> & Pick<PrinterProfile, "name" | "transport">,
): PrinterProfile {
  const profiles = listProfiles();
  const id = input.id ?? genId();
  const existing = profiles.find((p) => p.id === id);
  const merged: PrinterProfile = {
    id,
    name: input.name,
    transport: input.transport,
    purposes: input.purposes ?? existing?.purposes ?? [],
    usb: input.usb ?? existing?.usb,
    bridgePrinterName: input.bridgePrinterName ?? existing?.bridgePrinterName,
    paper: input.paper ?? existing?.paper,
    outputFormat: input.outputFormat ?? existing?.outputFormat ?? "escpos",
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  const next = existing ? profiles.map((p) => (p.id === id ? merged : p)) : [...profiles, merged];
  writeLS(LS_PROFILES, next);
  return merged;
}

/** حذف ملفّ + تفريغ أي إسناد يشير إليه. */
export function removeProfile(id: string): void {
  const next = listProfiles().filter((p) => p.id !== id);
  writeLS(LS_PROFILES, next);
  const assign = getAssignment();
  let changed = false;
  for (const k of Object.keys(assign) as PrintPurpose[]) {
    if (assign[k] === id) {
      assign[k] = null;
      changed = true;
    }
  }
  if (changed) writeLS(LS_ASSIGN, assign);
}

// ── الإسناد (مهمة → ملفّ) ──────────────────────────────────────────────────────
export function getAssignment(): AssignmentMap {
  ensureMigrated();
  const raw = readLS<AssignmentMap>(LS_ASSIGN, {});
  return raw && typeof raw === "object" ? raw : {};
}

export function getAssignedProfileId(purpose: PrintPurpose): string | null {
  return getAssignment()[purpose] ?? null;
}

export function setAssignment(purpose: PrintPurpose, profileId: string | null): void {
  const assign = getAssignment();
  assign[purpose] = profileId;
  writeLS(LS_ASSIGN, assign);
}

// ── الرجوع للقديم (ملفّات مُركَّبة عابرة) ────────────────────────────────────────
function readLegacyUsb(key: string): PrinterUsbId | null {
  const raw = readLS<any>(key, null);
  if (raw && typeof raw.vendorId === "number" && typeof raw.productId === "number") {
    return { vendorId: raw.vendorId, productId: raw.productId, serial: raw.serial };
  }
  return null;
}

function legacyProfile(purpose: "RECEIPT" | "LABEL"): PrinterProfile | null {
  const isLabel = purpose === "LABEL";
  const usb = readLegacyUsb(isLabel ? LEGACY_LABEL_KEY : LEGACY_RECEIPT_KEY);
  // الإيصال يقبل أوّل جهاز صالح حتى بلا محفوظ (سلوك قديم)؛ الملصق يتطلّب محفوظاً.
  if (isLabel && !usb) return null;
  return {
    id: isLabel ? LEGACY_LABEL_ID : LEGACY_RECEIPT_ID,
    name: isLabel ? "طابعة الملصقات" : "طابعة الإيصالات",
    transport: "webusb",
    purposes: isLabel ? ["LABEL"] : ["RECEIPT", "ORDER_TICKET"],
    usb: usb ?? undefined,
    paper: isLabel ? { ...getLabelSize(), dpmm: 8 } : undefined,
    outputFormat: "escpos",
    createdAt: now(),
    updatedAt: now(),
    transient: true,
  };
}

function browserDocumentProfile(): PrinterProfile {
  return {
    id: BROWSER_DOCUMENT_ID,
    name: "حوار الطباعة (A4)",
    transport: "browser",
    purposes: ["DOCUMENT"],
    outputFormat: "escpos",
    createdAt: now(),
    updatedAt: now(),
    transient: true,
  };
}

/**
 * يحلّ الملفّ الفعّال لمهمة:
 *   ١) الإسناد الصريح → الملفّ المحفوظ.
 *   ٢) رجوع للقديم: RECEIPT/ORDER_TICKET ⇒ thermalPrinter.default؛ LABEL ⇒ thermalPrinter.label.
 *   ٣) DOCUMENT ⇒ ملفّ حوار المتصفّح (دائماً متاح).
 *   ٤) وإلا null (⇒ ينحدر المُرسِل لحوار المتصفّح).
 */
export function resolveProfile(purpose: PrintPurpose): PrinterProfile | null {
  const id = getAssignedProfileId(purpose);
  if (id) {
    const p = getProfile(id);
    if (p) return p;
  }
  if (purpose === "RECEIPT" || purpose === "ORDER_TICKET") {
    const p = legacyProfile("RECEIPT");
    if (p) return p;
  }
  if (purpose === "LABEL") {
    const p = legacyProfile("LABEL");
    if (p) return p;
  }
  if (purpose === "DOCUMENT") {
    return browserDocumentProfile();
  }
  return null;
}

// ── الهجرة لمرّة واحدة ──────────────────────────────────────────────────────────
let migrationDone = false;

/**
 * تستورد المفاتيح القديمة إلى ملفّات حقيقية مُسنَدة (idempotent، محروسة بـprinter.migrated.v1):
 *   thermalPrinter.default → ملف RECEIPT (ومُسنَد لـORDER_TICKET افتراضياً).
 *   thermalPrinter.label   → ملف LABEL (مع paper من labelSize).
 * لا تحذف المفاتيح القديمة. لا ترمي أبداً.
 */
export function migrateLegacyPrinters(): void {
  if (!hasLS()) return;
  if (readLS<string | null>(LS_MIGRATED, null) === "1") return;

  try {
    const profiles = listProfilesRaw();
    const assign = getAssignment();

    const receiptUsb = readLegacyUsb(LEGACY_RECEIPT_KEY);
    if (receiptUsb && !assign.RECEIPT) {
      const prof = upsertProfile({
        name: "طابعة الإيصالات",
        transport: "webusb",
        purposes: ["RECEIPT", "ORDER_TICKET"],
        usb: receiptUsb,
        outputFormat: "escpos",
      });
      setAssignment("RECEIPT", prof.id);
      if (!assign.ORDER_TICKET) setAssignment("ORDER_TICKET", prof.id);
    }

    const labelUsb = readLegacyUsb(LEGACY_LABEL_KEY);
    if (labelUsb && !assign.LABEL) {
      const prof = upsertProfile({
        name: "طابعة الملصقات",
        transport: "webusb",
        purposes: ["LABEL"],
        usb: labelUsb,
        paper: { ...getLabelSize(), dpmm: 8 },
        outputFormat: "escpos",
      });
      setAssignment("LABEL", prof.id);
    }

    void profiles;
  } catch {
    /* لا نُعطّل النظام لأجل الهجرة */
  } finally {
    writeLS(LS_MIGRATED, "1");
  }
}

/** قراءة خام للملفّات بلا تشغيل الهجرة (يُستعمل داخل الهجرة لتفادي التكرار). */
function listProfilesRaw(): PrinterProfile[] {
  const raw = readLS<any[]>(LS_PROFILES, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeProfile).filter((p): p is PrinterProfile => !!p);
}

function ensureMigrated(): void {
  if (migrationDone) return;
  migrationDone = true;
  migrateLegacyPrinters();
}

// تشغيل الهجرة عند تحميل الوحدة (في المتصفّح). في node/الاختبار تُستدعى صراحةً.
ensureMigrated();
