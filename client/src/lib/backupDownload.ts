export type BackupDownloadFile = { name: string; sizeKb: number };
export type BackupDownloadProgress = {
  phase: "preparing" | "downloading" | "retrying" | "saving";
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

class RetryDownload extends Error {}
function retryDelay(attempt: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
      Math.min(500 * 2 ** attempt, 8000),
    );
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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
  let writable: BackupWritable | undefined;
  let receivedBytes = 0;
  let totalBytes = 0;
  let lastProgress = 0;
  let downloadId: string | null = null;
  let etag: string | null = null;
  let lastModified: string | null = null;
  try {
    for (let attempt = 0; ; attempt++) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      try {
        options.signal?.throwIfAborted();
        const range = receivedBytes > 0;
        try {
          response = await fetch(
            url +
              (downloadId
                ? `&downloadId=${encodeURIComponent(downloadId)}`
                : ""),
            {
              credentials: "same-origin",
              cache: "no-store",
              signal: options.signal,
              headers: range
                ? {
                    Range: `bytes=${receivedBytes}-`,
                    "If-Range": lastModified!,
                  }
                : undefined,
            },
          );
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof TypeError)) throw error;
          throw new RetryDownload(
            "انقطع الاتصال أثناء تنزيل النسخة؛ أعد المحاولة.",
          );
        }
        if ([502, 503, 504].includes(response.status))
          throw new RetryDownload("الخادم غير متاح مؤقتاً؛ أعد المحاولة.");
        if (!response.ok)
          throw new Error(
            `تعذّر تنزيل النسخة (${response.status})؛ أعد المحاولة.`,
          );
        const size = Number(
          response.headers.get("X-Backup-Size") ??
            response.headers.get("Content-Length"),
        );
        if (!Number.isSafeInteger(size) || size <= 0 || !response.body)
          throw new Error(
            "حجم النسخة غير صالح أو فارغ؛ لم تُحفظ نسخة ناجحة. أعد المحاولة.",
          );
        if (!writable) {
          if (response.status !== 200)
            throw new Error("استجابة تنزيل غير صالحة؛ أعد المحاولة.");
          totalBytes = size;
          downloadId = response.headers.get("X-Backup-Download-Id");
          etag = response.headers.get("ETag");
          lastModified = response.headers.get("Last-Modified");
          writable = await handle.createWritable();
        } else {
          const expectedRange = `bytes ${receivedBytes}-${totalBytes - 1}/${totalBytes}`;
          if (
            size !== totalBytes ||
            response.headers.get("X-Backup-Download-Id") !== downloadId ||
            response.headers.get("ETag") !== etag ||
            response.headers.get("Last-Modified") !== lastModified ||
            (range &&
              (response.status !== 206 ||
                response.headers.get("Content-Range") !== expectedRange ||
                response.headers.has("Content-Encoding") ||
                Number(response.headers.get("Content-Length")) !==
                  totalBytes - receivedBytes)) ||
            (!range && response.status !== 200)
          )
            throw new Error(
              "تغيّرت هوية النسخة أو موضع الاستئناف؛ أعد التنزيل.",
            );
        }
        reader = response.body.getReader();
        options.onProgress?.({
          phase: "downloading",
          receivedBytes,
          totalBytes,
        });
        while (true) {
          options.signal?.throwIfAborted();
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            options.signal?.throwIfAborted();
            throw new RetryDownload(
              "انقطع الاتصال أثناء تنزيل النسخة؛ أعد المحاولة.",
            );
          }
          options.signal?.throwIfAborted();
          if (chunk.done) break;
          if (receivedBytes + chunk.value.byteLength > totalBytes)
            throw new Error("حجم البيانات لا يطابق النسخة؛ أعد التنزيل.");
          // Disk errors are fatal. Only acknowledged writes advance the resume offset.
          await writable.write(chunk.value);
          receivedBytes += chunk.value.byteLength;
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
          throw new RetryDownload(
            "لم يكتمل تنزيل النسخة؛ الملف ناقص. أعد المحاولة.",
          );
        break;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          !(error instanceof RetryDownload) ||
          attempt >= 5 ||
          (writable &&
            (!downloadId || !lastModified || receivedBytes === totalBytes))
        )
          throw error;
        options.onProgress?.({ phase: "retrying", receivedBytes, totalBytes });
        await retryDelay(attempt, options.signal);
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        } else await response?.body?.cancel().catch(() => {});
      }
    }
    options.onProgress?.({ phase: "saving", receivedBytes, totalBytes });
    options.signal?.throwIfAborted();
    await writable!.close();
    return "saved";
  } catch (error) {
    await writable?.abort().catch(() => {});
    throw error;
  }
}
