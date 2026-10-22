/**
 * نواة اتّساق ساعات اليوم مع وقتَي الدخول والانصراف (shared/attendanceHours.ts).
 *
 * الحزمة تُثبّت الاتجاهين معاً — المنعَ حيث يجب و**المرورَ حيث يجب**. الثاني ليس تزيّناً:
 * الطيّ التلقائي يُنتج ساعاتٍ أقلّ من المدى مشروعةً (الاستراحات مطروحة بمزاوجة البصمات)،
 * فحارسٌ يفرض المساواة يوقف ingest الأجهزة كلَّه.
 */
import { describe, expect, it } from "vitest";
import { HOURS_SPAN_TOLERANCE, attendanceHoursViolation, parseManualAttendanceEdit, spanHours } from "./attendanceHours";

const paid = (hours: number, checkIn: string | null, checkOut: string | null) =>
  attendanceHoursViolation({ checkIn, checkOut, hours, isPaidStatus: true });

describe("spanHours", () => {
  it("يحسب المدى بمنزلتين", () => {
    expect(spanHours("08:00", "17:00")).toBe(9);
    expect(spanHours("07:53", "22:49")).toBe(14.93);
    expect(spanHours("16:02", "23:10")).toBe(7.13);
  });

  it("يُرجع null حين ينقص وقتٌ أو لا يكون الانصراف بعد الدخول", () => {
    expect(spanHours("08:00", null)).toBeNull();
    expect(spanHours(null, "17:00")).toBeNull();
    expect(spanHours("17:00", "08:00")).toBeNull(); // لا يعبر منتصف الليل
    expect(spanHours("08:00", "08:00")).toBeNull(); // مدىً صفر ليس دواماً
    expect(spanHours("8:0", "17:00")).toBeNull(); // تنسيق غير صالح
    expect(spanHours("25:00", "26:00")).toBeNull(); // ساعة خارج النطاق
  });

  it("يحسب المدى العابر لمنتصف الليل بدقة عند تفعيل crossMidnight", () => {
    expect(spanHours("15:07", "00:02", { crossMidnight: true })).toBe(8.92);
    expect(spanHours("15:01", "00:03", { crossMidnight: true })).toBe(9.03);
    expect(spanHours("22:00", "06:00", { crossMidnight: true })).toBe(8);
  });
});

describe("attendanceHoursViolation — ما يجب منعه", () => {
  it("يمنع ساعاتٍ تتجاوز المدى (أجرُ وقتٍ لم يقع)", () => {
    expect(paid(15, "08:00", "17:00")).toMatch(/تتجاوز المدى/);
  });

  it("يمنع صفر ساعاتٍ مع وقتين كاملين — الفخّ الذي يُصفّر أجر اليوم", () => {
    expect(paid(0, "07:58", "17:00")).toMatch(/صفراً/);
  });

  it("يمنع انصرافاً قبل الدخول", () => {
    expect(paid(5, "17:00", "08:00")).toMatch(/بعد وقت الدخول/);
  });

  it("يمنع ساعاتٍ غير رقمية", () => {
    expect(paid(Number.NaN, "08:00", "17:00")).toMatch(/غير صالحة/);
  });
});

describe("attendanceHoursViolation — ما يجب أن يمرّ", () => {
  it("يمرّر ساعاتٍ أقلّ من المدى — الاستراحة المطروحة بالمزاوجة (مسار الطيّ)", () => {
    expect(paid(8, "08:00", "20:00")).toBeNull();
  });

  it("يمرّر المساواة التامّة", () => {
    expect(paid(9, "08:00", "17:00")).toBeNull();
  });

  it("يمرّر الوردية العابرة لمنتصف الليل عند تفعيل crossMidnight ويمنع التجاوز", () => {
    expect(
      attendanceHoursViolation({
        checkIn: "15:07",
        checkOut: "00:02",
        hours: 8.92,
        isPaidStatus: true,
        crossMidnight: true,
      }),
    ).toBeNull();
    expect(
      attendanceHoursViolation({
        checkIn: "15:07",
        checkOut: "00:02",
        hours: 10,
        isPaidStatus: true,
        crossMidnight: true,
      }),
    ).toMatch(/تتجاوز المدى/);
  });

  it("يمرّر تجاوزاً داخل التسامح — قصّ الثواني في HH:MM لا يكسر الطيّ", () => {
    // أقصى انحرافٍ بنيويّ: ٥٩ ثانية ≈ 0.0164 ساعة + تقريب منزلتين.
    expect(paid(9 + HOURS_SPAN_TOLERANCE, "08:00", "17:00")).toBeNull();
    expect(paid(9.02, "08:00", "17:00")).toBeNull();
  });

  it("يمنع تجاوزاً يفوق التسامح ولو بقليل", () => {
    expect(paid(9 + HOURS_SPAN_TOLERANCE + 0.01, "08:00", "17:00")).toMatch(/تتجاوز المدى/);
  });

  it("لا حكم بلا وقتين كاملين — البصمة الفردية حالةٌ مشروعة تُوسَم للمراجعة", () => {
    expect(paid(0, "07:58", null)).toBeNull();
    expect(paid(0, null, null)).toBeNull();
    expect(paid(12, "07:58", null)).toBeNull();
  });

  it("يمرّر صفر ساعاتٍ لحالةٍ بلا أجر — الغياب المعلَن ليس فخّاً", () => {
    expect(attendanceHoursViolation({ checkIn: "08:00", checkOut: "17:00", hours: 0, isPaidStatus: false })).toBeNull();
  });

  it("يبقى الاتجاه الأعلى محروساً حتى لحالةٍ بلا أجر", () => {
    expect(attendanceHoursViolation({ checkIn: "08:00", checkOut: "17:00", hours: 20, isPaidStatus: false })).toMatch(/تتجاوز المدى/);
  });
});

describe("isLegacyAutoLateDeduction — حماية التعديلات اليدوية من الطمس عند الشفاء التلقائي", async () => {
  const { isLegacyAutoLateDeduction } = await import("../server/services/attendanceService");

  it("يرصد سجل البصمة القديم المتضرر من خصم التأخير التلقائي ليُصلحه", () => {
    expect(
      isLegacyAutoLateDeduction(
        {
          attendanceDate: "2026-10-01",
          source: "fingerprint",
          status: "LATE",
          checkIn: new Date("2026-10-01T14:15:00Z"),
          notes: "[تأخير: 315 دقيقة - خصم 315 دقيقة]",
          reviewReason: null,
        },
        null,
      ),
    ).toBe(true);
  });

  it("يرصد سجل التصحيح اليدوي القديم الذي خُرِّب بفرضية 09:00 الوهمية (خصم = تأخير عن 09:00 حرفياً وبلا وسم manual_late_override)", () => {
    expect(
      isLegacyAutoLateDeduction(
        {
          attendanceDate: "2026-10-05",
          source: "manual",
          status: "LATE",
          checkIn: new Date("2026-10-05T15:07:00Z"), // 15*60+7 - 540 = 367 دقيقة
          notes: "[تأخير: 367 دقيقة - خصم 367 دقيقة]",
          reviewReason: null,
        },
        null,
      ),
    ).toBe(true);
  });

  it("لا يمسّ التعديل اليدوي المقصود للمدير (ساعات مخصّصة أو ملاحظة يدوية أو خصم تأخير يدوي موسوم بـ manual_late_override)", () => {
    // ١) خصم تأخير يدوي صريح من المدير
    expect(
      isLegacyAutoLateDeduction(
        {
          attendanceDate: "2026-10-05",
          source: "manual",
          status: "LATE",
          checkIn: new Date("2026-10-05T10:00:00Z"),
          notes: "[تأخير: 60 دقيقة - خصم 30 دقيقة] خصم إداري معتمد",
          reviewReason: "manual_late_override",
        },
        { الاثنين: { hours: 8, start: "09:00" } },
      ),
    ).toBe(false);

    // ٢) تعديل ساعات يدوي بدون وسم تأخير تلقائي قديم
    expect(
      isLegacyAutoLateDeduction(
        {
          attendanceDate: "2026-10-06",
          source: "manual",
          status: "PRESENT",
          checkIn: new Date("2026-10-06T14:00:00Z"),
          notes: "طرح ساعة استراحة خارجية",
          reviewReason: null,
        },
        null,
      ),
    ).toBe(false);

    // ٣) حتى لو تساوى الخصم اليدوي الصريح مع دقائق التأخير عن 09:00، وجود manual_late_override يحميه من الشفاء التلقائي
    expect(
      isLegacyAutoLateDeduction(
        {
          attendanceDate: "2026-10-05",
          source: "manual",
          status: "LATE",
          checkIn: new Date("2026-10-05T10:00:00Z"), // 60 دقيقة بعد 09:00
          notes: "[تأخير: 60 دقيقة - خصم 60 دقيقة]",
          reviewReason: "manual_late_override",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("parseManualAttendanceEdit — استعادة الساعات قبل الخصم ومنع الخصم المزدوج عند إعادة التصحيح", () => {
  it("يستعيد الساعات الإجمالية (8.00) ودقائق الخصم (30) عند إعادة فتح صفّ سبق خصم 30 دقيقة منه (المخزّن 7.50)", () => {
    const parsed = parseManualAttendanceEdit({
      status: "LATE",
      checkIn: "10:00",
      checkOut: "18:00",
      storedHours: "7.50",
      notes: "تأخر بسبب الازدحام [تأخير: 60 دقيقة - خصم 30 دقيقة]",
      reviewReason: "manual_late_override",
    });

    expect(parsed).toEqual({
      status: "LATE",
      hours: "8.00",
      lateDeductionMinutes: "30",
      notes: "تأخر بسبب الازدحام",
    });
  });

  it("يتعامل مع التقريب الدوري (مثلاً خصم 20 دقيقة = 0.33 ساعة من 8 ساعات -> مخزّن 7.67) ويعيده إلى 8.00", () => {
    const parsed = parseManualAttendanceEdit({
      status: "LATE",
      checkIn: "09:20",
      checkOut: "17:20",
      storedHours: "7.67",
      notes: "[تأخير: 20 دقيقة - خصم 20 دقيقة]",
      reviewReason: "manual_late_override",
    });

    expect(parsed.hours).toBe("8.00");
    expect(parsed.lateDeductionMinutes).toBe("20");
    expect(parsed.notes).toBe("");
  });

  it("يحافظ على الساعات المخصّصة يدوياً (مثلاً 7 ساعات بدلاً من 8 بعد طرح استراحة) مع أو بدون خصم تأخير", () => {
    const withoutLate = parseManualAttendanceEdit({
      status: "PRESENT",
      checkIn: "14:00",
      checkOut: "22:00",
      storedHours: "7.00",
      notes: "طرح ساعة استراحة",
      reviewReason: null,
    });
    expect(withoutLate).toEqual({
      status: "PRESENT",
      hours: "7.00",
      lateDeductionMinutes: "",
      notes: "طرح ساعة استراحة",
    });

    // ساعات مخصّصة 7 ساعات + خصم 30 دقيقة (المخزّن 6.50) -> يستعيد 7.00 ساعة + 30 دقيقة خصم دون القفز إلى 8.00
    const withLate = parseManualAttendanceEdit({
      status: "LATE",
      checkIn: "14:00",
      checkOut: "22:00",
      storedHours: "6.50",
      notes: "استراحة + تأخير [تأخير: 30 دقيقة - خصم 30 دقيقة]",
      reviewReason: "manual_late_override",
    });
    expect(withLate).toEqual({
      status: "LATE",
      hours: "7.00",
      lateDeductionMinutes: "30",
      notes: "استراحة + تأخير",
    });
  });

  it("يصفّر الساعات ودقائق الخصم لأيام الغياب والإجازة", () => {
    expect(
      parseManualAttendanceEdit({
        status: null,
        state: "absent",
        storedHours: "0.00",
        notes: "غياب بدون عذر",
      }),
    ).toEqual({
      status: "ABSENT",
      hours: "0",
      lateDeductionMinutes: "",
      notes: "غياب بدون عذر",
    });
  });
});

describe("الدوام المجزّأ والاستراحة / الزمنية (computeSessionsSummary & parseAttendanceDayDetails)", async () => {
  const {
    buildDefaultSplitSessions,
    computeSessionsSummary,
    formatAttendanceSessionsTag,
    formatDurationArabic,
    parseAttendanceDayDetails,
    suggestNextSplitSession,
  } = await import("./attendanceHours");

  it("يحسب فترات الدوام المتعددة والاستراحة بينها بدقة (مثلاً 08:00→12:00 ثم 16:00→20:00)", () => {
    const res = computeSessionsSummary([
      { checkIn: "08:00", checkOut: "12:00" },
      { checkIn: "16:00", checkOut: "20:00" },
    ]);
    expect(res.violation).toBeNull();
    expect(res.totalHours).toBe(8);
    expect(res.breakMinutes).toBe(240);
    expect(res.breakHours).toBe("4.00");
    expect(res.firstCheckIn).toBe("08:00");
    expect(res.lastCheckOut).toBe("20:00");
    expect(res.breaks).toEqual([{ from: "12:00", to: "16:00", minutes: 240, hours: "4.00" }]);
  });

  it("يرفض تداخل الفترات أو انعكاس ترتيبها الزمني أو ترك فترة مفتوحة بلا انصراف عند الحفظ", () => {
    const overlap = computeSessionsSummary([
      { checkIn: "08:00", checkOut: "13:00" },
      { checkIn: "12:30", checkOut: "17:00" },
    ]);
    expect(overlap.violation).toContain("متداخلة أو غير مرتّبة");

    const reversed = computeSessionsSummary([
      { checkIn: "12:00", checkOut: "08:00" },
    ]);
    expect(reversed.violation).toContain("وقت الانصراف");

    const openLast = computeSessionsSummary([
      { checkIn: "08:00", checkOut: "12:00" },
      { checkIn: "16:00", checkOut: null },
    ]);
    expect(openLast.hasOpenSession).toBe(true);
    expect(openLast.violation).toContain("حدد وقت انصراف الفترة رقم 2");
  });

  it("يصوغ ويحلّل وسم الفترات والاستراحة ويستخرج الملاحظة النظيفة دون تداخل مع وسم التأخير", () => {
    const tag = formatAttendanceSessionsTag(
      [
        { checkIn: "08:00", checkOut: "12:00" },
        { checkIn: "14:00", checkOut: "18:00" },
      ],
      120,
    );
    expect(tag).toBe("[فترات الدوام: 08:00→12:00، 14:00→18:00 | استراحة/زمنية: 120 دقيقة]");

    const details = parseAttendanceDayDetails({
      checkIn: "08:00",
      checkOut: "18:00",
      storedHours: "7.50",
      notes: `إذن زمنية ظهرية ${tag} [تأخير: 30 دقيقة - خصم 30 دقيقة]`,
      reviewReason: "manual_late_override",
    });
    expect(details.hasMultipleSessions).toBe(true);
    expect(details.sessions).toHaveLength(2);
    expect(details.breakMinutes).toBe(120);
    expect(details.breakHours).toBe("2.00");
    expect(details.cleanNotes).toBe("إذن زمنية ظهرية");

    const manualEdit = parseManualAttendanceEdit({
      status: "LATE",
      checkIn: "08:00",
      checkOut: "18:00",
      storedHours: "7.50",
      notes: `إذن زمنية ظهرية ${tag} [تأخير: 30 دقيقة - خصم 30 دقيقة]`,
      reviewReason: "manual_late_override",
    });
    expect(manualEdit.hours).toBe("8.00");
    expect(manualEdit.lateDeductionMinutes).toBe("30");
    expect(manualEdit.notes).toBe("إذن زمنية ظهرية");
  });

  it("يستنتج الاستراحة/الزمنية تلقائياً لليوم ذي الفترة الواحدة عندما يكون صافي الساعات أقل من المدى الكلي، ولا يختلق استراحة عند القصّ بسقف الساعات اليومي", () => {
    const details = parseAttendanceDayDetails({
      checkIn: "08:00",
      checkOut: "17:00",
      storedHours: "8.00",
      notes: "ساعة استراحة غداء",
      reviewReason: null,
    });
    expect(details.hasMultipleSessions).toBe(false);
    expect(details.breakMinutes).toBe(60);
    expect(details.breakHours).toBe("1.00");
    expect(formatDurationArabic(details.breakMinutes)).toBe("1 س");
    expect(formatDurationArabic(90)).toBe("1 س و30 د");

    const capped = parseAttendanceDayDetails({
      checkIn: "04:00",
      checkOut: "23:59",
      storedHours: "12.00",
      notes: null,
      reviewReason: "ساعات اليوم (19.98) تجاوزت السقف اليومي (12) — قُصّت عند سقف (12) وتحتاج مراجعة",
    });
    expect(capped.breakMinutes).toBe(0);
    expect(capped.hasMultipleSessions).toBe(false);
  });

  it("يميز بين بصمة وحيدة ناقصة (فترة واحدة بلا خروج) وبين 3 بصمات (فترة ثانية مفتوحة)", () => {
    const singleOpen = parseAttendanceDayDetails({
      checkIn: "08:00",
      checkOut: null,
      storedHours: "0.00",
      notes: null,
      reviewReason: "بصمة واحدة فقط — ينقص تسجيل الدخول أو الخروج",
    });
    expect(singleOpen.hasMultipleSessions).toBe(false);
    expect(singleOpen.hasOpenSession).toBe(false);
    expect(singleOpen.openSessionCheckIn).toBeNull();

    const details = parseAttendanceDayDetails({
      checkIn: "08:00",
      checkOut: "12:00",
      storedHours: "4.00",
      notes: "[فترات الدوام: 08:00→12:00، 16:00→؟ | استراحة/زمنية: 240 دقيقة]",
      reviewReason: "عدد البصمات فرديّ — ينقص تسجيل خروج (بصمة دخول 16:00 بلا انصراف)",
    });
    expect(details.hasMultipleSessions).toBe(true);
    expect(details.hasOpenSession).toBe(true);
    expect(details.openSessionCheckIn).toBe("16:00");
    expect(details.breakMinutes).toBe(240);

    // سجل 3 بصمات قديم بلا وسم [فترات الدوام:] في الملاحظات يستعيد الفترتين من reviewReason
    const legacyThreePunch = parseAttendanceDayDetails({
      checkIn: "08:00",
      checkOut: "12:00",
      storedHours: "4.00",
      notes: null,
      reviewReason: "عدد البصمات فرديّ — ينقص تسجيل خروج (بصمة دخول 16:00 بلا انصراف)",
    });
    expect(legacyThreePunch.hasMultipleSessions).toBe(true);
    expect(legacyThreePunch.hasOpenSession).toBe(true);
    expect(legacyThreePunch.openSessionCheckIn).toBe("16:00");
    expect(legacyThreePunch.breakMinutes).toBe(240);
  });

  it("يبني فترات افتراضية صالحة زمنياً لأي وردية (صباحية 08→16، مسائية 14→22، ممتدة 08→20، أو ليلية عابرة لمنتصف الليل)", () => {
    for (const [inHm, outHm, cross] of [
      ["08:00", "16:00", false],
      ["14:00", "22:00", false],
      ["08:00", "20:00", false],
      ["16:00", "00:30", true],
    ] as const) {
      const defaults = buildDefaultSplitSessions(inHm, outHm, { crossMidnight: cross });
      const summary = computeSessionsSummary(defaults);
      expect(summary.violation).toBeNull();
      expect(summary.firstCheckIn).toBe(inHm);
      expect(summary.lastCheckOut).toBe(outHm);
      expect(summary.lastCrossMidnight).toBe(cross);
      expect(summary.breakMinutes).toBeGreaterThan(0);
    }

    const nextThird = suggestNextSplitSession([
      { checkIn: "08:00", checkOut: "12:00" },
      { checkIn: "14:00", checkOut: "18:00" },
    ]);
    expect(nextThird).toEqual({ checkIn: "19:00", checkOut: "21:00", crossMidnight: false });
  });

  it("يتحقق من عدم تجاوز الاستراحة أو الساعات الصافية للمدى في نمط الفترة الواحدة", () => {
    expect(
      attendanceHoursViolation({
        checkIn: "08:00",
        checkOut: "12:00",
        hours: 4,
        isPaidStatus: true,
        breakMinutes: 240,
      }),
    ).toMatch(/تساوي أو تتجاوز المدى/);

    expect(
      attendanceHoursViolation({
        checkIn: "08:00",
        checkOut: "16:00",
        hours: 8,
        isPaidStatus: true,
        breakMinutes: 60,
      }),
    ).toMatch(/تتجاوز الصافي بعد خصم الاستراحة/);

    expect(
      attendanceHoursViolation({
        checkIn: "08:00",
        checkOut: "16:00",
        hours: 7,
        isPaidStatus: true,
        breakMinutes: 60,
      }),
    ).toBeNull();
  });
});
