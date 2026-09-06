import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertApprover } from "./ownerGate";
import {
  cashVarianceApprovalRetainsLegacy,
  cashVarianceApprovalTrigger,
  voucherApprovalRetainsLegacy,
  voucherApprovalTrigger,
} from "@shared/approvalTriggers";

/**
 * عقدُ وصلِ بوّابة الاعتماد في السندات وفرق النقد والمصروفات.
 *
 * ## لماذا اختبارٌ ثالث بعد `approvalTriggers.test.ts` و`ownerGate.test.ts`
 *
 * الأوّلُ يحرس **التصنيف** والثاني يحرس **البوّابة**، وكلاهما يخضرّ وإنْ لم يُستدعَ في خدمةٍ
 * قطّ — أو استُدعي بتصنيفٍ غير تصنيفه. والفجوةُ التي تسقط فيها المراجعات هي **الوصل**:
 * أيُّ زوجٍ (`trigger`, `retainLegacy`) يمرّره كلُّ موضعٍ فعلاً، وهل بقي فحصُ فصل المهام
 * القائم **حرفياً** داخل `legacy`، وهل بقي الحارسُ التقنيّ **خارجها**.
 *
 * ولذلك جزآن: تركيبٌ سلوكيّ يُثبت أثرَ كل زوج، وحارسٌ نصّيّ يربط ذلك بالشيفرة المكتوبة —
 * فبلا الثاني يبقى الأوّل نظرياً لا يمنع أحداً من تبديل التصنيف داخل الخدمة.
 */

const FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
const OWNER = { userId: 1, branchId: 1, isOwner: true } as const;
const STAFF = { userId: 7, branchId: 1, isOwner: false } as const;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

/** الزوجُ الذي يمرّره موضعٌ واحد، كما هو في الخدمة حرفاً بحرف. */
interface WiredSite {
  name: string;
  trigger: "MONEY_OUT" | "ERASE_EFFECT" | null;
  retainLegacy: boolean;
}

const SITES: WiredSite[] = [
  {
    name: "approveVoucher · صرف (OUT) — نقد يغادر بحارس توفر وإيصال cashBucket",
    trigger: voucherApprovalTrigger("OUT", null),
    retainLegacy: voucherApprovalRetainsLegacy("OUT", null),
  },
  {
    name: "approveVoucher · قبض عادي (IN) — مستبقى بقرار المالك",
    trigger: voucherApprovalTrigger("IN", null),
    retainLegacy: voucherApprovalRetainsLegacy("IN", null),
  },
  {
    name: "approveVoucher · إلغاء سند قبض ⇒ إيصال OUT",
    trigger: voucherApprovalTrigger("OUT", "VOUCHER_CANCELLATION"),
    retainLegacy: voucherApprovalRetainsLegacy("OUT", "VOUCHER_CANCELLATION"),
  },
  {
    name: "approveVoucher · إلغاء سند صرف ⇒ إيصال IN على مستند منشور",
    trigger: voucherApprovalTrigger("IN", "VOUCHER_CANCELLATION"),
    retainLegacy: voucherApprovalRetainsLegacy("IN", "VOUCHER_CANCELLATION"),
  },
  {
    name: "approveVoucher · استرداد تصحيح استحقاق (IN)",
    trigger: voucherApprovalTrigger("IN", "ACCRUAL_CORRECTION_REFUND"),
    retainLegacy: voucherApprovalRetainsLegacy("IN", "ACCRUAL_CORRECTION_REFUND"),
  },
  {
    name: "approveCashVarianceCase · عجز",
    trigger: cashVarianceApprovalTrigger("SHORTAGE", "APPROVE"),
    retainLegacy: cashVarianceApprovalRetainsLegacy("SHORTAGE", "APPROVE"),
  },
  {
    name: "approveCashVarianceCase · زيادة — مستبقاة حتى يحسمها المالك",
    trigger: cashVarianceApprovalTrigger("SURPLUS", "APPROVE"),
    retainLegacy: cashVarianceApprovalRetainsLegacy("SURPLUS", "APPROVE"),
  },
  {
    name: "rejectCashVarianceCase · عجز",
    trigger: cashVarianceApprovalTrigger("SHORTAGE", "REJECT"),
    retainLegacy: cashVarianceApprovalRetainsLegacy("SHORTAGE", "REJECT"),
  },
  {
    name: "rejectCashVarianceCase · زيادة",
    trigger: cashVarianceApprovalTrigger("SURPLUS", "REJECT"),
    retainLegacy: cashVarianceApprovalRetainsLegacy("SURPLUS", "REJECT"),
  },
  // التصنيفان التاليان **مكتوبان صراحةً في موضع الاستدعاء** لأنّ `shared/approvalTriggers.ts`
  // لا يحمل مُصنِّفاً للمصروفات ولا لرفض السند بعد. وتثبيتُهما هنا يجعل أيّ تحويلٍ لاحق إلى
  // دالّةٍ مُصنِّفة تحويلاً **مُثبَت التكافؤ** لا تخميناً.
  { name: "approveExpense · صرف مصروف", trigger: "MONEY_OUT", retainLegacy: false },
  { name: "rejectExpense · رفض بلا أثر", trigger: null, retainLegacy: false },
  { name: "rejectVoucher · رفض بلا أثر", trigger: null, retainLegacy: false },
];

describe("الزوج الذي يمرره كل موضع — تثبيت لا اشتقاق", () => {
  it("جدول المواضع كما هو في الخدمات", () => {
    expect(SITES.map((s) => [s.name, s.trigger, s.retainLegacy])).toEqual([
      [
        "approveVoucher · صرف (OUT) — نقد يغادر بحارس توفر وإيصال cashBucket",
        "MONEY_OUT",
        false,
      ],
      ["approveVoucher · قبض عادي (IN) — مستبقى بقرار المالك", null, true],
      ["approveVoucher · إلغاء سند قبض ⇒ إيصال OUT", "MONEY_OUT", false],
      ["approveVoucher · إلغاء سند صرف ⇒ إيصال IN على مستند منشور", "ERASE_EFFECT", false],
      ["approveVoucher · استرداد تصحيح استحقاق (IN)", "ERASE_EFFECT", false],
      ["approveCashVarianceCase · عجز", "MONEY_OUT", false],
      ["approveCashVarianceCase · زيادة — مستبقاة حتى يحسمها المالك", null, true],
      ["rejectCashVarianceCase · عجز", null, false],
      ["rejectCashVarianceCase · زيادة", null, false],
      ["approveExpense · صرف مصروف", "MONEY_OUT", false],
      ["rejectExpense · رفض بلا أثر", null, false],
      ["rejectVoucher · رفض بلا أثر", null, false],
    ]);
  });

  it("قرار المالك: المستبقى موضعان اثنان لا غير — القبض العادي وزيادة فرق النقد", () => {
    expect(SITES.filter((s) => s.retainLegacy).map((s) => s.name)).toEqual([
      "approveVoucher · قبض عادي (IN) — مستبقى بقرار المالك",
      "approveCashVarianceCase · زيادة — مستبقاة حتى يحسمها المالك",
    ]);
  });
});

describe("العلم مطفأ — الموظف يعيد الفحص القائم والمالك يتجاوز الاعتماد الثاني", () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });

  it.each(SITES)("$name: legacy ينفَّذ للموظف فقط", (site) => {
    const staffLegacy = vi.fn();
    assertApprover({
      actor: STAFF,
      trigger: site.trigger,
      retainLegacy: site.retainLegacy,
      subject: site.name,
      legacy: staffLegacy,
    });
    expect(staffLegacy).toHaveBeenCalledTimes(1);

    const ownerLegacy = vi.fn();
    assertApprover({
      actor: OWNER,
      trigger: site.trigger,
      retainLegacy: site.retainLegacy,
      subject: site.name,
      legacy: ownerLegacy,
    });
    expect(ownerLegacy).not.toHaveBeenCalled();
  });

  it.each(SITES)("$name: رمي فصل المهام يبقى للموظف فقط", (site) => {
    expect(() =>
      assertApprover({
        actor: STAFF,
        trigger: site.trigger,
        retainLegacy: site.retainLegacy,
        subject: site.name,
        legacy: () => {
          throw new Error("فصل المهام القائم");
        },
      }),
    ).toThrow("فصل المهام القائم");
  });
});

describe("العلم مفتوح — الأثر المقصود لكل تصنيف", () => {
  beforeEach(() => {
    process.env[FLAG] = "ON";
  });

  it.each(SITES.filter((s) => s.trigger !== null))(
    "$name: يُحجب عن غير المالك ويمر للمالك، وفصل المهام القديم يسقط عنه",
    (site) => {
      const legacy = vi.fn();
      expect(() =>
        assertApprover({
          actor: STAFF,
          trigger: site.trigger,
          retainLegacy: site.retainLegacy,
          subject: site.name,
          legacy,
        }),
      ).toThrow(/اعتماد المالك/);
      assertApprover({
        actor: OWNER,
        trigger: site.trigger,
        retainLegacy: site.retainLegacy,
        subject: site.name,
        legacy,
      });
      // لا موضعَ ذا تصنيفٍ غير `null` يحمل استبقاءً ⇒ الفحصُ القديم لا يُستدعى أصلاً.
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  it.each(SITES.filter((s) => s.trigger === null && !s.retainLegacy))(
    "$name: لا بوابة ولا فحص قديم — يمر الموظف فوراً",
    (site) => {
      const legacy = vi.fn();
      assertApprover({
        actor: STAFF,
        trigger: site.trigger,
        retainLegacy: site.retainLegacy,
        subject: site.name,
        legacy,
      });
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  it.each(SITES.filter((s) => s.retainLegacy))(
    "$name: الضابط المستبقى يبقى للموظف ويسقط عن المالك",
    (site) => {
      const legacy = vi.fn(() => {
        throw new Error("الضابط المستبقى");
      });
      expect(() => assertApprover({
        actor: STAFF,
        trigger: site.trigger,
        retainLegacy: site.retainLegacy,
        subject: site.name,
        legacy,
      })).toThrow("الضابط المستبقى");
      expect(() => assertApprover({
        actor: OWNER,
        trigger: site.trigger,
        retainLegacy: site.retainLegacy,
        subject: site.name,
        legacy,
      })).not.toThrow();
    },
  );
});

// ═════════════ الحارس النصي — يربط الجدول أعلاه بالشيفرة فعلاً ═════════════════════════

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** كتل `assertApprover({...})` في ملف، مستخرَجة بموازنة الأقواس لا بـregex ساذج. */
function assertApproverBlocks(source: string): string[] {
  const blocks: string[] = [];
  const needle = "assertApprover({";
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    const open = start + needle.length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return blocks;
}

const FILES = {
  voucher: "server/services/voucher/approval.ts",
  cashVariance: "server/services/cashVarianceService.ts",
  expense: "server/services/expenseService.ts",
} as const;

/**
 * رسائلُ فصل المهام القائمة. ووجودُها **داخل** كتلة `assertApprover` هو الدليلُ النصّيّ على
 * أنّ الفحص نُقل ولم يُعَد كتابتُه: تغييرُ حرفٍ في أيٍّ منها يكسر هذا الاختبار قبل أن تصل
 * الرسالةُ المبدَّلة إلى موظّف.
 */
const SOD_MESSAGES: Record<keyof typeof FILES, string[]> = {
  voucher: [
    "لا يجوز اعتماد سند أنشأته بنفسك — يلزم مالك آخر",
    "لا يجوز لمن أنشأ القبض اعتماد إلغائه — يلزم مالك آخر",
    "لا يجوز رفض سند أنشأته بنفسك — يلزم مالك آخر",
  ],
  cashVariance: [
    "لا يجوز لمن اقترح التسوية اعتمادها",
    "لا يجوز لمن نفذ العد اعتماد فرق العد نفسه",
    "لا يجوز للموظف المسؤول اعتماد قضية فرق النقد الخاصة به",
    "قرار فرق النقد يحتاج مراجعاً مستقلاً",
  ],
  expense: [
    "لا يجوز لمن أنشأ طلب المصروف أن يعتمد طلبه بنفسه",
    "لا يجوز لمن أنشأ طلب المصروف أن يرفض طلبه بنفسه",
  ],
};

/**
 * حرّاسٌ **تقنيّون** لا علاقة لهم بالاعتماد: أهليّةُ الحساب ودورُه. وإبقاؤهم **خارج** البوّابة
 * هو الفرقُ بين «تشغيلُ السياسة يُبسّط الاعتماد» و«تشغيلُ السياسة يُسقط حارساً لم يُقصَد».
 */
const ALWAYS_ENFORCED: Record<keyof typeof FILES, string[]> = {
  voucher: ["اعتماد السندات محصور بحساب مالك نشط", "رفض السندات محصور بحساب مالك نشط"],
  cashVariance: ["اعتماد فرق النقد محصور بالإدارة أو المحاسبة"],
  expense: ["اعتماد المصروف أو رفضه يتطلب حساب مالك نشطاً"],
};

describe("الحارس النصي — الوصل كما هو في الشيفرة", () => {
  it.each(Object.entries(FILES))("%s: كل رسالة فصل مهام داخل legacy لا خارجها", (key, rel) => {
    const source = read(rel);
    const blocks = assertApproverBlocks(source).join("\n");
    for (const message of SOD_MESSAGES[key as keyof typeof FILES]) {
      expect(source, `${rel}: ${message}`).toContain(message);
      expect(blocks, `${rel}: ${message}`).toContain(message);
    }
  });

  it.each(Object.entries(FILES))("%s: الحارس التقني يبقى خارج البوابة", (key, rel) => {
    const source = read(rel);
    const blocks = assertApproverBlocks(source).join("\n");
    for (const message of ALWAYS_ENFORCED[key as keyof typeof FILES]) {
      expect(source, `${rel}: ${message}`).toContain(message);
      expect(blocks, `${rel}: ${message}`).not.toContain(message);
    }
  });

  it("السندات: ثلاثة مواضع، ومصنفها هو voucherApprovalTrigger لا نص ثابت", () => {
    const blocks = assertApproverBlocks(read(FILES.voucher));
    expect(blocks).toHaveLength(3);
    const wired = blocks.filter((b) => b.includes("voucherApprovalTrigger("));
    expect(wired).toHaveLength(2);
    for (const block of wired) {
      // الاستبقاء يُشتقّ من نفس المُصنِّف — لا `true`/`false` مكتوبة بيد.
      expect(block).toContain("voucherApprovalRetainsLegacy(");
    }
    // رفضُ السند: تصنيفٌ صريحٌ `null` حتى يُضيف القائد `voucherRejectionTrigger`.
    const rejection = blocks.find((b) => !b.includes("voucherApprovalTrigger("))!;
    expect(rejection).toContain("trigger: null");
  });

  it("فرق النقد: موضعان، وكلاهما يشتق التصنيف والاستبقاء من مصنفه", () => {
    const blocks = assertApproverBlocks(read(FILES.cashVariance));
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain("cashVarianceApprovalTrigger(");
      expect(block).toContain("cashVarianceApprovalRetainsLegacy(");
      // الاشتقاقُ من صيغة الخطّة (`varianceKindOf`) لا من عمود `variance` المنقول من المستند.
      expect(block).toContain("varianceKind");
    }
  });

  it("المصروفات: موضعان بتصنيف صريح ريثما يُضاف مصنفهما", () => {
    const blocks = assertApproverBlocks(read(FILES.expense));
    expect(blocks).toHaveLength(2);
    expect(blocks.filter((b) => b.includes('trigger: "MONEY_OUT"'))).toHaveLength(1);
    expect(blocks.filter((b) => b.includes("trigger: null"))).toHaveLength(1);
    // ولا استبقاءَ في أيٍّ منهما: لا قرارَ مالكٍ مكتوباً للمصروفات.
    expect(blocks.join("\n")).not.toContain("retainLegacy");
  });
});
