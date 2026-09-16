import { describe, expect, it, vi } from "vitest";
import { countIfOffset, paginateKeyset } from "../paginateKeyset";

describe("countIfOffset", () => {
  it("يرجع 0 عند استخدام المؤشر (keyset) دون استدعاء runCount", async () => {
    const runCount = vi.fn().mockResolvedValue(100);
    const result = await countIfOffset(true, runCount);
    expect(result).toBe(0);
    expect(runCount).not.toHaveBeenCalled();
  });

  it("المسار التوافقي القديم (دون fastPath): يستدعي runCount ويرجع النتيجة", async () => {
    const runCount = vi.fn().mockResolvedValue(42);
    const result = await countIfOffset(false, runCount);
    expect(result).toBe(42);
    expect(runCount).toHaveBeenCalledTimes(1);
  });

  it("المسار السريع (fastPath): إذا كانت نتائج الصفحة الأولى أقل من الحد المطلوب، يرجع الطول فوراً بلا استدعاء runCount", async () => {
    const runCount = vi.fn().mockResolvedValue(999);
    const result = await countIfOffset(false, runCount, {
      rowsLength: 15,
      limit: 50,
      offset: 0,
    });
    expect(result).toBe(15);
    expect(runCount).not.toHaveBeenCalled();
  });

  it("المسار السريع (fastPath): إذا كان offset غير معرّف وعدد النتائج صفراً، يرجع 0 بلا استدعاء runCount", async () => {
    const runCount = vi.fn().mockResolvedValue(999);
    const result = await countIfOffset(false, runCount, {
      rowsLength: 0,
      limit: 50,
      offset: undefined,
    });
    expect(result).toBe(0);
    expect(runCount).not.toHaveBeenCalled();
  });

  it("إذا كانت نتائج الصفحة مساوية للحد المطلوب، يستدعي runCount لمعرفة الإجمالي الحقيقي", async () => {
    const runCount = vi.fn().mockResolvedValue(120);
    const result = await countIfOffset(false, runCount, {
      rowsLength: 50,
      limit: 50,
      offset: 0,
    });
    expect(result).toBe(120);
    expect(runCount).toHaveBeenCalledTimes(1);
  });

  it("إذا كان offset أكبر من صفر (صفحة متقدمة)، يستدعي runCount لمعرفة الإجمالي الحقيقي", async () => {
    const runCount = vi.fn().mockResolvedValue(80);
    const result = await countIfOffset(false, runCount, {
      rowsLength: 10,
      limit: 50,
      offset: 50,
    });
    expect(result).toBe(80);
    expect(runCount).toHaveBeenCalledTimes(1);
  });
});

describe("paginateKeyset", () => {
  it("يدير وضع keyset عندما يمرر cursor ويستخرج nextCursor و hasMore", async () => {
    const fakeColumn = {} as any;
    const runQuery = vi.fn().mockResolvedValue([
      { id: 90 },
      { id: 80 },
      { id: 70 },
    ]);

    const result = await paginateKeyset({
      cursor: 100,
      limit: 2,
      idCol: fakeColumn,
      baseConds: [],
      runQuery,
    });

    expect(result.usingCursor).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].id).toBe(90);
    expect(result.rows[1].id).toBe(80);
    expect(result.nextCursor).toBe(80);
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), 3, 0);
  });

  it("يدير وضع offset عندما لا يمرر cursor", async () => {
    const fakeColumn = {} as any;
    const runQuery = vi.fn().mockResolvedValue([
      { id: 10 },
      { id: 9 },
    ]);

    const result = await paginateKeyset({
      limit: 2,
      offset: 4,
      idCol: fakeColumn,
      baseConds: [],
      runQuery,
    });

    expect(result.usingCursor).toBe(false);
    expect(result.hasMore).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBe(9);
    expect(runQuery).toHaveBeenCalledWith(undefined, 2, 4);
  });
});
