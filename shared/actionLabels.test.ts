import { describe, it, expect } from "vitest";
import { ACTION_LABELS, ACTION_LABEL_KEYS, actionLabel } from "./actionLabels";

describe("قاموس تسميات الإجراءات — مصدر الحقيقة الوحيد", () => {
  it("كل مفتاح له نصّ عربيّ غير فارغ", () => {
    for (const key of ACTION_LABEL_KEYS) {
      const label = ACTION_LABELS[key];
      expect(label, `${key} بلا نصّ`).toBeTruthy();
      expect(label.length, `${key} فارغ`).toBeGreaterThan(0);
    }
  });

  it("سلاسل التحميل موحّدة — «جارٍ …» بحرف ألف واحد وشرطة عمودية عربية", () => {
    // كان هناك «جار التحميل» / «جارى التحميل» / «يجري التحميل» — كلها منجرفة.
    // القاعدة: «جارٍ» (بألف واحدة) لأنّ الفعل «جرى» بحرف عين خفيف.
    const loadingKeys = ["loading", "saving", "sending", "deleting", "submitting", "processing", "uploading", "downloading", "exporting", "printing", "refreshing", "fetching", "verifying"] as const;
    for (const key of loadingKeys) {
      const label = ACTION_LABELS[key];
      expect(label.startsWith("جارٍ "), `${key}="${label}" لا يبدأ بـ«جارٍ »`).toBe(true);
      expect(label.endsWith("…"), `${key}="${label}" لا ينتهي بنقاطٍ رفيعة`).toBe(true);
    }
  });

  it("actionLabel(key) يعود نفس ACTION_LABELS[key]", () => {
    for (const key of ACTION_LABEL_KEYS) {
      expect(actionLabel(key)).toBe(ACTION_LABELS[key]);
    }
  });

  it("أفعال idle متزامنة مع أفعال pending — save/saving متجاورتان", () => {
    // كل action idle له نظير pending — الاختبار يحرس عدم إسقاط أحدهما بغير قصد.
    const pairs: Array<[string, string]> = [
      ["save", "saving"],
      ["send", "sending"],
      ["delete", "deleting"],
      ["submit", "submitting"],
      ["export", "exporting"],
      ["print", "printing"],
      ["download", "downloading"],
      ["upload", "uploading"],
      ["refresh", "refreshing"],
    ];
    for (const [idle, pending] of pairs) {
      expect(ACTION_LABEL_KEYS.includes(idle as never), `مفتاح ${idle} مفقود`).toBe(true);
      expect(ACTION_LABEL_KEYS.includes(pending as never), `مفتاح ${pending} مفقود`).toBe(true);
    }
  });

  it("رسائل النجاح تبدأ بـ«تمّ» أو «أُنشئ/أُلغي»", () => {
    const successKeys = ["saved", "sent", "deleted", "updated", "created", "cancelled", "approved", "rejected", "exported"] as const;
    for (const key of successKeys) {
      const label = ACTION_LABELS[key];
      const startsWithTamm = label.startsWith("تمّ") || label.startsWith("أُنشئ") || label.startsWith("أُلغي");
      expect(startsWithTamm, `${key}="${label}" لا يبدأ بـ«تمّ/أُنشئ/أُلغي»`).toBe(true);
    }
  });
});
