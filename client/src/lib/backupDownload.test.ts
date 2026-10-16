import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveBackupToDevice } from "./backupDownload";

describe("saving a backup to the device", () => {
  const file = { name: "erp-backup.sql", sizeKb: 1 };
  const writer = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
  const createWritable = vi.fn();
  const picker = vi.fn();
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    writer.write.mockResolvedValue(undefined);
    writer.close.mockResolvedValue(undefined);
    writer.abort.mockResolvedValue(undefined);
    createWritable.mockResolvedValue(writer);
    picker.mockResolvedValue({ createWritable });
    vi.stubGlobal("window", { showSaveFilePicker: picker });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes the first chunk before waiting for the rest of a large file", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
      { headers: { "X-Backup-Size": "8" } },
    );
    fetchMock.mockResolvedValue(response);
    const progress = vi.fn();
    const saving = saveBackupToDevice(async () => file, {
      suggestedName: file.name,
      onProgress: progress,
    });
    stream.enqueue(new Uint8Array([1, 2, 3, 4]));
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalledOnce());
    expect(writer.close).not.toHaveBeenCalled();
    stream.enqueue(new Uint8Array([5, 6, 7, 8]));
    stream.close();
    await expect(saving).resolves.toBe("saved");
    expect(writer.close).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith({
      phase: "saving",
      receivedBytes: 8,
      totalBytes: 8,
    });
  });
  it("rejects zero-size responses before opening a writable file", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { headers: { "X-Backup-Size": "0" } }),
    );
    await expect(
      saveBackupToDevice(async () => file, { suggestedName: file.name }),
    ).rejects.toThrow(/حجم|فارغ/);
    expect(createWritable).not.toHaveBeenCalled();
  });
  it("aborts a truncated download instead of committing it as a successful backup", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "X-Backup-Size": "8" },
      }),
    );
    await expect(
      saveBackupToDevice(async () => file, { suggestedName: file.name }),
    ).rejects.toThrow(/اكتمل|ناقص|حجم/);
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });
  it("preserves an existing file when writing fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { "X-Backup-Size": "1" } }),
    );
    writer.write.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(
      saveBackupToDevice(async () => file, { suggestedName: file.name }),
    ).rejects.toThrow("disk unavailable");
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });
  it("does not create or fetch a backup when the save dialog is cancelled", async () => {
    picker.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    const source = vi.fn();
    await expect(
      saveBackupToDevice(source, { suggestedName: file.name }),
    ).resolves.toBe("cancelled");
    expect(source).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses a native resumable download when the file picker is unavailable", async () => {
    vi.stubGlobal("window", {});
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { append: vi.fn() },
    });
    await expect(
      saveBackupToDevice(async () => file, { suggestedName: file.name }),
    ).resolves.toBe("started");
    expect(anchor.href).toBe("/api/backups/download?name=erp-backup.sql");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not commit when cancellation arrives at the saving boundary", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), { headers: { "X-Backup-Size": "1" } }),
    );
    const controller = new AbortController();
    await expect(
      saveBackupToDevice(async () => file, {
        suggestedName: file.name,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "saving") controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(writer.close).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
  });
});
