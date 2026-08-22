// اختبار مؤشّر جودة العدّاد — انضباط المسح لكل عامل (م٥، وثيقة «الجرد بالباركود» ٢٢/٨).
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getCounterQualityStats } from "../stocktakeService";

const TABLES = [
  "stocktakeCounts",
  "stocktakeAssignments",
  "stocktakeSessions",
  "productVariants",
  "products",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const recent = () => new Date(Date.now() - 3 * 86_400_000);
const old = () => new Date(Date.now() - 200 * 86_400_000);

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "ليلى", role: "warehouse", loginMethod: "local" },
    // موظّفٌ آخر بنفس الاسم المعروض ⇒ يجب ألّا يُدمَج مع الأول (التمييز بالهويّة لا الاسم).
    { id: 2, openId: "u2", name: "ليلى", role: "warehouse", loginMethod: "local" },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "قلم" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "V1", costPrice: "0" }]);
  await d.insert(s.stocktakeSessions).values([
    { id: 1, code: "C1", name: "جلسة عادية", branchId: 1, scopeType: "MANUAL", sessionType: "NORMAL", status: "APPROVED" },
    { id: 2, code: "C2", name: "افتتاحية", branchId: 1, scopeType: "MANUAL", sessionType: "OPENING", status: "APPROVED" },
    { id: 3, code: "C3", name: "جلسة فرع آخر", branchId: 2, scopeType: "MANUAL", sessionType: "NORMAL", status: "APPROVED" },
  ]);
  await d.insert(s.stocktakeAssignments).values([
    { id: 1, sessionId: 1, name: "عامل أ", method: "PIN" },
    { id: 2, sessionId: 2, name: "عامل ب", method: "PIN" },
    { id: 3, sessionId: 3, name: "عامل ج", method: "PIN" },
  ]);

  const c = (o: {
    sessionId: number;
    assignmentId: number;
    by: string;
    em: "SCAN_HID" | "SCAN_CAMERA" | "MANUAL_AUTHORIZED" | "SEARCH_PICK" | null;
    at?: Date;
    userId?: number;
  }) => ({
    sessionId: o.sessionId,
    variantId: 1,
    assignmentId: o.assignmentId,
    kind: "FIRST" as const,
    qty: 1,
    countedByName: o.by,
    countedByUserId: o.userId ?? null,
    countedAt: o.at ?? recent(),
    entryMethod: o.em,
    clientRequestId: randomUUID(),
  });

  await d.insert(s.stocktakeCounts).values([
    // «سالم»: 3 مسح + 1 يدويّ ⇒ scanPct = 75٪.
    c({ sessionId: 1, assignmentId: 1, by: "سالم", em: "SCAN_HID" }),
    c({ sessionId: 1, assignmentId: 1, by: "سالم", em: "SCAN_HID" }),
    c({ sessionId: 1, assignmentId: 1, by: "سالم", em: "SCAN_CAMERA" }),
    c({ sessionId: 1, assignmentId: 1, by: "سالم", em: "MANUAL_AUTHORIZED" }),
    // «حسن»: كلّه اختيار من القائمة ⇒ scanPct = 0٪ (الأدنى انضباطاً).
    c({ sessionId: 1, assignmentId: 1, by: "حسن", em: "SEARCH_PICK" }),
    c({ sessionId: 1, assignmentId: 1, by: "حسن", em: "SEARCH_PICK" }),
    // «علي»: كلّه بلا وسم (موبايل/إرث) ⇒ scanPct = null.
    c({ sessionId: 1, assignmentId: 1, by: "علي", em: null }),
    // موظّفان بالاسم «ليلى» بهويّتَين مختلفتَين ⇒ صفّان منفصلان (تمييزٌ بالهويّة لا الاسم).
    c({ sessionId: 1, assignmentId: 1, by: "ليلى", em: "SCAN_HID", userId: 1 }),
    c({ sessionId: 1, assignmentId: 1, by: "ليلى", em: "SCAN_HID", userId: 1 }),
    c({ sessionId: 1, assignmentId: 1, by: "ليلى", em: "MANUAL_AUTHORIZED", userId: 2 }),
    // مُستبعَدات: جلسة افتتاحية، جلسة فرع آخر (تظهر فقط بلا حصر فرع)، وعدّة قديمة خارج النافذة.
    c({ sessionId: 2, assignmentId: 2, by: "سالم", em: "MANUAL_AUTHORIZED" }),
    c({ sessionId: 3, assignmentId: 3, by: "زيد", em: "SCAN_HID" }),
    c({ sessionId: 1, assignmentId: 1, by: "سالم", em: "MANUAL_AUTHORIZED", at: old() }),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("getCounterQualityStats (م٥)", () => {
  it("يحسب نسبة المسح لكل عامل، ويعزل «بلا وسم»، ويستبعد الافتتاحية والقديمة", async () => {
    const res = await getCounterQualityStats(null);
    expect(res.windowDays).toBe(90);
    const byName = new Map(res.workers.map((w) => [w.name, w]));

    const salem = byName.get("سالم")!;
    // 4 عدّات ضمن النافذة والجلسة العادية (الافتتاحية والقديمة مستبعدتان).
    expect(salem.total).toBe(4);
    expect(salem.scan).toBe(3);
    expect(salem.manual).toBe(1);
    expect(salem.scanPct).toBe(75);

    const hasan = byName.get("حسن")!;
    expect(hasan.searchPick).toBe(2);
    expect(hasan.scanPct).toBe(0);

    const ali = byName.get("علي")!;
    expect(ali.untagged).toBe(1);
    expect(ali.scanPct).toBeNull(); // لا عدّات موسومة ⇒ لا نسبة

    // «زيد» في فرع آخر يظهر بلا حصر فرع.
    expect(byName.has("زيد")).toBe(true);

    // الترتيب: الأدنى انضباطاً أولاً (0٪)، ومن بلا نسبة في الذيل.
    expect(res.workers[0].scanPct).toBe(0);
    expect(res.workers[res.workers.length - 1].scanPct).toBeNull();
  });

  it("يميّز موظّفَين بنفس الاسم بهويّتَين مختلفتَين (لا يدمجهما)", async () => {
    const res = await getCounterQualityStats(null);
    const laylas = res.workers.filter((w) => w.name === "ليلى");
    expect(laylas).toHaveLength(2);
    const pcts = laylas.map((w) => w.scanPct).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(pcts).toEqual([0, 100]); // هويّةٌ كلّها مسح، وأخرى كلّها يدويّ
  });

  it("عزل الفرع: تمرير فرعٍ يحصر النتيجة به", async () => {
    const res = await getCounterQualityStats(2);
    const names = res.workers.map((w) => w.name);
    expect(names).toContain("زيد");
    expect(names).not.toContain("سالم");
    expect(names).not.toContain("حسن");
  });
});
