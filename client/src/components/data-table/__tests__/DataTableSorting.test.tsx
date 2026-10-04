// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  numericFromDisplay,
  compareNumericDisplay,
  parseDateDisplay,
  compareDateDisplay,
  compareTextDisplay,
  sortingFnForKind,
} from "@/components/data-table/columnContract";
import { DataTableColumnHeader } from "@/components/data-table/DataTableColumnHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { Column, ColumnDef } from "@tanstack/react-table";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DataTable Smart Sorting Contract", () => {
  describe("numericFromDisplay", () => {
    it("يستخرج الأعداد البسيطة والفواصل العشرية", () => {
      expect(numericFromDisplay(1500)).toBe(1500);
      expect(numericFromDisplay(-25.5)).toBe(-25.5);
      expect(numericFromDisplay(0)).toBe(0);
      expect(numericFromDisplay("0")).toBe(0);
      expect(numericFromDisplay("0 د.ع")).toBe(0);
    });

    it("يستخرج المبالغ المنسقة مع العملات وفواصل الآلاف", () => {
      expect(numericFromDisplay("1,500 د.ع")).toBe(1500);
      expect(numericFromDisplay("1,500,000 د.ع")).toBe(1500000);
      expect(numericFromDisplay("$250.75")).toBe(250.75);
    });

    it("يدعم الأرصدة السالبة بإشارات متعددة (Unicode minus U+2212 والشرطات)", () => {
      expect(numericFromDisplay("−1,500 د.ع")).toBe(-1500);
      expect(numericFromDisplay("-500")).toBe(-500);
      expect(numericFromDisplay("–750 د.ع")).toBe(-750);
      expect(numericFromDisplay("—1,200")).toBe(-1200);
    });

    it("يدعم الأقواس المحاسبية للأرصدة السالبة", () => {
      expect(numericFromDisplay("(1,500 د.ع)")).toBe(-1500);
      expect(numericFromDisplay("(250)")).toBe(-250);
      expect(numericFromDisplay("($1,500)")).toBe(-1500);
      expect(numericFromDisplay("(1,500) د.ع")).toBe(-1500);
      expect(numericFromDisplay("د.ع (1,500)")).toBe(-1500);
      expect(numericFromDisplay("الرصيد: (1,500 د.ع)")).toBe(-1500);
      expect(numericFromDisplay("( 1,500.50 )")).toBe(-1500.5);
      expect(numericFromDisplay("(1,000.50) (مدفوع: 200.25)")).toBe(-1000.5);
      // الملاحظات اللاحقة بين قوسين لا تجعل العدد الأساسي سالباً
      expect(numericFromDisplay("1,000.50 (مدفوع: 200.25)")).toBe(1000.5);
      expect(numericFromDisplay("ملاحظة (هام): 1,500")).toBe(1500);
      expect(numericFromDisplay("فاتورة (123)")).toBe(123);
    });

    it("يطبّع الأرقام الهندية/العربية إلى لاتينية ويستخرج قيمها بدقة", () => {
      expect(numericFromDisplay("١,٥٠٠ د.ع")).toBe(1500);
      expect(numericFromDisplay("−٢,٥٠٠")).toBe(-2500);
      expect(numericFromDisplay("٠")).toBe(0);
    });

    it("يدعم الفواصل والكسور العشرية العربية وفواصل الآلاف العربية بدقة", () => {
      // U+066B فاصلة عشرية عربية ٫، U+066C فاصلة آلاف عربية ٬
      expect(numericFromDisplay("١٬٥٠٠٫٥ د.ع")).toBe(1500.5);
      expect(numericFromDisplay("1،500 د.ع")).toBe(1500);
      expect(numericFromDisplay("1,500.75")).toBe(1500.75);
    });

    it("يستخرج الأعداد التي تبدأ بفاصلة عشرية مباشرة", () => {
      expect(numericFromDisplay(".5")).toBe(0.5);
      expect(numericFromDisplay("-.75")).toBe(-0.75);
      expect(numericFromDisplay("٫٥")).toBe(0.5);
      expect(numericFromDisplay("-٫٢٥")).toBe(-0.25);
    });

    it("يدعم علامات السالب اللاحقة في نصوص RTL ولا يخلط مع الواصلات في المعرفات", () => {
      expect(numericFromDisplay("1,500-")).toBe(-1500);
      expect(numericFromDisplay("1,500 د.ع -")).toBe(-1500);
      // المعرّف مثل INV-1234 ليس سالباً
      expect(numericFromDisplay("INV-1234")).toBe(1234);
      expect(numericFromDisplay("INV-123 (مؤكد)")).toBe(123);
      expect(numericFromDisplay("كود: INV-123")).toBe(123);
      expect(numericFromDisplay("INV-123 v2")).toBe(123);
      expect(numericFromDisplay("100 - 200")).toBe(100);
      expect(numericFromDisplay("1,500 د.ع - رصيد افتتاحي")).toBe(1500);
      expect(numericFromDisplay("INV - 1234")).toBe(1234);
      expect(numericFromDisplay("فاتورة - 123")).toBe(123);
      expect(numericFromDisplay("طلب: -500")).toBe(-500);
      expect(numericFromDisplay("الرصيد: -1,500 د.ع")).toBe(-1500);
      expect(numericFromDisplay("+1,500 د.ع")).toBe(1500);
    });

    it("يعيد null للقيم الفارغة والرموز الوهمية", () => {
      expect(numericFromDisplay("")).toBeNull();
      expect(numericFromDisplay("   ")).toBeNull();
      expect(numericFromDisplay("—")).toBeNull();
      expect(numericFromDisplay("-")).toBeNull();
      expect(numericFromDisplay(null)).toBeNull();
      expect(numericFromDisplay(undefined)).toBeNull();
      expect(numericFromDisplay("غير محدد")).toBeNull();
    });
  });

  describe("compareNumericDisplay", () => {
    it("يقارن عددياً بشكل صحيح ويتفوق على الفرز النصي", () => {
      // نصياً: "1,500" يسبق "999"، ولكن عددياً: 999 أصغر من 1500
      expect(compareNumericDisplay("999 د.ع", "1,500 د.ع")).toBeLessThan(0);
      expect(compareNumericDisplay("1,500 د.ع", "999 د.ع")).toBeGreaterThan(0);
    });

    it("يقارن الأرصدة السالبة والصفر بدقة", () => {
      expect(compareNumericDisplay("−500 د.ع", "100 د.ع")).toBeLessThan(0);
      expect(compareNumericDisplay("0 د.ع", "−100 د.ع")).toBeGreaterThan(0);
      expect(compareNumericDisplay("−1,000", "−500")).toBeLessThan(0);
    });

    it("يُذيّل القيم الفارغة دائماً في الفرز التصاعدي والتنازلي", () => {
      // تصاعدي (isDesc = false): القيم الفارغة تأتي بعد الصالحة
      expect(compareNumericDisplay(null, "100 د.ع", false)).toBeGreaterThan(0);
      expect(compareNumericDisplay("100 د.ع", null, false)).toBeLessThan(0);

      // تنازلي (isDesc = true): قبل عكس TanStack للاتجاه، تعيد دالة المقارنة قيمة تجعل الفارغ في الذيل
      expect(compareNumericDisplay(null, "100 د.ع", true)).toBeLessThan(0);
      expect(compareNumericDisplay("100 د.ع", null, true)).toBeGreaterThan(0);

      // كلا الطرفين فارغ
      expect(compareNumericDisplay(null, "—", false)).toBe(0);
      expect(compareNumericDisplay(null, "—", true)).toBe(0);
    });
  });

  describe("parseDateDisplay & compareDateDisplay", () => {
    it("يحلل صيغة التاريخ المحلي DD/MM/YYYY بدقة ويمنع الخطأ الأمريكي", () => {
      // 02/09/2026 هو 2 سبتمبر وليس 9 فبراير
      const ms = parseDateDisplay("02/09/2026");
      expect(ms).not.toBeNull();
      const d = new Date(ms!);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(8); // September (0-indexed: 8)
      expect(d.getDate()).toBe(2);
    });

    it("يدعم صيغة ISO YYYY-MM-DD ويضمن تطابقها زمنياً مع الصيغة المحلية DD/MM/YYYY", () => {
      expect(parseDateDisplay("2026-09-02")).toBe(parseDateDisplay("02/09/2026"));
      expect(compareDateDisplay("2026-09-02", "02/09/2026")).toBe(0);
      expect(compareDateDisplay("2026-09-01", "02/09/2026")).toBeLessThan(0);
      expect(compareDateDisplay("2026-09-03", "02/09/2026")).toBeGreaterThan(0);
    });

    it("يدعم التواريخ العالمية ذات الإزاحة الصريحة (Z و +03:00) ويطابقها زمنياً", () => {
      expect(parseDateDisplay("2026-09-02T14:30:00.000Z")).toBe(parseDateDisplay("2026-09-02T17:30:00+03:00"));
      expect(compareDateDisplay("2026-09-02T14:30:00.000Z", "2026-09-02T17:30:00+03:00")).toBe(0);
    });

    it("يدعم التاريخ مع الوقت", () => {
      const ms = parseDateDisplay("25/09/2026، 14:30:15");
      expect(ms).not.toBeNull();
      const d = new Date(ms!);
      expect(d.getHours()).toBe(14);
      expect(d.getMinutes()).toBe(30);
      expect(d.getSeconds()).toBe(15);
    });

    it("يطبّع الأرقام الهندية في التواريخ", () => {
      const ms = parseDateDisplay("٠٢/٠٩/٢٠٢٦");
      expect(ms).not.toBeNull();
      const d = new Date(ms!);
      expect(d.getDate()).toBe(2);
      expect(d.getMonth()).toBe(8);
    });

    it("يدعم توقيت 12 ساعة بنظام ص/م و AM/PM ويفرز الفترات الصباحية والمسائية بدقة", () => {
      // 02:00 م (14:00) يجب أن يأتي بعد 10:00 ص (10:00)
      const pmMs = parseDateDisplay("02/09/2026 02:00 م");
      const amMs = parseDateDisplay("02/09/2026 10:00 ص");
      expect(pmMs).not.toBeNull();
      expect(amMs).not.toBeNull();
      expect(pmMs!).toBeGreaterThan(amMs!);
      expect(compareDateDisplay("02/09/2026 10:00 ص", "02/09/2026 02:00 م")).toBeLessThan(0);

      // منتصف الليل 12:00 ص يسبق الظهيرة 12:00 م
      const midnightMs = parseDateDisplay("02/09/2026 12:00 ص");
      const noonMs = parseDateDisplay("02/09/2026 12:00 م");
      expect(midnightMs!).toBeLessThan(noonMs!);
    });

    it("يدعم التواريخ المفصولة بنقاط DD.MM.YYYY", () => {
      const ms = parseDateDisplay("02.09.2026");
      expect(ms).not.toBeNull();
      const d = new Date(ms!);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(8);
      expect(d.getDate()).toBe(2);
    });

    it("يدعم التواريخ المفصولة بشرطات DD-MM-YYYY ولا يخلطها مع فروق التوقيت السالبة", () => {
      const ms = parseDateDisplay("02-09-2026");
      expect(ms).not.toBeNull();
      const d = new Date(ms!);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(8); // September
      expect(d.getDate()).toBe(2);
      expect(parseDateDisplay("02-09-2026")).toBe(parseDateDisplay("02/09/2026"));
    });

    it("يقارن زمنياً ويذيل التواريخ الفارغة في الاتجاهين", () => {
      expect(compareDateDisplay("01/09/2026", "02/09/2026", false)).toBeLessThan(0);
      expect(compareDateDisplay("02/09/2026", "01/09/2026", false)).toBeGreaterThan(0);

      // تذييل الفارغ تصاعدياً
      expect(compareDateDisplay(null, "01/09/2026", false)).toBeGreaterThan(0);
      expect(compareDateDisplay("01/09/2026", null, false)).toBeLessThan(0);

      // تذييل الفارغ تنازلياً
      expect(compareDateDisplay(null, "01/09/2026", true)).toBeLessThan(0);
      expect(compareDateDisplay("01/09/2026", null, true)).toBeGreaterThan(0);

      // كلا الطرفين فارغ يعيد 0
      expect(compareDateDisplay(null, "—")).toBe(0);
    });
  });

  describe("compareTextDisplay", () => {
    it("يفرز النصوص العربية هجائياً ويذيل الفارغة", () => {
      expect(compareTextDisplay("أحمد", "بسام", false)).toBeLessThan(0);
      expect(compareTextDisplay("زيد", "أحمد", false)).toBeGreaterThan(0);

      expect(compareTextDisplay(null, "أحمد", false)).toBeGreaterThan(0);
      expect(compareTextDisplay(null, "أحمد", true)).toBeLessThan(0);
    });

    it("يدعم الفرز الأبجدي الرقمي الطبيعي للنصوص والأكواد (numeric: true)", () => {
      // "دفعة 2" يجب أن تسبق "دفعة 10" عددياً بدلاً من الترتيب المعجمي الساذج
      expect(compareTextDisplay("دفعة 2", "دفعة 10")).toBeLessThan(0);
      expect(compareTextDisplay("INV-2", "INV-10")).toBeLessThan(0);
    });
  });

  describe("sortingFnForKind", () => {
    it("يشتق دالة فرز رياضية للأموال والأرقام، وزمنية للتواريخ، ونصية للنصوص والأكواد", () => {
      expect(sortingFnForKind("money")).not.toBe("auto");
      expect(sortingFnForKind("number")).not.toBe("auto");
      expect(sortingFnForKind("date")).not.toBe("auto");
      expect(sortingFnForKind("datetime")).not.toBe("auto");
      expect(sortingFnForKind("text")).not.toBe("auto");
      expect(sortingFnForKind("code")).not.toBe("auto");
      expect(sortingFnForKind("status")).not.toBe("auto");
      expect(sortingFnForKind("actions")).toBe("auto");
    });
  });
});

describe("DataTableColumnHeader Component", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("يطبق flex-row-reverse عند محاذاة العمود للنهاية (text-end كالمبالغ في RTL)", () => {
    const mockColumn = {
      getCanSort: () => true,
      getIsSorted: () => false,
      getToggleSortingHandler: () => () => {},
      columnDef: {
        meta: { kind: "money", align: "end" },
      },
    } as unknown as Column<unknown, unknown>;

    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="الرصيد" />);
    });

    const headerEl = host.querySelector("[data-column-header='true']");
    expect(headerEl).not.toBeNull();
    expect(headerEl?.className).toContain("flex-row-reverse");
  });

  it("يعرض الأيقونة بحالة خفيفة/مخفية قبل الفرز وتظهر عند التمرير", () => {
    const mockColumn = {
      getCanSort: () => true,
      getIsSorted: () => false,
      getToggleSortingHandler: () => () => {},
      columnDef: {
        meta: { kind: "text" },
      },
    } as unknown as Column<unknown, unknown>;

    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="الاسم" />);
    });

    const svg = host.querySelector("svg");
    expect(svg).not.toBeNull();
    // ArrowUpDown يحمل opacity-0 group-hover:opacity-50
    expect(svg?.getAttribute("class")).toContain("opacity-0");
    expect(svg?.getAttribute("class")).toContain("group-hover:opacity-50");
  });

  it("يعرض سهم التصاعدي بوضوح عند تفعيل الفرز التصاعدي", () => {
    const mockColumn = {
      getCanSort: () => true,
      getIsSorted: () => "asc",
      getToggleSortingHandler: () => () => {},
      columnDef: {
        meta: { kind: "text" },
      },
    } as unknown as Column<unknown, unknown>;

    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="الاسم" />);
    });

    const svg = host.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toContain("text-primary");
    expect(svg?.getAttribute("class")).toContain("opacity-100");

    const srOnly = host.querySelector(".sr-only");
    expect(srOnly?.textContent).toBe("مرتب تصاعدياً");
  });

  it("يعرض سهم التنازلي بوضوح عند تفعيل الفرز التنازلي", () => {
    const mockColumn = {
      getCanSort: () => true,
      getIsSorted: () => "desc",
      getToggleSortingHandler: () => () => {},
      columnDef: {
        meta: { kind: "money" },
      },
    } as unknown as Column<unknown, unknown>;

    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="المبلغ" />);
    });

    const svg = host.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toContain("text-primary");
    expect(svg?.getAttribute("class")).toContain("opacity-100");

    const srOnly = host.querySelector(".sr-only");
    expect(srOnly?.textContent).toBe("مرتب تنازلياً");
  });

  it("يوفر سمات الوصولية aria-sort و role='button' و tabIndex={0} عند الاستخدام المباشر", () => {
    let sortedDir: boolean | "asc" | "desc" = false;
    let toggled = false;
    const mockColumn = {
      getCanSort: () => true,
      getIsSorted: () => sortedDir,
      getToggleSortingHandler: () => () => {
        toggled = true;
      },
      columnDef: {
        meta: { kind: "text" },
      },
    } as unknown as Column<unknown, unknown>;

    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="الاسم" />);
    });

    const el = host.querySelector("[data-column-header='true']");
    expect(el).not.toBeNull();
    expect(el?.getAttribute("aria-sort")).toBe("none");
    expect(el?.getAttribute("role")).toBe("button");
    expect(el?.getAttribute("tabIndex")).toBe("0");
    expect(el?.className).toContain("cursor-pointer");

    // نقر مباشر
    act(() => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggled).toBe(true);

    // التحقق من تصاعدي
    sortedDir = "asc";
    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="الاسم" />);
    });
    expect(el?.getAttribute("aria-sort")).toBe("ascending");

    // التحقق من تنازلي
    sortedDir = "desc";
    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="الاسم" />);
    });
    expect(el?.getAttribute("aria-sort")).toBe("descending");
  });

  it("لا يضع role='button' أو aria-sort عند تعطيل الفرز على العمود", () => {
    const mockColumn = {
      getCanSort: () => false,
      getIsSorted: () => false,
      getToggleSortingHandler: () => undefined,
      columnDef: {
        meta: { kind: "text" },
      },
    } as unknown as Column<unknown, unknown>;

    act(() => {
      root.render(<DataTableColumnHeader column={mockColumn} title="ثابت" />);
    });

    const el = host.querySelector("[data-column-header='true']");
    expect(el?.getAttribute("aria-sort")).toBeNull();
    expect(el?.getAttribute("role")).toBeNull();
    expect(el?.getAttribute("tabIndex")).toBeNull();
    expect(el?.className).not.toContain("cursor-pointer");
  });
});

describe("DataTable Tri-State Sorting Interaction & Cycle", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  type RowItem = {
    id: string;
    name: string;
    amount: string;
    date: string;
  };

  const sampleData: RowItem[] = [
    { id: "1", name: "بسام", amount: "1,500 د.ع", date: "02/09/2026" },
    { id: "2", name: "أحمد", amount: "999 د.ع", date: "15/09/2026" },
    { id: "3", name: "زيد", amount: "−500 د.ع", date: "01/09/2026" },
    { id: "4", name: "سالم", amount: "—", date: "—" },
    { id: "5", name: "عمر", amount: "0 د.ع", date: "10/09/2026" },
  ];

  const columns: ColumnDef<RowItem>[] = [
    {
      accessorKey: "name",
      header: "الاسم",
      meta: { kind: "text" },
    },
    {
      accessorKey: "amount",
      header: "المبلغ",
      meta: { kind: "money" },
    },
    {
      accessorKey: "date",
      header: "التاريخ",
      meta: { kind: "date" },
    },
  ];

  it("ينفذ دورة النمط الثلاثي (تنازلي أولاً للأموال -> تصاعدي -> إلغاء الفرز)", () => {
    act(() => {
      root.render(<DataTable columns={columns} data={sampleData} searchable={false} />);
    });

    const ths = host.querySelectorAll<HTMLTableCellElement>("thead th");
    const amountTh = ths[1]; // عمود المبلغ
    expect(amountTh).not.toBeNull();
    expect(amountTh.getAttribute("role")).toBe("button");
    const innerHeader = amountTh.querySelector("[data-column-header='true']");
    expect(innerHeader?.getAttribute("role")).toBeNull();
    expect(innerHeader?.getAttribute("aria-sort")).toBeNull();

    // الحالة الابتدائية: غير مرتب
    expect(amountTh.getAttribute("aria-sort")).toBe("none");
    let rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("بسام");

    // النقرة الأولى: تبدأ تنازلياً (الأعلى إلى الأقل) للأموال
    act(() => {
      amountTh.click();
    });
    expect(amountTh.getAttribute("aria-sort")).toBe("descending");
    rows = host.querySelectorAll("tbody tr");
    // الأعلى: 1,500 د.ع (بسام)
    expect(rows[0].textContent).toContain("1,500 د.ع");
    // الثاني: 999 د.ع (أحمد)
    expect(rows[1].textContent).toContain("999 د.ع");
    // الثالث: 0 د.ع (عمر)
    expect(rows[2].textContent).toContain("0 د.ع");
    // الرابع: −500 د.ع (زيد)
    expect(rows[3].textContent).toContain("−500 د.ع");
    // الأخير في الذيل: القيم الفارغة "—" (سالم)
    expect(rows[4].textContent).toContain("سالم");

    // النقرة الثانية: عكس اتجاه الفرز (تصاعدياً من الأقل للأعلى)
    act(() => {
      amountTh.click();
    });
    expect(amountTh.getAttribute("aria-sort")).toBe("ascending");
    rows = host.querySelectorAll("tbody tr");
    // الأقل: −500 د.ع (زيد)
    expect(rows[0].textContent).toContain("−500 د.ع");
    // الثاني: 0 د.ع (عمر)
    expect(rows[1].textContent).toContain("0 د.ع");
    // الثالث: 999 د.ع (أحمد)
    expect(rows[2].textContent).toContain("999 د.ع");
    // الرابع: 1,500 د.ع (بسام)
    expect(rows[3].textContent).toContain("1,500 د.ع");
    // الأخير في الذيل دائماً: القيم الفارغة "—" (سالم)
    expect(rows[4].textContent).toContain("سالم");

    // النقرة الثالثة: إلغاء الفرز واستعادة الترتيب الأولي الافتراضي
    act(() => {
      amountTh.click();
    });
    expect(amountTh.getAttribute("aria-sort")).toBe("none");
    rows = host.querySelectorAll("tbody tr");
    // عودة الترتيب الأصلي: بسام ثم أحمد ثم زيد ثم سالم ثم عمر
    expect(rows[0].textContent).toContain("بسام");
    expect(rows[1].textContent).toContain("أحمد");
    expect(rows[2].textContent).toContain("زيد");
    expect(rows[3].textContent).toContain("سالم");
    expect(rows[4].textContent).toContain("عمر");
  });

  it("ينفذ دورة النمط الثلاثي للأعمدة النصية (تصاعدي أولاً -> تنازلي -> إلغاء الفرز)", () => {
    act(() => {
      root.render(<DataTable columns={columns} data={sampleData} searchable={false} />);
    });

    const ths = host.querySelectorAll<HTMLTableCellElement>("thead th");
    const nameTh = ths[0]; // عمود الاسم

    // النقرة الأولى: تبدأ تصاعدياً للنصوص (أحمد أولاً)
    act(() => {
      nameTh.click();
    });
    expect(nameTh.getAttribute("aria-sort")).toBe("ascending");
    let rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("أحمد");

    // النقرة الثانية: تنازلياً للنصوص (عمر أولاً)
    act(() => {
      nameTh.click();
    });
    expect(nameTh.getAttribute("aria-sort")).toBe("descending");
    rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("عمر");
    expect(rows[rows.length - 1].textContent).toContain("أحمد");

    // النقرة الثالثة: إلغاء الفرز واستعادة الترتيب الافتراضي
    act(() => {
      nameTh.click();
    });
    expect(nameTh.getAttribute("aria-sort")).toBe("none");
    rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("بسام");
  });

  it("يفرز التواريخ زمنياً بصيغة DD/MM/YYYY مع تذييل الفارغة", () => {
    act(() => {
      root.render(<DataTable columns={columns} data={sampleData} searchable={false} />);
    });

    const ths = host.querySelectorAll<HTMLTableCellElement>("thead th");
    const dateTh = ths[2]; // عمود التاريخ

    // النقرة الأولى: تصاعدياً (الأقدم أولاً: 01/09/2026 زيد)
    act(() => {
      dateTh.click();
    });
    expect(dateTh.getAttribute("aria-sort")).toBe("ascending");
    let rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("01/09/2026");
    expect(rows[1].textContent).toContain("02/09/2026");
    expect(rows[2].textContent).toContain("10/09/2026");
    expect(rows[3].textContent).toContain("15/09/2026");
    // الفارغ في الذيل
    expect(rows[4].textContent).toContain("سالم");

    // النقرة الثانية: تنازلياً (الأحدث أولاً: 15/09/2026 أحمد)
    act(() => {
      dateTh.click();
    });
    expect(dateTh.getAttribute("aria-sort")).toBe("descending");
    rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("15/09/2026");
    expect(rows[1].textContent).toContain("10/09/2026");
    expect(rows[2].textContent).toContain("02/09/2026");
    expect(rows[3].textContent).toContain("01/09/2026");
    // الفارغ في الذيل دائماً حتى في التنازلي
    expect(rows[4].textContent).toContain("سالم");
  });

  it("يدعم تمرير ترويسة مخصصة عبر DataTableColumnHeader دون تكرار التغليف", () => {
    const customColumns: ColumnDef<RowItem>[] = [
      {
        accessorKey: "amount",
        header: ({ column }) => <DataTableColumnHeader column={column} title="الرصيد المخصص" />,
        meta: { kind: "money" },
      },
    ];

    act(() => {
      root.render(<DataTable columns={customColumns} data={sampleData} searchable={false} />);
    });

    const ths = host.querySelectorAll<HTMLTableCellElement>("thead th");
    const amountTh = ths[0];

    // التحقق من عدم وجود تكرار لمكون الترويسة
    const innerHeaders = amountTh.querySelectorAll("[data-column-header='true']");
    expect(innerHeaders.length).toBe(1);
    expect(innerHeaders[0].getAttribute("role")).toBeNull();
    expect(innerHeaders[0].getAttribute("aria-sort")).toBeNull();

    // النقرة الأولى: تنازلي
    act(() => {
      amountTh.click();
    });
    expect(amountTh.getAttribute("aria-sort")).toBe("descending");
    const rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("1,500 د.ع");
  });

  it("يدعم ترويسة دالة تستخدم خطافات React دون انهيار ودون تكرار التغليف", () => {
    const columnsWithHookHeader: ColumnDef<RowItem>[] = [
      {
        accessorKey: "amount",
        header: ({ column }) => {
          const [state] = React.useState("نشط");
          return <DataTableColumnHeader column={column} title={`الرصيد (${state})`} />;
        },
        meta: { kind: "money" },
      },
    ];

    act(() => {
      root.render(<DataTable columns={columnsWithHookHeader} data={sampleData} searchable={false} />);
    });

    const th = host.querySelector<HTMLTableCellElement>("thead th");
    const innerHeaders = th?.querySelectorAll("[data-column-header='true']");
    expect(innerHeaders?.length).toBe(1);
    expect(innerHeaders?.[0].getAttribute("role")).toBeNull();
    expect(innerHeaders?.[0].getAttribute("aria-sort")).toBeNull();
    expect(th?.textContent).toContain("الرصيد (نشط)");
  });

  it("يحافظ على سلامة خطافات React عند تبديل الأعمدة أو إعادة الرسم", () => {
    let showAmount = true;
    const renderTable = () => {
      const activeColumns: ColumnDef<RowItem>[] = [
        {
          accessorKey: "name",
          header: "الاسم",
          meta: { kind: "text" },
        },
      ];
      if (showAmount) {
        activeColumns.push({
          accessorKey: "amount",
          header: ({ column }) => {
            const [val] = React.useState("مخصص");
            return <DataTableColumnHeader column={column} title={`الرصيد: ${val}`} />;
          },
          meta: { kind: "money" },
        });
      }
      return <DataTable columns={activeColumns} data={sampleData} searchable={false} />;
    };

    // الرسم الأول
    act(() => {
      root.render(renderTable());
    });
    expect(host.querySelectorAll("thead th").length).toBe(2);

    // إخفاء العمود الذي يحمل الخطاف: يجب ألا يحدث أي انهيار في خطافات React
    showAmount = false;
    act(() => {
      root.render(renderTable());
    });
    expect(host.querySelectorAll("thead th").length).toBe(1);

    // إعادة إظهار العمود
    showAmount = true;
    act(() => {
      root.render(renderTable());
    });
    expect(host.querySelectorAll("thead th").length).toBe(2);
  });

  it("يعطل الفرز ولا يضع role='button' أو aria-sort عند تحديد enableSorting: false", () => {
    const disabledColumns: ColumnDef<RowItem>[] = [
      {
        accessorKey: "name",
        header: "الاسم",
        enableSorting: false,
        meta: { kind: "text" },
      },
    ];

    act(() => {
      root.render(<DataTable columns={disabledColumns} data={sampleData} searchable={false} />);
    });

    const th = host.querySelector<HTMLTableCellElement>("thead th");
    expect(th?.getAttribute("aria-sort")).toBeNull();
    expect(th?.getAttribute("role")).toBeNull();
    expect(th?.getAttribute("tabIndex")).toBeNull();
    expect(th?.className).not.toContain("cursor-pointer");

    // النقر لا يغير شيئاً
    act(() => {
      th?.click();
    });
    expect(th?.getAttribute("aria-sort")).toBeNull();
  });

  it("يفرز أعمدة الأكواد kind: 'code' طبيعياً مع تذييل القيم الفارغة", () => {
    type CodeItem = { id: string; code: string };
    const codeData: CodeItem[] = [
      { id: "1", code: "INV-10" },
      { id: "2", code: "INV-2" },
      { id: "3", code: "—" },
      { id: "4", code: "INV-1" },
    ];
    const codeCols: ColumnDef<CodeItem>[] = [
      {
        accessorKey: "code",
        header: "الكود",
        meta: { kind: "code" },
      },
    ];

    act(() => {
      root.render(<DataTable columns={codeCols} data={codeData} searchable={false} />);
    });

    const th = host.querySelector<HTMLTableCellElement>("thead th");

    // النقرة الأولى: تصاعدي (INV-1 ثم INV-2 ثم INV-10 ثم — في الذيل)
    act(() => {
      th?.click();
    });
    expect(th?.getAttribute("aria-sort")).toBe("ascending");
    let rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("INV-1");
    expect(rows[1].textContent).toContain("INV-2");
    expect(rows[2].textContent).toContain("INV-10");
    expect(rows[3].textContent).toContain("—");

    // النقرة الثانية: تنازلي (INV-10 ثم INV-2 ثم INV-1 ثم — في الذيل دائماً)
    act(() => {
      th?.click();
    });
    expect(th?.getAttribute("aria-sort")).toBe("descending");
    rows = host.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("INV-10");
    expect(rows[1].textContent).toContain("INV-2");
    expect(rows[2].textContent).toContain("INV-1");
    expect(rows[3].textContent).toContain("—");
  });
});
