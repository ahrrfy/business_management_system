export type BackupDownloadFile = { name: string; sizeKb: number };
export type BackupDownloadProgress = {
  phase: "preparing" | "downloading" | "saving";
  receivedBytes: number;
  totalBytes: number;
};
type BackupWritable = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};
type BackupHandle = { createWritable(): Promise<BackupWritable> };
type BackupPicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<BackupHandle>;

/** Call directly from the click so the save dialog retains user activation. */
export async function saveBackupToDevice(
  source: () => Promise<BackupDownloadFile | null>,
  options: {
    suggestedName: string;
    signal?: AbortSignal;
    onProgress?: (progress: BackupDownloadProgress) => void;
  },
): Promise<"saved" | "started" | "cancelled"> {
  const picker = (window as unknown as { showSaveFilePicker?: BackupPicker })
    .showSaveFilePicker;
  let handle: BackupHandle | null = null;
  if (picker) {
    try {
      handle = await picker.call(window, {
        suggestedName: options.suggestedName,
        types: [
          {
            description: "نسخة قاعدة SQL",
            accept: { "application/sql": [".sql"] },
          },
        ],
      });
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return "cancelled";
      if ((error as DOMException)?.name !== "SecurityError") throw error;
    }
  }
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase: "preparing", receivedBytes: 0, totalBytes: 0 });
  const file = await source();
  if (!file) return "cancelled";
  options.signal?.throwIfAborted();
  const url = `/api/backups/download?name=${encodeURIComponent(file.name)}`;
  if (!handle) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return "started";
  }
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok)
    throw new Error(`تعذّر تنزيل النسخة (${response.status})؛ أعد المحاولة.`);
  const totalBytes = Number(
    response.headers.get("X-Backup-Size") ??
      response.headers.get("Content-Length"),
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !response.body) {
    await response.body?.cancel();
    throw new Error(
      "حجم النسخة غير صالح أو فارغ؛ لم تُحفظ نسخة ناجحة. أعد المحاولة.",
    );
  }
  const reader = response.body.getReader();
  let writable: BackupWritable | undefined;
  let receivedBytes = 0;
  let lastProgress = 0;
  try {
    writable = await handle.createWritable();
    options.onProgress?.({ phase: "downloading", receivedBytes, totalBytes });
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > totalBytes)
        throw new Error("حجم البيانات لا يطابق النسخة؛ أعد التنزيل.");
      await writable.write(value);
      const now = Date.now();
      if (now - lastProgress >= 250 || receivedBytes === totalBytes) {
        options.onProgress?.({
          phase: "downloading",
          receivedBytes,
          totalBytes,
        });
        lastProgress = now;
      }
    }
    if (receivedBytes !== totalBytes)
      throw new Error("لم يكتمل تنزيل النسخة؛ الملف ناقص. أعد المحاولة.");
    options.onProgress?.({ phase: "saving", receivedBytes, totalBytes });
    options.signal?.throwIfAborted();
    await writable.close();
    return "saved";
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writable?.abort().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
