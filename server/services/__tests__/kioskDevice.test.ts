// اختبارات مصادقة أجهزة الكشك الخارجية — رمز للقراءة فقط، فرع مفروض، إلغاء فوري،
// عزل توكن الجهاز عن جلسة المستخدم، وأمان بيانات الزبون (بلا تكلفة/مخزون).
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createKioskDevice,
  deviceLoginByToken,
  generateDeviceToken,
  hashDeviceToken,
  resolveKioskDevice,
  rotateKioskDevice,
  setKioskDeviceActive,
} from "../kioskDeviceService";
import { KIOSK_COOKIE_NAME, signKioskSession, verifyKioskSession } from "../../auth/kioskSession";
import { signSession, verifySession } from "../../auth/session";
import { kioskBanner, kioskLookup } from "../kioskService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "kioskDevices",
  "productImages",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "branches",
  "users",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES", isActive: true },
    { id: 3, name: "فرع مغلق", code: "OLD", type: "SALES", isActive: false },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values([{ id: 1, name: "قلم جاف أزرق", brand: "بايلوت" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "350.00" }]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6291041500213" },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "500.00" }]);
  // مخزون في الفرع 1 فقط (الفرع 2 بلا مخزون لهذا الصنف).
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 40 }]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

function reqWithKioskCookie(token: string): any {
  return { headers: { cookie: `${KIOSK_COOKIE_NAME}=${token}` }, socket: {} };
}

describe("kiosk: توليد الرمز وتجزئته", () => {
  it("الرمز بصيغة kde_ + 48 خانة ست عشرية وفريد", () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a).toMatch(/^kde_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
  it("التجزئة sha256 حتمية", () => {
    const t = "kde_abc";
    expect(hashDeviceToken(t)).toBe(createHash("sha256").update(t).digest("hex"));
    expect(hashDeviceToken(t)).toHaveLength(64);
  });
});

describe("kiosk: إنشاء جهاز + دخول", () => {
  it("الإنشاء يخزّن التجزئة فقط (لا الرمز الخام) ويُعيد الرمز مرّة واحدة", async () => {
    const r = await createKioskDevice({ branchId: 1, label: "شاشة المدخل", createdBy: 1 });
    expect(r.rawToken).toMatch(/^kde_/);
    const rows = await db().select().from(s.kioskDevices).where(sql`${s.kioskDevices.id} = ${r.id}`);
    const dev = rows[0] as any;
    expect(dev.tokenHash).toBe(hashDeviceToken(r.rawToken));
    expect(dev.tokenHash).not.toContain(r.rawToken); // لا يحوي الرمز الخام
    expect(dev.tokenPrefix).toBe(r.rawToken.slice(0, 12));
    expect(Boolean(dev.isActive)).toBe(true);
  });

  it("دخول الجهاز بالرمز الصحيح يُعيد الفرع المربوط", async () => {
    const r = await createKioskDevice({ branchId: 2, label: "كاونتر", createdBy: 1 });
    const login = await deviceLoginByToken(r.rawToken, "1.2.3.4");
    expect(login).not.toBeNull();
    expect(login!.branchId).toBe(2);
    expect(login!.branchName).toBe("فرع المبيعات");
  });

  it("رمز خاطئ أو بصيغة غير صحيحة ⇒ null", async () => {
    await createKioskDevice({ branchId: 1, label: "x", createdBy: 1 });
    expect(await deviceLoginByToken("kde_deadbeef")).toBeNull();
    expect(await deviceLoginByToken("not-a-token")).toBeNull();
    expect(await deviceLoginByToken("")).toBeNull();
  });

  it("الإنشاء على فرع مُعطّل ممنوع", async () => {
    await expect(createKioskDevice({ branchId: 3, label: "قديم", createdBy: 1 })).rejects.toThrow();
  });

  it("جهاز صار فرعه مُعطّلاً بعد الإنشاء ⇒ يُرفض الدخول", async () => {
    const r = await createKioskDevice({ branchId: 1, label: "ش", createdBy: 1 });
    expect(await deviceLoginByToken(r.rawToken)).not.toBeNull();
    await db().update(s.branches).set({ isActive: false }).where(eq(s.branches.id, 1));
    expect(await deviceLoginByToken(r.rawToken)).toBeNull();
  });
});

describe("kiosk: الإلغاء والتدوير", () => {
  it("الإلغاء يُبطل الرمز فوراً، والتفعيل يعيده", async () => {
    const r = await createKioskDevice({ branchId: 1, label: "ش", createdBy: 1 });
    expect(await deviceLoginByToken(r.rawToken)).not.toBeNull();
    await setKioskDeviceActive(r.id, false);
    expect(await deviceLoginByToken(r.rawToken)).toBeNull();
    await setKioskDeviceActive(r.id, true);
    expect(await deviceLoginByToken(r.rawToken)).not.toBeNull();
  });

  it("التدوير يُبطل الرمز القديم ويُفعّل الجديد", async () => {
    const r = await createKioskDevice({ branchId: 1, label: "ش", createdBy: 1 });
    const old = r.rawToken;
    const rotated = await rotateKioskDevice(r.id);
    expect(rotated.rawToken).not.toBe(old);
    expect(await deviceLoginByToken(old)).toBeNull();
    expect(await deviceLoginByToken(rotated.rawToken)).not.toBeNull();
  });
});

describe("kiosk: resolveKioskDevice (كوكي الجهاز) — الفرع من القاعدة", () => {
  it("كوكي صالح ⇒ يُعيد فرع الجهاز (مفروض)", async () => {
    const r = await createKioskDevice({ branchId: 2, label: "ش", createdBy: 1 });
    const token = await signKioskSession(r.id, 2, r.rawToken.slice(0, 12));
    const resolved = await resolveKioskDevice(reqWithKioskCookie(token));
    expect(resolved).not.toBeNull();
    expect(resolved!.branchId).toBe(2);
  });

  it("جهاز مُلغى ⇒ resolveKioskDevice = null رغم توكن موقّع صالح", async () => {
    const r = await createKioskDevice({ branchId: 1, label: "ش", createdBy: 1 });
    const token = await signKioskSession(r.id, 1, r.rawToken.slice(0, 12));
    await setKioskDeviceActive(r.id, false);
    expect(await resolveKioskDevice(reqWithKioskCookie(token))).toBeNull();
  });

  it("تدوير الرمز يُبطل كوكي الجهاز الحيّ (ver لا يطابق البادئة الجديدة)", async () => {
    const r = await createKioskDevice({ branchId: 1, label: "ش", createdBy: 1 });
    const token = await signKioskSession(r.id, 1, r.rawToken.slice(0, 12));
    expect(await resolveKioskDevice(reqWithKioskCookie(token))).not.toBeNull();
    await rotateKioskDevice(r.id);
    expect(await resolveKioskDevice(reqWithKioskCookie(token))).toBeNull();
  });

  it("كوكي غير صالح/مفقود ⇒ null", async () => {
    expect(await resolveKioskDevice(reqWithKioskCookie("garbage.token.here"))).toBeNull();
    expect(await resolveKioskDevice({ headers: {}, socket: {} } as any)).toBeNull();
  });
});

describe("kiosk: عزل توكن الجهاز عن جلسة المستخدم", () => {
  it("توكن المستخدم لا يُقبل كتوكن جهاز، وتوكن الجهاز لا يُقبل كجلسة مستخدم", async () => {
    const userTok = await signSession(1);
    const kioskTok = await signKioskSession(99, 1, "kde_abcd1234");
    // توكن مستخدم ⇒ verifyKioskSession يرفضه (لا scope=kiosk).
    expect(await verifyKioskSession(userTok)).toBeNull();
    // توكن جهاز ⇒ verifySession يرفضه (لا uid).
    expect(await verifySession(kioskTok)).toBeNull();
    // والعكس يعمل لكلٍّ في مجاله.
    expect(await verifyKioskSession(kioskTok)).toMatchObject({ deviceId: 99, branchId: 1 });
    expect(await verifySession(userTok)).toMatchObject({ uid: 1 });
  });
});

describe("kiosk: أمان بيانات الزبون (بلا تكلفة/مخزون)", () => {
  it("البنر يُعيد سعر المفرد بلا أي حقل تكلفة/كمية", async () => {
    const rows = await kioskBanner(1, 40);
    expect(rows.length).toBeGreaterThan(0);
    const p = rows[0] as any;
    expect(p.price).toBe("500.00");
    expect(p).not.toHaveProperty("costPrice");
    expect(p).not.toHaveProperty("cost");
    expect(p).not.toHaveProperty("quantity");
    expect(p).not.toHaveProperty("stockBase");
  });

  it("بحث الباركود يُعيد المنتج بلا تكلفة/كمية، والباركود المجهول ⇒ null", async () => {
    const hit = (await kioskLookup("6291041500213", 1)) as any;
    expect(hit).not.toBeNull();
    expect(hit.productName).toBe("قلم جاف أزرق");
    expect(hit).not.toHaveProperty("costPrice");
    expect(hit).not.toHaveProperty("quantity");
    expect(await kioskLookup("0000000000000", 1)).toBeNull();
  });

  it("البنر يعرض المتوفّر فقط: الفرع 2 (بلا مخزون لهذا الصنف) فارغ", async () => {
    const rows = await kioskBanner(2, 40);
    expect(rows).toHaveLength(0);
  });
});
