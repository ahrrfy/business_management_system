// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImportDialog } from "../ImportDialog";
import type { ImportParseResult, ImportSummary } from "@/lib/import";

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  export: vi.fn(),
  ok: vi.fn(),
  err: vi.fn(),
}));
vi.mock("@/lib/import", async (original) => ({
  ...(await original<object>()),
  parseSheet: mocks.parse,
}));
vi.mock("@/lib/export", () => ({ exportRows: mocks.export }));
vi.mock("@/lib/notify", () => ({ notify: { ok: mocks.ok, err: mocks.err } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
}));
// Native equivalent keeps tests focused on draft/data lifecycle; real AppSelect is covered visually.
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ onValueChange, children, ...props }: any) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
}));

const fields = [
  { key: "name", label: "الاسم", type: "string", required: true },
] as const;
const sheet = (name: string, count = 1): ImportParseResult => ({
  headers: ["الاسم"],
  rows: Array.from({ length: count }, (_, index) => ({
    الاسم: `${name}${index}`,
  })),
  rowNumbers: Array.from({ length: count }, (_, index) => index + 2),
  totalRows: count,
});
const result = (count = 1, committed = true): ImportSummary => ({
  total: count,
  created: count,
  updated: 0,
  skipped: 0,
  failed: 0,
  committed,
  rows: Array.from({ length: count }, (_, index) => ({
    rowNumber: index + 2,
    status: "created",
  })),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let root: Root, host: HTMLDivElement;
let props: React.ComponentProps<typeof ImportDialog<{ name: string }>>;
const render = () => act(() => root.render(<ImportDialog {...props} />));
const buttons = () => Array.from(host.querySelectorAll("button"));
const button = (text: string) =>
  buttons().find((node) => node.textContent?.includes(text))!;
const choose = async (name = "data.csv") => {
  const input = host.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["name"], name)],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
  });
};
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue(sheet("جديد"));
  props = {
    open: true,
    onOpenChange: vi.fn(),
    title: "استيراد",
    entityName: "عميل",
    fields: [...fields],
    meta: { supportsServerOptions: true },
    onImport: vi.fn().mockResolvedValue(result()),
    onDone: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("ignores an old file read after closing and reopening", async () => {
  const pending = deferred<ImportParseResult>();
  mocks.parse.mockReturnValueOnce(pending.promise);
  render();
  await choose("old.csv");
  props.open = false;
  render();
  props.open = true;
  render();
  await choose("new.csv");
  await act(async () => pending.resolve(sheet("قديم")));
  expect(host.textContent).toContain("جديد0");
  expect(host.textContent).not.toContain("قديم0");
});
it("does not let the delayed close reset erase a reopened draft", async () => {
  render();
  await choose();
  await act(async () => button("استيراد 1").click());
  act(() => button("إغلاق").click());
  props.open = false;
  render();
  props.open = true;
  render();
  await choose("second.csv");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 220));
  });
  expect(host.textContent).toContain("second.csv");
  expect(host.textContent).toContain("جديد0");
});
it("starts a clean draft when the entity changes while open", async () => {
  render();
  await choose();
  props.entityName = "مورد";
  render();
  expect(host.textContent).not.toContain("جديد0");
  expect(button("اختر ملفاً")).toBeTruthy();
});
it("keeps acknowledged writes and refreshes lists after a later lost response", async () => {
  mocks.parse.mockResolvedValue(sheet("عميل", 1001));
  const first = result(1000);
  props.onImport = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error("connection lost"));
  render();
  await choose();
  await act(async () => button("استيراد 1001").click());
  expect(props.onImport).toHaveBeenCalledTimes(2);
  expect(props.onDone).toHaveBeenCalledTimes(1);
  expect(props.onDone).toHaveBeenCalledWith(
    expect.objectContaining({ created: 1000, committed: false, failed: 0 }),
  );
  expect(host.textContent).toContain("تعذّر تأكيد نتيجة الدفعة 2");
  expect(host.textContent).toContain("حفظ 1000");
  expect(button("إغلاق")).toBeTruthy();
  expect(button("استيراد 1001")).toBeUndefined();
});
it("exports server failures and skipped reasons from the completed outcome", async () => {
  props.onImport = vi.fn().mockResolvedValue({
    total: 2,
    created: 0,
    updated: 0,
    failed: 1,
    skipped: 1,
    committed: false,
    rows: [
      { rowNumber: 2, status: "failed", message: "تعارض رقم العميل" },
      { rowNumber: 3, status: "skipped", message: "موجود مسبقاً" },
    ],
  });
  render();
  await choose();
  await act(async () => button("استيراد 1").click());
  act(() => button("تصدير سجلّ الأخطاء").click());
  expect(mocks.export.mock.calls[0][0]).toEqual([
    { row: 2, errors: "تعارض رقم العميل" },
    { row: 3, errors: "موجود مسبقاً" },
  ]);
});
it("does not return to a writable form when onDone fails", async () => {
  props.onDone = vi.fn(() => {
    throw new Error("refresh failed");
  });
  render();
  await choose();
  await act(async () => button("استيراد 1").click());
  expect(props.onImport).toHaveBeenCalledTimes(1);
  expect(button("إغلاق")).toBeTruthy();
  expect(button("استيراد 1")).toBeUndefined();
});
it("locks submissions synchronously and blocks close until completion callbacks finish", async () => {
  const pending = deferred<void>();
  props.onDone = vi.fn(() => pending.promise);
  render();
  await choose();
  const submit = button("استيراد 1");
  await act(async () => {
    submit.click();
    submit.click();
  });
  expect(props.onImport).toHaveBeenCalledTimes(1);
  expect(button("إغلاق").disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(button("إغلاق").disabled).toBe(false);
});
it("uses the same skip-failed default on initial open and reopen", async () => {
  render();
  await choose();
  expect(
    host.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
  ).toBe("true");
  props.open = false;
  render();
  props.open = true;
  render();
  await choose();
  expect(
    host.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
  ).toBe("true");
});
it("ignores errors from a closed read and permits selecting the same failed file again", async () => {
  const pending = deferred<ImportParseResult>();
  mocks.parse.mockReturnValueOnce(pending.promise);
  render();
  await choose();
  props.open = false;
  render();
  props.open = true;
  render();
  await act(async () => pending.reject(new Error("old error")));
  expect(mocks.err).not.toHaveBeenCalled();
  mocks.parse.mockRejectedValueOnce(new Error("bad file"));
  await choose();
  await choose();
  expect(mocks.parse).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain("جديد0");
});
it("preserves the submitted payload and server options", async () => {
  props.meta = { supportsServerOptions: true, balanceSignDefault: "invert" };
  render();
  await choose();
  await act(async () => button("استيراد 1").click());
  expect(props.onImport).toHaveBeenCalledWith(
    [{ name: "جديد0", rowNumber: 2 }],
    expect.objectContaining({
      options: { skipFailed: true },
    }),
  );
});
it("does not count rolled-back classifications as saved records", async () => {
  props.onImport = vi.fn().mockResolvedValue({
    ...result(2, false),
    failed: 1,
    total: 3,
    rows: [
      ...result(2, false).rows,
      { rowNumber: 4, status: "failed", message: "رفض الخادم الدفعة" },
    ],
  });
  render();
  await choose();
  await act(async () => button("استيراد 1").click());
  expect(props.onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      created: 0,
      updated: 0,
      failed: 3,
      committed: false,
    }),
  );
  expect(host.textContent).toContain("لم يُحفظ الصف");
});
it("runs every preflight before writing any batch when skip-failed is disabled", async () => {
  mocks.parse.mockResolvedValue(sheet("عميل", 1001));
  const calls: string[] = [];
  props.onImport = vi.fn(async (rows, context) => {
    calls.push(context.options?.dryRun ? "dry" : "write");
    return {
      ...result(rows.length),
      rows: rows.map((row) => ({
        rowNumber: row.rowNumber,
        status: "created",
      })),
    };
  });
  render();
  await choose();
  act(() =>
    (host.querySelector('[role="switch"]') as HTMLButtonElement).click(),
  );
  await act(async () => button("استيراد 1001").click());
  expect(calls).toEqual(["dry", "dry", "write", "write"]);
  expect(props.onDone).toHaveBeenCalledWith(
    expect.objectContaining({ created: 1001, committed: true }),
  );
});
it("reports a failed preflight without claiming any creations or updates", async () => {
  mocks.parse.mockResolvedValue(sheet("عميل", 1001));
  props.onImport = vi
    .fn()
    .mockResolvedValueOnce(result(1000, false))
    .mockResolvedValueOnce({
      total: 1,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 1,
      committed: false,
      rows: [{ rowNumber: 1002, status: "failed", message: "مرفوض في الفحص" }],
    });
  render();
  await choose();
  act(() =>
    (host.querySelector('[role="switch"]') as HTMLButtonElement).click(),
  );
  await act(async () => button("استيراد 1001").click());
  expect(props.onImport).toHaveBeenCalledTimes(2);
  expect(props.onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      created: 0,
      updated: 0,
      failed: 1,
      skipped: 1000,
      committed: false,
    }),
  );
  expect(host.textContent).toContain("لم يُنفّذ الصف");
});
it("counts rolled-back asset row classifications even when the server zeroed creation counters", async () => {
  props.onImport = vi
    .fn()
    .mockResolvedValue({
      ...result(2, false),
      created: 0,
      failed: 1,
      total: 3,
      rows: [
        ...result(2, false).rows,
        { rowNumber: 4, status: "failed", message: "رفض الخادم الدفعة" },
      ],
    });
  render();
  await choose();
  await act(async () => button("استيراد 1").click());
  expect(props.onDone).toHaveBeenCalledWith(
    expect.objectContaining({ created: 0, failed: 3, committed: false }),
  );
});
it("does not promise a safe whole-file retry after partial writes", async () => {
  mocks.parse.mockResolvedValue(sheet("أصل", 1001));
  props.entityName = "أصل";
  props.onImport = vi.fn(async (rows, context) => {
    if (context.options?.dryRun) return result(rows.length, false);
    return rows.length === 1000
      ? result(1000)
      : {
          total: 1,
          created: 0,
          updated: 0,
          failed: 1,
          skipped: 0,
          committed: false,
          rows: [{ rowNumber: 1002, status: "failed", message: "رفض" }],
        };
  });
  render();
  await choose();
  act(() =>
    (host.querySelector('[role="switch"]') as HTMLButtonElement).click(),
  );
  await act(async () => button("استيراد 1001").click());
  expect(host.textContent).toContain(
    "تحقّق من البيانات المحفوظة قبل إعادة المحاولة",
  );
  expect(host.textContent).not.toMatch(/إعادة التشغيل\s+آمنة/);
});
