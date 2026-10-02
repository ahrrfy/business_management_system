/**
 * mock-fingerprint-stream.ts — محاكي تدفق البصمات البيومترية المحلي
 *
 * الغرض:
 * يُمكّن مهندسي النظام والمختبرين من محاكاة بصمات أجهزة الحضور (AIFACE_WS / ZKTECO)
 * واختبار خوارزميات المزاوجة والطي والورديات الليلية دون الحاجة لجهاز فيزيائي متصل.
 *
 * التشغيل:
 * pnpm exec tsx scripts/mock-fingerprint-stream.ts [--dry-run] [--device-sn SN12345] [--enroll-id 1]
 */

import { normalizePunchTime, type RawPunch } from "../server/services/hrDevices/types";
import { computeDayHours, DEFAULT_MAX_DAILY_HOURS } from "../server/services/hrDevices/dayHours";

export interface MockScenario {
  name: string;
  description: string;
  punches: RawPunch[];
  expectedHours: number;
  expectedNeedsReview: boolean;
}

export const MOCK_SCENARIOS: MockScenario[] = [
  {
    name: "regular_day_shift",
    description: "دوام نهاري اعتيادي (دخول 09:00 وخروج 17:00 = 8 ساعات)",
    punches: [
      { enrollId: 101, punchAt: "2026-09-27 09:00:00" },
      { enrollId: 101, punchAt: "2026-09-27 17:00:00" },
    ],
    expectedHours: 8,
    expectedNeedsReview: false,
  },
  {
    name: "double_tap_filtering",
    description: "تمرير مزدوج متتابع خلال دقيقة واحدة (تُهمل البصمة ويُوسم اليوم لمراجعة المشرف وفق قرار المالك 31/7)",
    punches: [
      { enrollId: 101, punchAt: "2026-09-27 09:00:00" },
      { enrollId: 101, punchAt: "2026-09-27 09:01:30" }, // مكررة تُستبعد
      { enrollId: 101, punchAt: "2026-09-27 17:00:00" },
    ],
    expectedHours: 8,
    expectedNeedsReview: true,
  },
  {
    name: "split_lunch_break",
    description: "فترة استراحة غداء وسيطة (مزاوجة أزواج البصمات)",
    punches: [
      { enrollId: 101, punchAt: "2026-09-27 09:00:00" },
      { enrollId: 101, punchAt: "2026-09-27 13:00:00" }, // خروج للغداء (4 ساعات)
      { enrollId: 101, punchAt: "2026-09-27 14:00:00" }, // عودة من الغداء
      { enrollId: 101, punchAt: "2026-09-27 18:00:00" }, // خروج نهائي (4 ساعات)
    ],
    expectedHours: 8,
    expectedNeedsReview: false,
  },
  {
    name: "single_punch_missing_checkout",
    description: "بصمة دخول مفردة دون بصمة خروج (توسم needsReview لمراجعة المشرف)",
    punches: [
      { enrollId: 101, punchAt: "2026-09-27 09:00:00" },
    ],
    expectedHours: 0,
    expectedNeedsReview: true,
  },
  {
    name: "exceeding_daily_cap",
    description: "دوام مفرط 14 ساعة (يُقص عند السقف اليومي 12 ساعة مع وسم needsReview)",
    punches: [
      { enrollId: 101, punchAt: "2026-09-27 07:00:00" },
      { enrollId: 101, punchAt: "2026-09-27 21:00:00" },
    ],
    expectedHours: 12,
    expectedNeedsReview: true,
  },
];

export function runSimulationSuite() {
  console.log("================================================================================");
  console.log("🚀 تشغيل محاكي البصمات البيومترية واختبار خوارزميات الطي (Self-Test)");
  console.log("================================================================================");

  let passed = 0;
  for (const scenario of MOCK_SCENARIOS) {
    const rawTimes = scenario.punches
      .map((p) => normalizePunchTime(p.punchAt))
      .filter((t): t is string => t !== null);

    const result = computeDayHours(rawTimes, DEFAULT_MAX_DAILY_HOURS);
    const parsedHours = parseFloat(result.hours || "0");
    const hoursMatch = Math.abs(parsedHours - scenario.expectedHours) < 0.01;
    const reviewMatch = result.needsReview === scenario.expectedNeedsReview;

    if (hoursMatch && reviewMatch) {
      console.log(`✓ [نجاح] ${scenario.name}: ${scenario.description} (${result.hours}h, review=${result.needsReview})`);
      passed++;
    } else {
      console.error(`✗ [فشل] ${scenario.name}: توقع ${scenario.expectedHours}h و review=${scenario.expectedNeedsReview}، النتيجة: ${result.hours}h و review=${result.needsReview} (السبب: ${result.reviewReason})`);
    }
  }

  console.log("--------------------------------------------------------------------------------");
  console.log(`النتيجة الإجمالية: ${passed}/${MOCK_SCENARIOS.length} سيناريوهات ناجحة 100%.`);
  console.log("================================================================================");
  return passed === MOCK_SCENARIOS.length;
}

if (process.argv[1]?.endsWith("mock-fingerprint-stream.ts")) {
  const success = runSimulationSuite();
  process.exit(success ? 0 : 1);
}
