// اختبار وحدة نقي لجسر الطباعة (printService) — لا يحتاج قاعدة بيانات.
// يغطّي: تحليل PRINT_TARGET، الإرسال الفعلي عبر TCP لخادم وهمي، تذكرة الاختبار، والوصف.
import net from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import {
  parsePrintTarget, DEFAULT_RAW_PORT, sendTcp, buildTestTicket, describeTarget, sendWindowsShare,
  sendWindowsSpooler, isThermalCandidate, detectConnectedThermalPrinter,
  getConfiguredTarget, isBridgeEnabled, detectWindowsSharedPrinter, _resetDetectedPrinterCacheForTesting,
} from "../printService";

describe("parsePrintTarget", () => {
  it("tcp:// مع منفذ صريح", () => {
    expect(parsePrintTarget("tcp://192.168.1.5:9100")).toMatchObject({ kind: "tcp", host: "192.168.1.5", port: 9100 });
  });
  it("tcp:// بلا منفذ ⇒ المنفذ الافتراضي 9100", () => {
    expect(parsePrintTarget("tcp://printer.local")).toMatchObject({ kind: "tcp", host: "printer.local", port: DEFAULT_RAW_PORT });
  });
  it("اختصار host:port يُفسَّر كـTCP", () => {
    expect(parsePrintTarget("10.0.0.9:9100")).toMatchObject({ kind: "tcp", host: "10.0.0.9", port: 9100 });
  });
  it("share:// ⇒ طابعة مشتركة", () => {
    expect(parsePrintTarget("share://POS80")).toMatchObject({ kind: "share", name: "POS80" });
  });
  it("windows:// أو printer:// ⇒ طابعة Windows عبر spooler", () => {
    expect(parsePrintTarget("windows://POS-80")).toMatchObject({ kind: "windows", name: "POS-80" });
    expect(parsePrintTarget("printer://Xprinter XP-N160I")).toMatchObject({ kind: "windows", name: "Xprinter XP-N160I" });
    expect(parsePrintTarget("win://Bixolon SRP-330")).toMatchObject({ kind: "windows", name: "Bixolon SRP-330" });
  });
  it("auto ⇒ null (يفسح المجال للاكتشاف التلقائي)", () => {
    expect(parsePrintTarget("auto")).toBeNull();
    expect(parsePrintTarget("AUTO")).toBeNull();
  });
  it("الفارغ/غير الصالح ⇒ null", () => {
    expect(parsePrintTarget("")).toBeNull();
    expect(parsePrintTarget(undefined)).toBeNull();
    expect(parsePrintTarget(null)).toBeNull();
    expect(parsePrintTarget("garbage")).toBeNull();
    expect(parsePrintTarget("tcp://host:99999")).toBeNull(); // منفذ خارج المدى
  });
});

describe("sendTcp", () => {
  it("يرسل البايتات كما هي للطابعة الشبكية", async () => {
    const payload = Buffer.from([0x1b, 0x40, 1, 2, 3, 0x0a, 0x1d, 0x56, 0x42, 0x00]);
    const chunks: Buffer[] = [];
    let resolveRecv!: (b: Buffer) => void;
    const recvP = new Promise<Buffer>((r) => { resolveRecv = r; });
    const server = net.createServer((sock) => {
      sock.on("data", (d) => {
        chunks.push(d);
        if (Buffer.concat(chunks).length >= payload.length) resolveRecv(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as net.AddressInfo).port;

    await sendTcp("127.0.0.1", port, payload);
    const got = await recvP;
    await new Promise<void>((res) => server.close(() => res()));

    expect(Array.from(got)).toEqual(Array.from(payload));
  });

  it("يرمي عند تعذّر الاتصال (منفذ مغلق)", async () => {
    await expect(sendTcp("127.0.0.1", 1, Buffer.from([1]), 1500)).rejects.toBeTruthy();
  });
});

describe("buildTestTicket", () => {
  it("يبدأ بـESC @ (تهيئة) وينتهي بقطع GS V B 0", () => {
    const b = buildTestTicket();
    expect(b[0]).toBe(0x1b);
    expect(b[1]).toBe(0x40);
    expect(Array.from(b.subarray(b.length - 4))).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });
});

describe("describeTarget", () => {
  it("يصف الوجهات بالعربية", () => {
    expect(describeTarget(null)).toContain("غير مفعّل");
    expect(describeTarget(parsePrintTarget("tcp://x:9100"))).toContain("شبكية");
    expect(describeTarget(parsePrintTarget("share://POS"))).toContain("مشتركة");
    expect(describeTarget(parsePrintTarget("windows://POS-80"))).toContain("حرارية");
  });
});

describe("isThermalCandidate", () => {
  it("يميز طابعات الإيصالات والنقاط الحرارية بأنواعها وموديلاتها المختلفة", () => {
    expect(isThermalCandidate({ name: "EPSON TM-T20III Receipt", driverName: "EPSON TM-T(203dpi) Receipt6", portName: "TMUSB001" })).toBe(true);
    expect(isThermalCandidate({ name: "Xprinter XP-N160I", driverName: "XP-80", portName: "USB001" })).toBe(true);
    expect(isThermalCandidate({ name: "Bixolon SRP-330", driverName: "SRP-330", portName: "USB002" })).toBe(true);
    expect(isThermalCandidate({ name: "HPRT LPQ58,1", driverName: "", portName: "" })).toBe(true);
    expect(isThermalCandidate({ name: "Rongta RP80", driverName: "RP80", portName: "COM1" })).toBe(true);
    expect(isThermalCandidate({ name: "Star TSP100", driverName: "TSP100", portName: "USB003" })).toBe(true);
    expect(isThermalCandidate({ name: "POS-80", driverName: "Generic", portName: "USB004" })).toBe(true);
    expect(isThermalCandidate({ name: "Thermal Receipt", driverName: "POS Printer", portName: "USB005" })).toBe(true);
  });

  it("يستبعد الطابعات المكتبية الافتراضية وطابعات الحبر والليزر وملفات PDF", () => {
    expect(isThermalCandidate({ name: "Adobe PDF", driverName: "Adobe PDF Converter", portName: "Documents\\*.pdf" })).toBe(false);
    expect(isThermalCandidate({ name: "Microsoft Print to PDF", driverName: "Microsoft Print To PDF", portName: "PORTPROMPT:" })).toBe(false);
    expect(isThermalCandidate({ name: "EPSON WF-C5390 Series", driverName: "EPSON WF-C5390 Series", portName: "EP6E4C5B" })).toBe(false);
    expect(isThermalCandidate({ name: "EPSON WF-C579R Series", driverName: "EPSON WF-C579R Series", portName: "EPA2796C" })).toBe(false);
    expect(isThermalCandidate({ name: "EPSONDE9FBE (L8050 Series)", driverName: "EPSON L8050 Series", portName: "WSD" })).toBe(false);
    expect(isThermalCandidate({ name: "OneNote (Desktop)", driverName: "Send to Microsoft OneNote 16 Driver", portName: "nul:" })).toBe(false);
    expect(isThermalCandidate({ name: "AnyDesk Printer", driverName: "AnyDesk v4 Printer Driver", portName: "AD_Port" })).toBe(false);
  });
});

describe("sendWindowsShare", () => {
  it("يرفض على أنظمة غير Windows", async () => {
    if (process.platform === "win32") return; // على Windows لا نطبع فعلاً داخل الاختبار
    await expect(sendWindowsShare("POS", Buffer.from([1]))).rejects.toThrow();
  });

  it("يرفض اسم مشاركة يحوي أحرف cmd خطرة (تحصين الحقن)", async () => {
    const bad = sendWindowsShare("POS & calc", Buffer.from([1]));
    if (process.platform === "win32") await expect(bad).rejects.toThrow(/غير صالح/);
    else await expect(bad).rejects.toThrow();
  });
});

describe("sendWindowsSpooler", () => {
  it("يرفض على أنظمة غير Windows", async () => {
    if (process.platform === "win32") return;
    await expect(sendWindowsSpooler("POS-80", Buffer.from([1]))).rejects.toThrow();
  });

  it("يرفض أسماء الطابعات غير الصالحة أو المشبوهة", async () => {
    const bad = sendWindowsSpooler("POS; calc", Buffer.from([1]));
    if (process.platform === "win32") await expect(bad).rejects.toThrow(/غير صالح/);
    else await expect(bad).rejects.toThrow();
  });
});

describe("getConfiguredTarget & detectConnectedThermalPrinter", () => {
  const origEnv = process.env.PRINT_TARGET;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.PRINT_TARGET = origEnv;
    } else {
      delete process.env.PRINT_TARGET;
    }
    _resetDetectedPrinterCacheForTesting();
  });

  it("يقرأ الوجهة الصريحة من PRINT_TARGET (TCP)", () => {
    process.env.PRINT_TARGET = "tcp://192.168.1.100:9100";
    const target = getConfiguredTarget();
    expect(target).toMatchObject({ kind: "tcp", host: "192.168.1.100", port: 9100 });
    expect(isBridgeEnabled()).toBe(true);
  });

  it("يقرأ وجهة مشاركة Windows صريحة من PRINT_TARGET", () => {
    process.env.PRINT_TARGET = "share://EPSON TM-T20III Receipt";
    const target = getConfiguredTarget();
    expect(target).toMatchObject({ kind: "share", name: "EPSON TM-T20III Receipt" });
    expect(isBridgeEnabled()).toBe(true);
  });

  it("يقرأ وجهة طابعة Windows مباشرة عبر spooler", () => {
    process.env.PRINT_TARGET = "windows://Xprinter XP-80C";
    const target = getConfiguredTarget();
    expect(target).toMatchObject({ kind: "windows", name: "Xprinter XP-80C" });
    expect(isBridgeEnabled()).toBe(true);
  });

  it("على أنظمة غير Windows، إذا كان PRINT_TARGET فارغاً يعيد null", () => {
    if (process.platform === "win32") return;
    delete process.env.PRINT_TARGET;
    expect(getConfiguredTarget()).toBeNull();
    expect(isBridgeEnabled()).toBe(false);
  });

  it("على Windows، يكتشف الطابعة الحرارية المتصلة بالخادم تلقائياً عند ضبط auto أو وتركه فارغاً", () => {
    if (process.platform !== "win32") return;
    process.env.PRINT_TARGET = "auto";
    _resetDetectedPrinterCacheForTesting();
    const detected = detectConnectedThermalPrinter();
    if (detected) {
      expect(["share", "windows"]).toContain(detected.kind);
      expect(detected.name).toBeTruthy();
      expect(getConfiguredTarget()).toEqual(detected);
      expect(isBridgeEnabled()).toBe(true);
    }
  });
});

