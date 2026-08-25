import { describe, it, expect } from "vitest";
import {
  EMPTY_STATE_RESOURCE_KEYS,
  emptyStateMessage,
  pickEmptyMessage,
} from "./emptyStateMessages";

describe("رسائل حالة القوائم الفارغة", () => {
  it("كل مفتاح domain يحمل NO_ROWS_YET و NO_MATCH_FILTER معاً", () => {
    for (const key of EMPTY_STATE_RESOURCE_KEYS) {
      const noRows = emptyStateMessage(key, "NO_ROWS_YET");
      const noMatch = emptyStateMessage(key, "NO_MATCH_FILTER");
      expect(noRows.title, `${key}.NO_ROWS_YET بلا عنوان`).toBeTruthy();
      expect(noMatch.title, `${key}.NO_MATCH_FILTER بلا عنوان`).toBeTruthy();
      // النصّان **يجب** أن يختلفا — كانا في الشاشات القديمة نصّاً واحداً «لا بيانات».
      expect(noRows.title, `${key}: NO_ROWS_YET و NO_MATCH_FILTER متطابقان — الفرق الدلاليّ محجوب`)
        .not.toBe(noMatch.title);
    }
  });

  it("مفتاح مجهول يعود إلى generic بلا throw", () => {
    const msg = emptyStateMessage("nonexistent_domain_xyz", "NO_ROWS_YET");
    expect(msg.title).toBe("لا سجلّات بعد");
  });

  it("pickEmptyMessage يختار الرسالة الصحيحة حسب filtersActive", () => {
    const filteredMsg = pickEmptyMessage("invoices", true);
    const unfilteredMsg = pickEmptyMessage("invoices", false);
    expect(filteredMsg.title).toContain("مطابقة");   // NO_MATCH_FILTER
    expect(unfilteredMsg.title).toContain("بعد");    // NO_ROWS_YET
  });

  it("رسائل الفواتير عربية ومحدَّدة (لا 'no data' غامضة)", () => {
    const msg = emptyStateMessage("invoices", "NO_ROWS_YET");
    expect(msg.title).toBe("لا فواتير بعد");
    expect(msg.description).toContain("الكاشير");  // إرشاد عملي محدَّد
  });

  it("رسالة NO_MATCH_FILTER تُشير إلى مسح الفلاتر (تفعيلٌ للـCTA في المستدعي)", () => {
    for (const key of EMPTY_STATE_RESOURCE_KEYS) {
      const msg = emptyStateMessage(key, "NO_MATCH_FILTER");
      expect(msg.description ?? "").toMatch(/امسح|غيّر|البحث/);
    }
  });
});
