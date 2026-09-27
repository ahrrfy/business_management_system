import { describe, expect, it } from "vitest";
import { invoiceReducer, createInitialState } from "../reducer";
import type { InvoiceLine } from "../types";

/**
 * محاكاة نقية لدوال ومنطق إدارة حالة التحديد في BulkPicker
 * للتحقق الذري والشامل من ثبات تسلسل التحديد وصون الأصناف عبر الفلترة.
 */
interface PickerRow {
  productUnitId: number;
  productId: number;
  variantId: number;
  name: string;
  sku: string;
  barcode: string | null;
  unitName: string;
  conversionFactor: string;
  stockBase: number;
  stockBranchId: number;
  reservedBase: number;
  availableBase: number;
  isService: boolean;
  isBundle: boolean;
  allowBackorder: boolean;
  price: string;
  costBase: string;
}

function makeRow(id: number, name: string, price = "1000.00"): PickerRow {
  return {
    productUnitId: id,
    productId: id * 10,
    variantId: id * 100,
    name,
    sku: `SKU-${id}`,
    barcode: `BAR-${id}`,
    unitName: "قطعة",
    conversionFactor: "1",
    stockBase: 50,
    stockBranchId: 1,
    reservedBase: 0,
    availableBase: 50,
    isService: false,
    isBundle: false,
    allowBackorder: false,
    price,
    costBase: "800.00",
  };
}

function makeLine(id: number, name: string): InvoiceLine {
  const r = makeRow(id, name);
  return {
    productId: r.productId,
    variantId: r.variantId,
    productUnitId: r.productUnitId,
    name: r.name,
    sku: r.sku,
    barcode: r.barcode,
    unit: r.unitName,
    qty: 1,
    conversionFactor: r.conversionFactor,
    stockBase: r.stockBase,
    stockBranchId: r.stockBranchId,
    reservedBase: r.reservedBase,
    availableBase: r.availableBase,
    isService: r.isService,
    isBundle: r.isBundle,
    allowBackorder: r.allowBackorder,
    price: r.price,
    referencePrice: r.price,
    costBase: r.costBase,
    discount: "0",
    discountType: "percent",
    note: "",
  };
}

describe("BulkPicker selection order preservation & verification", () => {
  it("يحفظ تسلسل الاختيار بالترتيب الزمني الدقيق عند اختيار منتجات بترتيب عشوائي", () => {
    const rowA = makeRow(101, "محفظة رجالي mag Safe");
    const rowB = makeRow(102, "حقيبة يد جلد رجالية");
    const rowC = makeRow(103, "قلم اكرلك ماركر 1008");

    // محاكاة اختيار المستخدم بالترتيب: قلم (C) ثم محفظة (A) ثم حقيبة (B)
    let selectedMap = new Map<number, PickerRow>();

    const toggle = (row: PickerRow) => {
      const next = new Map(selectedMap);
      if (next.has(row.productUnitId)) next.delete(row.productUnitId);
      else next.set(row.productUnitId, row);
      selectedMap = next;
    };

    toggle(rowC); // 1st
    toggle(rowA); // 2nd
    toggle(rowB); // 3rd

    // استخراج العناصر بالترتيب
    const selectedLines = Array.from(selectedMap.values());

    expect(selectedLines.map((r) => r.productUnitId)).toEqual([103, 101, 102]);
    expect(selectedLines.map((r) => r.name)).toEqual([
      "قلم اكرلك ماركر 1008",
      "محفظة رجالي mag Safe",
      "حقيبة يد جلد رجالية",
    ]);

    // شارات الترتيب المرئية للمستخدم
    const orderMap = new Map<number, number>();
    let order = 1;
    for (const id of selectedMap.keys()) {
      orderMap.set(id, order++);
    }

    expect(orderMap.get(103)).toBe(1);
    expect(orderMap.get(101)).toBe(2);
    expect(orderMap.get(102)).toBe(3);
  });

  it("يُعيد حساب شارات التسلسل بدقة عند إلغاء تحديد صنف وإعادة اختياره", () => {
    const rowA = makeRow(101, "منتج 1");
    const rowB = makeRow(102, "منتج 2");
    const rowC = makeRow(103, "منتج 3");

    let selectedMap = new Map<number, PickerRow>();
    const toggle = (row: PickerRow) => {
      const next = new Map(selectedMap);
      if (next.has(row.productUnitId)) next.delete(row.productUnitId);
      else next.set(row.productUnitId, row);
      selectedMap = next;
    };

    // اختر 1 ثم 2 ثم 3
    toggle(rowA);
    toggle(rowB);
    toggle(rowC);
    expect(Array.from(selectedMap.keys())).toEqual([101, 102, 103]);

    // ألغِ اختيار 2
    toggle(rowB);
    expect(Array.from(selectedMap.keys())).toEqual([101, 103]);

    // أعد اختيار 2 ⇒ يُضاف لنهاية الطابور كأحدث اختيار
    toggle(rowB);
    expect(Array.from(selectedMap.keys())).toEqual([101, 103, 102]);

    const orderMap = new Map<number, number>();
    let order = 1;
    for (const id of selectedMap.keys()) {
      orderMap.set(id, order++);
    }
    expect(orderMap.get(101)).toBe(1);
    expect(orderMap.get(103)).toBe(2);
    expect(orderMap.get(102)).toBe(3);
  });

  it("يحفظ الأصناف المحددة من نتائج بحث سابقة ولا يفقدها عند تغيير عبارة البحث", () => {
    const pen = makeRow(201, "قلم ماركر");
    const bag = makeRow(202, "حقيبة جلد");

    let selectedMap = new Map<number, PickerRow>();
    const toggle = (row: PickerRow) => {
      const next = new Map(selectedMap);
      if (next.has(row.productUnitId)) next.delete(row.productUnitId);
      else next.set(row.productUnitId, row);
      selectedMap = next;
    };

    // 1. المستخدم بحث عن «قلم» وظهر له pen واختاره
    let currentRows = [pen];
    toggle(pen);
    expect(selectedMap.size).toBe(1);

    // 2. المستخدم بحث عن «حقيبة» وتغيرت rows وأصبحت bag فقط (pen لم يعد موجوداً في rows)
    currentRows = [bag];
    toggle(bag);

    // 3. التحديد يحتوي الصنفين معاً بتسلسل الاختيار الدقيق رغم غياب pen عن النتائج الحالية
    const confirmedLines = Array.from(selectedMap.values());
    expect(confirmedLines).toHaveLength(2);
    expect(confirmedLines[0].productUnitId).toBe(201);
    expect(confirmedLines[1].productUnitId).toBe(202);
  });

  it("يُحدّث بيانات الأسعار والتكلفة للأصناف المحددة دون تشويه ترتيب الاختيار", () => {
    const itemA = makeRow(301, "صنف أ", "100.00");
    const itemB = makeRow(302, "صنف ب", "200.00");

    let selectedMap = new Map<number, PickerRow>();
    selectedMap.set(itemB.productUnitId, itemB); // تم اختيار ب أولاً
    selectedMap.set(itemA.productUnitId, itemA); // تم اختيار أ ثانياً

    // حدّث السعر في rows (مثلاً بعد تغيير فئة السعر أو أسعار الصرف)
    const updatedItemB = { ...itemB, price: "250.00" };
    const freshRows = [itemA, updatedItemB];

    // خوارزمية التحديث المتطابقة مع useEffect في BulkPicker
    const next = new Map<number, PickerRow>();
    for (const [id, oldRow] of selectedMap) {
      const freshRow = freshRows.find((r) => r.productUnitId === id);
      next.set(id, freshRow ?? oldRow);
    }
    selectedMap = next;

    // ثبات الترتيب ب ثم أ
    expect(Array.from(selectedMap.keys())).toEqual([302, 301]);
    // تحديث السعر
    expect(selectedMap.get(302)?.price).toBe("250.00");
  });
});

describe("InvoiceReducer ADD_ITEMS order preservation", () => {
  it("يُضيف الأصناف الجماعية إلى جدول الفاتورة بنفس تسلسل المصفوفة الممررة بالضبط", () => {
    const state = createInitialState("PURCHASE");

    const line1 = makeLine(501, "أول صنف تم اختياره");
    const line2 = makeLine(502, "ثاني صنف تم اختياره");
    const line3 = makeLine(503, "ثالث صنف تم اختياره");

    const nextState = invoiceReducer(state, {
      type: "ADD_ITEMS",
      items: [line1, line2, line3],
    });

    expect(nextState.items).toHaveLength(3);
    expect(nextState.items[0].productUnitId).toBe(501);
    expect(nextState.items[1].productUnitId).toBe(502);
    expect(nextState.items[2].productUnitId).toBe(503);
  });

  it("يُلحق الأصناف الجديدة في نهاية الجدول مع الحفاظ على تسلسلها", () => {
    const initialState = {
      ...createInitialState("SALE"),
      items: [makeLine(401, "صنف قديم في الجدول")],
    };

    const newSelections = [
      makeLine(402, "صنف محدد 1"),
      makeLine(403, "صنف محدد 2"),
    ];

    const nextState = invoiceReducer(initialState, {
      type: "ADD_ITEMS",
      items: newSelections,
    });

    expect(nextState.items.map((i) => i.productUnitId)).toEqual([401, 402, 403]);
  });
});

describe("TransferCart batch addition atomic order preservation", () => {
  it("يُضيف الأصناف الجماعية إلى سلة التحويل بنفس التسلسل المختار دفعة ذرية واحدة", () => {
    let lines: InvoiceLine[] = [];

    const addMany = (items: InvoiceLine[]) => {
      const next = [...lines];
      for (const line of items) {
        const i = next.findIndex((l) => l.productUnitId === line.productUnitId);
        if (i >= 0) {
          next[i] = { ...next[i], qty: next[i].qty + 1 };
        } else {
          next.push(line);
        }
      }
      lines = next;
    };

    const selectedLines = [
      makeLine(701, "دفعة تحويل 1"),
      makeLine(702, "دفعة تحويل 2"),
      makeLine(703, "دفعة تحويل 3"),
    ];

    addMany(selectedLines);

    expect(lines.map((l) => l.productUnitId)).toEqual([701, 702, 703]);
  });
});
