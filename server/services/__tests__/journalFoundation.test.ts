/**
 * الشريحة ٠ من خطة الدفتر المزدوج (docs/double-entry-p2-plan-2026-08-11.md):
 * وعاء القيود المزدوجة + علَم الأوضاع. **لا خطّاف بعد** — هذه اختبارات المخزن وحده.
 *
 * الثوابت المُختبَرة هنا هي بوّابات السلامة الإنتاجية في الخطة:
 *   س٢ الوضع الافتراضيّ OFF · س٥ صفر ازدواج بنيوياً · س٦ التوازن مفروضٌ عند الكتابة
 *   + سلوك CASCADE الذي يفرضه حذف الرصيد الافتتاحيّ في upsertOpeningEntry.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { isDupEntry } from "../../../shared/errorMap.ar";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  dropJournal,
  getDoubleEntryMode,
  writeJournal,
  writeJournalGap,
} from "../accounting/journalStore";
import type { JournalLine } from "../accounting/postingEngine";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const BALANCED: JournalLine[] = [
  { role: "AR", debit: "150.00", credit: "0.00" },
  { role: "SALES_STATIONERY", debit: "0.00", credit: "150.00" },
];
const UNBALANCED: JournalLine[] = [
  { role: "AR", debit: "150.00", credit: "0.00" },
  { role: "SALES_STATIONERY", debit: "0.00", credit: "149.00" },
];

async function reset() {
  await truncateTables([
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "doubleEntrySettings",
    "users",
  ]);
}

/** قيدٌ ماليٌّ حقيقيّ في الدفتر المبسّط ⇒ يُعيد معرّفه (الطرف المرجعيّ للقيد المزدوج). */
async function seedEntry(): Promise<number> {
  const res = await db()
    .insert(s.accountingEntries)
    .values({
      entryType: "SALE",
      revenue: "150.00",
      cost: "0.00",
      profit: "150.00",
      taxAmount: "0.00",
      amount: "150.00",
      entryDate: new Date("2026-08-11"),
    });
  return extractInsertId(res);
}

async function countRows() {
  const heads = await db().select({ id: s.journalEntries.id }).from(s.journalEntries);
  const lines = await db().select({ id: s.journalLines.id }).from(s.journalLines);
  return { heads: heads.length, lines: lines.length };
}

beforeEach(async () => {
  await reset();
});

describe("journalStore — وعاء الدفتر المزدوج (ش٠)", () => {
  it("أ) الوضع الافتراضيّ OFF حتى بلا صفّ إعدادات (س٢: فشلٌ آمن)", async () => {
    await withTx(async (tx) => {
      expect(await getDoubleEntryMode(tx)).toBe("OFF");
    });
  });

  it("أ٢) يقرأ الوضع المخزَّن حين يوجد الصفّ", async () => {
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode: "SHADOW" });
    await withTx(async (tx) => {
      expect(await getDoubleEntryMode(tx)).toBe("SHADOW");
    });
  });

  it("ب) قيدٌ متوازن ⇒ رأسٌ POSTED + أسطرٌ بالعدد الصحيح و Σمدين = Σدائن", async () => {
    const entryId = await seedEntry();
    await withTx(async (tx) => {
      await writeJournal(tx, entryId, new Date("2026-08-11"), 1, BALANCED);
    });

    const heads = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, entryId));
    expect(heads).toHaveLength(1);
    expect(heads[0].status).toBe("POSTED");
    expect(heads[0].unmappedReason).toBeNull();
    expect(heads[0].branchId).toBe(1);

    const lines = await db()
      .select()
      .from(s.journalLines)
      .where(eq(s.journalLines.journalId, heads[0].id));
    expect(lines).toHaveLength(2);
    const sum = (k: "debit" | "credit") =>
      lines.reduce((acc, l) => acc + Number(l[k]), 0);
    expect(sum("debit")).toBe(150);
    expect(sum("credit")).toBe(150);
    expect(lines.map((l) => l.role).sort()).toEqual(["AR", "SALES_STATIONERY"]);
  });

  it("ج) قيدٌ غير متوازن ⇒ يرمي ولا يكتب صفّاً واحداً (س٦)", async () => {
    const entryId = await seedEntry();
    await expect(
      withTx(async (tx) => {
        await writeJournal(tx, entryId, new Date("2026-08-11"), 1, UNBALANCED);
      }),
    ).rejects.toThrow(/غير متوازن/);
    expect(await countRows()).toEqual({ heads: 0, lines: 0 });
  });

  it("د) قيدان مزدوجان لنفس الحدث ⇒ يرفضه قيد القاعدة (س٥ — لا فحصٌ تطبيقيّ)", async () => {
    const entryId = await seedEntry();
    await withTx(async (tx) => {
      await writeJournal(tx, entryId, new Date("2026-08-11"), 1, BALANCED);
    });
    // drizzle يغلّف خطأ mysql ⇒ استعمل isDupEntry (تمشي على سلسلة cause) لا الفحص المباشر.
    let caught: unknown;
    try {
      await withTx(async (tx) => {
        await writeJournal(tx, entryId, new Date("2026-08-11"), 1, BALANCED);
      });
    } catch (e) {
      caught = e;
    }
    expect(isDupEntry(caught)).toBe(true);
    expect((await countRows()).heads).toBe(1);
  });

  it("هـ) فجوة ⇒ رأسٌ UNMAPPED بلا أسطر مع حفظ السبب", async () => {
    const entryId = await seedEntry();
    await withTx(async (tx) => {
      await writeJournalGap(tx, entryId, new Date("2026-08-11"), 1, "نوعٌ غير مُخطَّط: GIFT_OUT");
    });

    const heads = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, entryId));
    expect(heads).toHaveLength(1);
    expect(heads[0].status).toBe("UNMAPPED");
    expect(heads[0].unmappedReason).toContain("GIFT_OUT");
    expect((await countRows()).lines).toBe(0);
  });

  it("و) حذف القيد المالي يجرف قيده المزدوج (CASCADE — حالة upsertOpeningEntry)", async () => {
    const entryId = await seedEntry();
    await withTx(async (tx) => {
      await writeJournal(tx, entryId, new Date("2026-08-11"), 1, BALANCED);
    });
    expect(await countRows()).toEqual({ heads: 1, lines: 2 });

    await db().delete(s.accountingEntries).where(eq(s.accountingEntries.id, entryId));

    expect(await countRows()).toEqual({ heads: 0, lines: 0 });
  });

  it("ز) dropJournal يحذف الرأس وأسطره، ويصمت على حدثٍ بلا قيد", async () => {
    const entryId = await seedEntry();
    await withTx(async (tx) => {
      await writeJournal(tx, entryId, new Date("2026-08-11"), 1, BALANCED);
    });

    await withTx(async (tx) => {
      await dropJournal(tx, entryId);
    });
    expect(await countRows()).toEqual({ heads: 0, lines: 0 });

    // حدثٌ لا قيد له ⇒ لا رمية (تُستدعى في مسار التعديل قبل معرفة وجود قيدٍ سابق).
    await withTx(async (tx) => {
      await dropJournal(tx, 999_999);
    });
  });
});
