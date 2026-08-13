import { afterEach, describe, expect, it, vi } from "vitest";
import {
  docToHtml,
  docToRaster,
  fitWithinWidth,
  wrapMeasuredText,
  type TextMeasureLike,
} from "./render";
import {
  reservationToTicketDoc,
  type ReservationTicketSource,
} from "./reservationTicket";

afterEach(() => vi.unstubAllGlobals());

const reservation: ReservationTicketSource = {
  reservationNumber: "RES-1-20260813-00001",
  createdAt: "2026-08-13T09:00:00.000Z",
  expiresAt: "2026-08-14T09:00:00.000Z",
  status: "ACTIVE",
  contactName: "عميل الاختبار",
  contactPhone: "+9647712345678",
  notes: "ملاحظة أولى\nملاحظة ثانية طويلة يجب أن تلتف داخل عرض الورقة",
  total: "24000.00",
  lines: [
    {
      productName:
        "ملزمة دراسية ذات اسم عربي طويل جداً للتحقق من الالتفاف إلى سطرين فقط",
      variantName: "الطبعة المحدّثة",
      color: "أزرق",
      size: "A4",
      unitName: "قطعة",
      quantity: 2,
      quotedUnitPrice: "12000.00",
      lineTotal: "24000.00",
    },
  ],
};

describe("reservation ticket 80mm contract", () => {
  it("يبني itemBlocks منظمة بلا حشر سطر جديد داخل خلية جدول", () => {
    const doc = reservationToTicketDoc(reservation);

    expect(doc.rows).toBeUndefined();
    expect(doc.columns).toEqual(["المنتج", "الإجمالي"]);
    expect(doc.itemBlocks).toEqual([
      {
        name: "ملزمة دراسية ذات اسم عربي طويل جداً للتحقق من الالتفاف إلى سطرين فقط — أزرق · A4 · الطبعة المحدّثة",
        quantityPrice: "2 × 12,000.00 / قطعة",
        total: "24,000.00",
      },
    ]);
    expect(doc.itemBlocks?.[0].name).not.toContain("\n");
    expect(doc.itemBlocks?.[0].quantityPrice).not.toContain("\n");
  });

  it("يعرض العقد نفسه ككتلة HTML ويلف meta/footer من دون الرجوع إلى table", async () => {
    const html = await docToHtml(reservationToTicketDoc(reservation));

    expect(html).toContain('class="item-block"');
    expect(html).toContain('class="item-name"');
    expect(html).toContain('class="item-qty-price"');
    expect(html).toContain('class="item-total"');
    expect(html).toContain("-webkit-line-clamp:2");
    expect(html).toContain("ملاحظة أولى<br>ملاحظة ثانية طويلة");
    expect(html).not.toContain("<table>");
  });

  it("يبقي columns/rows القديمة على مسار الجدول للمستهلكين الآخرين", async () => {
    const html = await docToHtml({
      kind: "opening",
      title: "سند",
      meta: [],
      columns: ["البيان", "المبلغ"],
      rows: [["رصيد افتتاحي", "10,000.00"]],
      footer: "السطر الأول\nالسطر الثاني",
    });

    expect(html).toContain("<table>");
    expect(html).toContain('<td style="text-align:right">رصيد افتتاحي</td>');
    expect(html).toContain("السطر الأول<br>السطر الثاني");
  });
});

describe("thermal text measurement", () => {
  const measure: TextMeasureLike = {
    measureText: (text) => ({ width: Array.from(text).length * 10 }),
  };

  it("يحترم الفواصل الصريحة ويقسّم الكلمة الأطول من عرض المحتوى", () => {
    expect(wrapMeasuredText(measure, "سطر أول\nسطر ثان", 100)).toEqual([
      "سطر أول",
      "سطر ثان",
    ]);
    expect(wrapMeasuredText(measure, "abcdefghijk", 50)).toEqual([
      "abcde",
      "fghij",
      "k",
    ]);
  });

  it("يقصر اسم البند إلى سطرين بعلامة حذف داخلة في العرض", () => {
    const lines = wrapMeasuredText(measure, "abcdefghijk", 50, 2);

    expect(lines).toEqual(["abcde", "fghi…"]);
    expect(lines.every((line) => measure.measureText(line).width <= 50)).toBe(
      true,
    );
  });

  it("يصغّر Code128 بنسبة ثابتة إلى عرض المحتوى الآمن", () => {
    const fitted = fitWithinWidth(900, 90, 548);
    expect(fitted.width).toBe(548);
    expect(fitted.height).toBeCloseTo(54.8);
    expect(fitWithinWidth(400, 90, 548)).toEqual({ width: 400, height: 90 });
  });

  it("يزيد ارتفاع raster ديناميكياً عندما تلتف meta/footer", async () => {
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = { width: 0, height: 0 };
        const context = {
          font: "",
          fillStyle: "#000",
          strokeStyle: "#000",
          lineWidth: 1,
          textAlign: "center",
          direction: "rtl",
          measureText: (text: string) => ({
            width: Array.from(text).length * 10,
          }),
          fillRect: vi.fn(),
          fillText: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          setLineDash: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          stroke: vi.fn(),
          getImageData: () => {
            const data = new Uint8ClampedArray(
              canvas.width * canvas.height * 4,
            );
            data.fill(255);
            return { data };
          },
        };
        return Object.assign(canvas, { getContext: () => context });
      },
    });

    const short = await docToRaster(
      { kind: "opening", title: "سند", meta: ["بيان قصير"], footer: "توقيع" },
      200,
    );
    const long = await docToRaster(
      {
        kind: "opening",
        title: "سند",
        meta: ["بيان طويل جداً يلتف على عدة أسطر داخل العرض الحراري الضيق"],
        footer:
          "تذييل طويل جداً يلتف كذلك ولا يُقص خارج نهاية مساحة الرسم الديناميكية",
      },
      200,
    );

    expect(short?.width).toBe(200);
    expect(long?.height).toBeGreaterThan(short?.height ?? 0);
  });
});
