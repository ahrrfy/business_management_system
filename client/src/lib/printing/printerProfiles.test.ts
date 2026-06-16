import { describe, it, expect, beforeEach } from "vitest";
import {
  listProfiles,
  getProfile,
  upsertProfile,
  removeProfile,
  getAssignment,
  getAssignedProfileId,
  setAssignment,
  resolveProfile,
  migrateLegacyPrinters,
  LEGACY_RECEIPT_ID,
  LEGACY_LABEL_ID,
  BROWSER_DOCUMENT_ID,
} from "./printerProfiles";

// غلاف localStorage بسيط في الذاكرة (نظيف لكل اختبار).
function makeLS() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

beforeEach(() => {
  (globalThis as any).localStorage = makeLS();
});

describe("printerProfiles — CRUD", () => {
  it("ينشئ ملفّاً بمعرّف وطوابع زمنية، ويقرأه ويسرده", () => {
    const p = upsertProfile({ name: "كاشير ١", transport: "bridge", bridgePrinterName: "EPSON-1", outputFormat: "escpos" });
    expect(p.id).toBeTruthy();
    expect(p.createdAt).toBeGreaterThan(0);
    expect(p.updatedAt).toBeGreaterThan(0);
    expect(getProfile(p.id)?.name).toBe("كاشير ١");
    expect(listProfiles()).toHaveLength(1);
  });

  it("يحدّث ملفّاً موجوداً بنفس المعرّف", () => {
    const p = upsertProfile({ name: "أ", transport: "webusb", outputFormat: "escpos" });
    const u = upsertProfile({ id: p.id, name: "ب", transport: "webusb" });
    expect(u.id).toBe(p.id);
    expect(getProfile(p.id)?.name).toBe("ب");
    expect(listProfiles()).toHaveLength(1);
  });

  it("الحذف يُزيل الملفّ ويُفرِغ أي إسناد يشير إليه", () => {
    const p = upsertProfile({ name: "لِلملصق", transport: "bridge", bridgePrinterName: "ZD220", outputFormat: "escpos" });
    setAssignment("LABEL", p.id);
    expect(getAssignedProfileId("LABEL")).toBe(p.id);
    removeProfile(p.id);
    expect(getProfile(p.id)).toBeNull();
    expect(getAssignedProfileId("LABEL")).toBeNull();
  });
});

describe("printerProfiles — الإسناد", () => {
  it("يضبط ويقرأ الإسناد لكل مهمة على حدة", () => {
    const a = upsertProfile({ name: "a", transport: "webusb", outputFormat: "escpos" });
    const b = upsertProfile({ name: "b", transport: "bridge", bridgePrinterName: "X", outputFormat: "escpos" });
    setAssignment("RECEIPT", a.id);
    setAssignment("LABEL", b.id);
    expect(getAssignedProfileId("RECEIPT")).toBe(a.id);
    expect(getAssignedProfileId("LABEL")).toBe(b.id);
    expect(getAssignment().RECEIPT).toBe(a.id);
  });
});

describe("printerProfiles — الهجرة", () => {
  it("تستورد المفاتيح القديمة إلى ملفّات مُسنَدة (RECEIPT/ORDER_TICKET/LABEL)", () => {
    localStorage.setItem("thermalPrinter.default", JSON.stringify({ vendorId: 1208, productId: 3604 }));
    localStorage.setItem("thermalPrinter.label", JSON.stringify({ vendorId: 4611, productId: 326 }));
    localStorage.setItem("labelSize", JSON.stringify({ widthMm: 40, heightMm: 25 }));

    migrateLegacyPrinters();

    expect(listProfiles()).toHaveLength(2);

    const rid = getAssignedProfileId("RECEIPT");
    expect(rid).toBeTruthy();
    const receipt = getProfile(rid!);
    expect(receipt?.transport).toBe("webusb");
    expect(receipt?.usb).toEqual({ vendorId: 1208, productId: 3604, serial: undefined });
    // ORDER_TICKET يُسنَد لطابعة الإيصالات افتراضياً.
    expect(getAssignedProfileId("ORDER_TICKET")).toBe(rid);

    const lid = getAssignedProfileId("LABEL");
    const label = getProfile(lid!);
    expect(label?.transport).toBe("webusb");
    expect(label?.usb).toEqual({ vendorId: 4611, productId: 326, serial: undefined });
    expect(label?.paper?.widthMm).toBe(40);
    expect(label?.paper?.heightMm).toBe(25);
    expect(label?.paper?.dpmm).toBe(8);
  });

  it("idempotent — لا تُكرّر الملفّات عند الاستدعاء مرّتين", () => {
    localStorage.setItem("thermalPrinter.default", JSON.stringify({ vendorId: 1, productId: 2 }));
    migrateLegacyPrinters();
    migrateLegacyPrinters();
    expect(listProfiles()).toHaveLength(1);
    expect(localStorage.getItem("printer.migrated.v1")).toBe('"1"');
  });

  it("بلا مفاتيح قديمة ⇒ لا ملفّات ولا رمي", () => {
    expect(() => migrateLegacyPrinters()).not.toThrow();
    expect(listProfiles()).toHaveLength(0);
  });

  it("لا تحذف المفاتيح القديمة (رجوع آمن)", () => {
    localStorage.setItem("thermalPrinter.default", JSON.stringify({ vendorId: 1, productId: 2 }));
    migrateLegacyPrinters();
    expect(localStorage.getItem("thermalPrinter.default")).toBeTruthy();
  });
});

describe("printerProfiles — الحلّ (resolveProfile)", () => {
  it("الإسناد الصريح يُحلّ أولاً", () => {
    const p = upsertProfile({ name: "p", transport: "bridge", bridgePrinterName: "Y", outputFormat: "escpos" });
    setAssignment("RECEIPT", p.id);
    expect(resolveProfile("RECEIPT")?.id).toBe(p.id);
  });

  it("رجوع للقديم: RECEIPT/ORDER_TICKET من thermalPrinter.default", () => {
    localStorage.setItem("thermalPrinter.default", JSON.stringify({ vendorId: 5, productId: 6 }));
    const r = resolveProfile("RECEIPT");
    expect(r?.id).toBe(LEGACY_RECEIPT_ID);
    expect(r?.transport).toBe("webusb");
    expect(r?.transient).toBe(true);
    expect(resolveProfile("ORDER_TICKET")?.id).toBe(LEGACY_RECEIPT_ID);
  });

  it("رجوع للقديم: LABEL يتطلّب thermalPrinter.label", () => {
    expect(resolveProfile("LABEL")).toBeNull();
    localStorage.setItem("thermalPrinter.label", JSON.stringify({ vendorId: 7, productId: 8 }));
    expect(resolveProfile("LABEL")?.id).toBe(LEGACY_LABEL_ID);
  });

  it("DOCUMENT يُحلّ دائماً لحوار المتصفّح", () => {
    const d = resolveProfile("DOCUMENT");
    expect(d?.id).toBe(BROWSER_DOCUMENT_ID);
    expect(d?.transport).toBe("browser");
  });

  it("ملفّ محذوف الإسناد يسقط للرجوع/null", () => {
    const p = upsertProfile({ name: "p", transport: "bridge", bridgePrinterName: "Z", outputFormat: "escpos" });
    setAssignment("LABEL", p.id);
    removeProfile(p.id);
    expect(resolveProfile("LABEL")).toBeNull();
  });
});

describe("printerProfiles — المتانة", () => {
  it("JSON فاسد في الملفّات ⇒ قائمة فارغة بلا رمي", () => {
    localStorage.setItem("printer.profiles.v1", "{not json");
    expect(() => listProfiles()).not.toThrow();
    expect(listProfiles()).toHaveLength(0);
  });

  it("غياب localStorage ⇒ دوال آمنة بلا رمي", () => {
    (globalThis as any).localStorage = undefined;
    expect(() => listProfiles()).not.toThrow();
    expect(() => getAssignment()).not.toThrow();
    expect(resolveProfile("DOCUMENT")?.transport).toBe("browser");
  });
});
