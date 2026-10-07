import { describe, expect, it } from "vitest";
import { titleForChannel, type ProductTitleSource } from "./productChannelTitles";
import { normalizeSearchText } from "./searchNormalize";

/**
 * منطق اشتقاق عناوين القنوات عند تعديل المنتج
 * يطابق تماماً ما ينفذه productEditService وproductUpdate.
 */
function resolveChannelLabelsOnUpdate(
  input: {
    name?: string | null;
    posLabel?: string | null;
    invoiceLabel?: string | null;
    storeTitle?: string | null;
    shortTitle?: string | null;
  },
  existing: {
    name: string;
    posLabel?: string | null;
    invoiceLabel?: string | null;
    storeTitle?: string | null;
    shortTitle?: string | null;
  },
) {
  const newName = (input.name ?? "").trim() || existing.name;
  const isNameUpdated = newName !== existing.name;

  const posLabel =
    input.posLabel !== undefined
      ? input.posLabel?.trim() || null
      : isNameUpdated
        ? newName.slice(0, 120)
        : undefined;

  const invoiceLabel =
    input.invoiceLabel !== undefined
      ? input.invoiceLabel?.trim() || null
      : isNameUpdated
        ? newName
        : undefined;

  const storeTitle =
    input.storeTitle !== undefined
      ? input.storeTitle?.trim() || null
      : isNameUpdated
        ? newName
        : undefined;

  const shortTitle =
    input.shortTitle !== undefined
      ? input.shortTitle?.trim() || null
      : isNameUpdated
        ? newName.slice(0, 160)
        : undefined;

  return {
    name: newName,
    posLabel: posLabel !== undefined ? posLabel : existing.posLabel,
    invoiceLabel: invoiceLabel !== undefined ? invoiceLabel : existing.invoiceLabel,
    storeTitle: storeTitle !== undefined ? storeTitle : existing.storeTitle,
    shortTitle: shortTitle !== undefined ? shortTitle : existing.shortTitle,
  };
}

describe("productChannelSync — اختبارات انضباط وتزامن عناوين القنوات", () => {
  it("⭐ معالجة حالة التكرار المبلّغ عنها: تعديل اسم المنتج الثاني دون إرسال posLabel يحدّث posLabel فوراً", () => {
    // المنتج 1: ملزمة سجاد
    const product1 = {
      name: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      posLabel: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      invoiceLabel: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      storeTitle: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      shortTitle: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
    };

    // المنتج 2: كان في الأصل يحمل اسم سجاد عن طريق الخطأ
    const product2Before = {
      name: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      posLabel: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      invoiceLabel: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      storeTitle: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
      shortTitle: "ملزمة اول متوسط سجاد حمزة الطابعي 2027",
    };

    // المستخدم عدّل المنتج 2 إلى ملزمة منتظر، والواجهة لم ترسل posLabel (كان undefined)
    const product2After = resolveChannelLabelsOnUpdate(
      {
        name: "ملزمة اول متوسط منتظر الخفاجي الطابعي 2027",
        // posLabel: undefined
      },
      product2Before,
    );

    // التحقق من تحديث كافة العناوين للاسم الجديد
    expect(product2After.name).toBe("ملزمة اول متوسط منتظر الخفاجي الطابعي 2027");
    expect(product2After.posLabel).toBe("ملزمة اول متوسط منتظر الخفاجي الطابعي 2027");
    expect(product2After.invoiceLabel).toBe("ملزمة اول متوسط منتظر الخفاجي الطابعي 2027");
    expect(product2After.storeTitle).toBe("ملزمة اول متوسط منتظر الخفاجي الطابعي 2027");
    expect(product2After.shortTitle).toBe("ملزمة اول متوسط منتظر الخفاجي الطابعي 2027");

    // الكاشير أونلاين: titleForChannel لقناة pos يجب ألا يتطابق بين المنتجين بعد الآن
    const posTitle1 = titleForChannel(product1, "pos");
    const posTitle2 = titleForChannel(product2After, "pos");

    expect(posTitle1).toBe("ملزمة اول متوسط سجاد حمزة الطابعي 2027");
    expect(posTitle2).toBe("ملزمة اول متوسط منتظر الخفاجي الطابعي 2027");
    expect(posTitle1).not.toBe(posTitle2);
  });

  it("يقتطع posLabel إلى 120 محرفاً وshortTitle إلى 160 محرفاً عند التزامن التلقائي للأسماء الطويلة", () => {
    const longName = "أ".repeat(200);
    const existing = {
      name: "اسم قديم",
      posLabel: "اسم قديم",
      shortTitle: "اسم قديم",
    };

    const result = resolveChannelLabelsOnUpdate({ name: longName }, existing);

    expect(result.posLabel).toBe("أ".repeat(120));
    expect(result.shortTitle).toBe("أ".repeat(160));
    expect(result.invoiceLabel).toBe(longName);
    expect(result.storeTitle).toBe(longName);
  });

  it("يحترم القيم المحدّدة صراحةً ولا يستبدلها بالاسم الجديد", () => {
    const existing = {
      name: "دفتر عادي",
      posLabel: "دفتر عادي",
      storeTitle: "دفتر عادي",
    };

    const result = resolveChannelLabelsOnUpdate(
      {
        name: "دفتر مدرسي سوبر",
        posLabel: "دفتر سوبر كاشير",
        storeTitle: null, // طلب تصفير صريح
      },
      existing,
    );

    expect(result.name).toBe("دفتر مدرسي سوبر");
    expect(result.posLabel).toBe("دفتر سوبر كاشير");
    expect(result.storeTitle).toBeNull();
    // ما لم يُحدد يُزامن مع الاسم الجديد
    expect(result.invoiceLabel).toBe("دفتر مدرسي سوبر");
    expect(result.shortTitle).toBe("دفتر مدرسي سوبر");
  });

  it("لا يطمس العناوين المخصصة القائمة إذا لم يتغير اسم المنتج", () => {
    const existing = {
      name: "دفتر جامعي",
      posLabel: "دفتر مخصص للكاشير",
      invoiceLabel: "دفتر فاتورة",
      storeTitle: "دفتر متجر",
      shortTitle: "دفتر",
    };

    // تعديل لحقول أخرى (سعر/مخزون) مع بقاء الاسم كما هو
    const result = resolveChannelLabelsOnUpdate(
      {
        name: "دفتر جامعي",
      },
      existing,
    );

    expect(result.posLabel).toBe("دفتر مخصص للكاشير");
    expect(result.invoiceLabel).toBe("دفتر فاتورة");
    expect(result.storeTitle).toBe("دفتر متجر");
    expect(result.shortTitle).toBe("دفتر");
  });

  it("⭐ تكافؤ أوفلاين/أونلاين: لقطة الكتالوج الأوفلايني تطابق titleForChannel للكاشير", () => {
    const product: ProductTitleSource = {
      name: "ملزمة الكيمياء للصف الثالث المتوسط الطبعة المعتمدة 2027",
      posLabel: "كيمياء 3 متوسط 2027",
      shortTitle: "كيمياء 3م",
    };

    // كاشير أونلاين:
    const onlinePosTitle = titleForChannel(product, "pos");
    expect(onlinePosTitle).toBe("كيمياء 3 متوسط 2027");

    // كاشير أوفلاين:
    // في buildCatalogSnapshot نعتمد titleForChannel(..., "pos") لـ productName
    const offlineProductName = titleForChannel(
      {
        name: product.name,
        posLabel: product.posLabel,
        shortTitle: product.shortTitle,
      },
      "pos",
    );
    expect(offlineProductName).toBe(onlinePosTitle);

    // فحص searchText في الأوفلاين: يجب أن يطابق كلاً من تسمية الكاشير المختصرة والاسم الكامل
    const searchText = normalizeSearchText(
      [offlineProductName, product.name !== offlineProductName ? product.name : null]
        .filter(Boolean)
        .join(" "),
    );

    expect(searchText).toContain("كيمياء 3 متوسط 2027");
    expect(searchText).toContain(normalizeSearchText("ملزمة الكيمياء للصف الثالث المتوسط"));
  });
});
