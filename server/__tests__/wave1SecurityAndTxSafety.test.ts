// @vitest-environment jsdom
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRealtimeEvent,
  REALTIME_EVENT_TYPES,
} from "@shared/realtimeEvents";
import { sanitizeCompanyLogoUrl } from "@shared/companyIdentity";
import {
  isTransactionFatalError,
  rethrowIfTransactionFatal,
} from "../lib/txFatalError";
import { shadowPost } from "../services/accounting/shadowHook";
import {
  generateHighEntropyBadgeCode,
  hashBadgeBarcode,
  matchesStoredBadgeBarcode,
} from "../lib/badgeBarcodeCrypto";
import { redactAuditValue } from "../services/auditService";
import { RealtimeBridgeManager } from "../realtime/bridge";
import { workflowPrintPackHtml } from "../../client/src/lib/printing/workflowDocuments";

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("Wave 1 — Transaction Fatal Rethrow, Realtime Bridge HMAC, Badge Crypto & Print Sanitization", () => {
  const bridges: RealtimeBridgeManager[] = [];

  afterEach(async () => {
    while (bridges.length > 0) {
      const b = bridges.pop();
      if (b) await b.stop();
    }
  });

  it("يكتشف ويعيد رمي أخطاء InnoDB القاتلة للمعاملة حتى عندما تكون مغلّفة داخل DrizzleQueryError.cause", () => {
    const mysqlDeadlock = Object.assign(
      new Error("Deadlock found when trying to get lock; try restarting transaction"),
      { errno: 1213, code: "ER_LOCK_DEADLOCK", sqlState: "40001" },
    );
    const drizzleWrapped = new Error("Failed query: insert into `journalEntries` ...", {
      cause: mysqlDeadlock,
    });
    expect(isTransactionFatalError(drizzleWrapped)).toBe(true);
    expect(() => rethrowIfTransactionFatal(drizzleWrapped)).toThrow(/Failed query/);

    const superReadOnly = Object.assign(
      new Error("The MySQL server is running with the --super-read-only option"),
      { errno: 1290, code: "ER_OPTION_PREVENTS_STATEMENT" },
    );
    expect(isTransactionFatalError(superReadOnly)).toBe(true);

    const benignMappingErr = new Error("missing account mapping");
    expect(isTransactionFatalError(benignMappingErr)).toBe(false);
    expect(() => rethrowIfTransactionFatal(benignMappingErr)).not.toThrow();
  });

  it("يمنع shadowPost في وضع SHADOW ابتلاع ER_LOCK_DEADLOCK بينما يبقى متسامحاً مع أخطاء الفجوات العادية", async () => {
    const deadlockTx = {
      select: () => {
        throw new Error("Failed query", {
          cause: Object.assign(new Error("Deadlock"), { errno: 1213, code: "ER_LOCK_DEADLOCK" }),
        });
      },
      insert: () => {
        throw new Error("Failed query", {
          cause: Object.assign(new Error("Deadlock"), { errno: 1213, code: "ER_LOCK_DEADLOCK" }),
        });
      },
    } as any;

    await expect(
      shadowPost(
        deadlockTx,
        101,
        { entryType: "SALE", amount: "1000.00" } as any,
        { runtime: { mode: "SHADOW", cycleId: "cycle-1" } as any },
      ),
    ).rejects.toThrow(/Failed query/);

    const nonFatalTx = {
      insert: () => ({
        values: () => {
          throw new Error("non-fatal gap write warning");
        },
      }),
    } as any;

    await expect(
      shadowPost(
        nonFatalTx,
        102,
        { entryType: "SALE", amount: "1000.00" } as any,
        { runtime: { mode: "SHADOW", cycleId: "cycle-1" } as any },
      ),
    ).resolves.toBeUndefined();
  });

  it("يصادق جسر اللحظية بـ HMAC ويرفض المقابس المحلية غير الموثّقة قبل الانضمام أو إفساد الحواجز", async () => {
    const port = await reserveLoopbackPort();
    const hub = new RealtimeBridgeManager();
    const goodClient = new RealtimeBridgeManager();
    bridges.push(hub, goodClient);

    await hub.init({
      host: "127.0.0.1",
      port,
      isHub: true,
      isMultiWorker: true,
      workerId: "hub-0",
      expectedWorkerCount: 2,
      secret: "wave1-shared-hmac-secret",
    });
    hub.setReleaseHandler(() => true);

    await goodClient.init({
      host: "127.0.0.1",
      port,
      isHub: false,
      isMultiWorker: true,
      workerId: "worker-1",
      expectedWorkerCount: 2,
      secret: "wave1-shared-hmac-secret",
    });
    goodClient.setReleaseHandler(() => true);

    await new Promise((r) => setTimeout(r, 80));
    expect(hub.getStatus().connectedClients).toBe(1);

    const receivedOnHub: unknown[] = [];
    hub.subscribe((evt) => receivedOnHub.push(evt));

    // مقبس مهاجم محلي يحاول حقن حدث مزوّر بدون توقيع HMAC
    const rogue = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => rogue.once("connect", () => resolve()));
    // لا يُضمّ المقبس غير المصادق إلى connectedSockets بمجرد فتح TCP
    expect(hub.getStatus().connectedClients).toBe(1);

    const closedPromise = new Promise<void>((resolve) =>
      rogue.once("close", () => resolve()),
    );
    rogue.write(
      JSON.stringify({
        originWorkerId: "rogue",
        event: createRealtimeEvent(REALTIME_EVENT_TYPES.WORK_ORDER_CREATED, {
          workOrderId: 999999,
        }),
      }) + "\n",
    );
    await closedPromise;
    expect(receivedOnHub).toHaveLength(0);
    expect(hub.getStatus().connectedClients).toBe(1);

    // العامل الشرعي يبث ويؤكد حاجز PWA بنجاح
    goodClient.publish(
      createRealtimeEvent(REALTIME_EVENT_TYPES.WORK_ORDER_CREATED, {
        workOrderId: 42,
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(receivedOnHub).toHaveLength(1);

    const barrierOk = await goodClient.publishConfirmed(
      createRealtimeEvent("pwa.sse.quiesce", {}, { userId: 7, companyId: null }),
    );
    expect(barrierOk).toBe(true);
  });

  it("يشفّر شارات المدير بـ HMAC أحادي الاتجاه مع استمرار قراءة الشارات المطبوعة سابقاً", () => {
    const generated = generateHighEntropyBadgeCode(12);
    expect(generated).toMatch(/^MGR-12-\d{16}$/);

    const digest = hashBadgeBarcode(generated);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(matchesStoredBadgeBarcode(digest, generated)).toBe(true);
    expect(matchesStoredBadgeBarcode(digest, generated.toLowerCase())).toBe(true);
    expect(matchesStoredBadgeBarcode(digest, "MGR-12-0000000000000000")).toBe(false);
    // منع تمرير البصمة المسروقة من قاعدة البيانات كرمز باركود خام (pass-the-hash)
    expect(matchesStoredBadgeBarcode(digest, digest)).toBe(false);

    // توافق التراجع للبطاقات الفيزيائية المطبوعة قبل الترقية
    expect(matchesStoredBadgeBarcode("MGR-3-112233", "MGR-3-112233")).toBe(true);
    expect(matchesStoredBadgeBarcode("MGR-3-112233", "MGR-3-999999")).toBe(false);
  });

  it("يحجب مفاتيح كلمات المرور وPIN ورموز شارات المدير في redactAuditValue دون المساس بباركود المنتجات", () => {
    const out = redactAuditValue({
      sku: "PEN-01",
      barcode: "6281000012345",
      currentPassword: "SecretPassword!",
      pin: "1234",
      badgeBarcode: "MGR-5-998877",
      nested: { rawScan: "MGR-9-1234567890123456" },
    }) as Record<string, any>;

    expect(out.barcode).toBe("6281000012345");
    expect(out.currentPassword).toBe("[REDACTED]");
    expect(out.pin).toBe("[REDACTED]");
    expect(out.badgeBarcode).toBe("[REDACTED]");
    expect(out.nested.rawScan).toBe("[REDACTED]");
  });

  it("يرفض روابط الشعار الملوّثة بمحارف كسر السمات وينقّي سمات on* في workflowPrintPackHtml", () => {
    expect(sanitizeCompanyLogoUrl("/logo.png")).toBe("/logo.png");
    expect(sanitizeCompanyLogoUrl("https://cdn.alarabiya.online/logo.png")).toBe(
      "https://cdn.alarabiya.online/logo.png",
    );
    expect(
      sanitizeCompanyLogoUrl('https://evil.example/logo.png" onerror="alert(1)'),
    ).toBeNull();
    expect(sanitizeCompanyLogoUrl("javascript:alert(1)")).toBeNull();
    expect(
      sanitizeCompanyLogoUrl("data:image/svg+xml;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+"),
    ).toBeNull();

    const pack = workflowPrintPackHtml([
      {
        title: "إيصال",
        html: '<html><body><img src="/logo.png" onerror="window.__xss=1"><a href="javascript:alert(1)">رابط</a><iframe src="https://evil.test"></iframe><div>محتوى آمن</div></body></html>',
      },
    ]);
    expect(pack).toContain("محتوى آمن");
    expect(pack).not.toContain("onerror");
    expect(pack).not.toContain("javascript:");
    expect(pack).not.toContain("<iframe");
  });
});
