// اختبار وحدة نقي لجسر الطباعة (printService) — لا يحتاج قاعدة بيانات.
// يغطّي: تحليل PRINT_TARGET، الإرسال الفعلي عبر TCP لخادم وهمي، تذكرة الاختبار، والوصف.
import net from "node:net";
import { describe, it, expect } from "vitest";
import {
  parsePrintTarget, DEFAULT_RAW_PORT, sendTcp, buildTestTicket, describeTarget, sendWindowsShare,
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
  });
});

describe("sendWindowsShare", () => {
  it("يرفض على أنظمة غير Windows", async () => {
    if (process.platform === "win32") return; // على Windows لا نطبع فعلاً داخل الاختبار
    await expect(sendWindowsShare("POS", Buffer.from([1]))).rejects.toThrow();
  });

  it("يرفض اسم مشاركة يحوي أحرف cmd خطرة (تحصين الحقن)", async () => {
    // على Windows يرمي «غير صالح» قبل أي copy؛ على غيره يرمي «Windows فقط» — كلاهما رفض.
    const bad = sendWindowsShare("POS & calc", Buffer.from([1]));
    if (process.platform === "win32") await expect(bad).rejects.toThrow(/غير صالح/);
    else await expect(bad).rejects.toThrow();
  });
});
