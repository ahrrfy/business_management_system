export interface ImageItem {
  id: string;
  /** dataURL مؤقّت من القارئ المحلي — يُستبدل بـ`url` نهائي عند الحفظ. */
  dataUrl: string;
  /** url نهائي (بعد رفع للخادم) — قد يكون فارغاً قبل الحفظ. */
  url?: string;
  isPrimary: boolean;
  name?: string;
  sizeKB?: number;
}

/** The native accept attribute does not validate drag/drop or scripted selection. */
export function acceptsImage(file: Pick<File, "name" | "type">, accept: string): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (!type.startsWith("image/")) return false;
  return accept.split(",").some((entry) => {
    const rule = entry.trim().toLowerCase();
    return rule === "image/*" || rule === type || (rule.startsWith(".") && name.endsWith(rule));
  });
}

/** Rebase decoded files on the latest gallery; never restore a removed target. */
export function mergeUploadedImages(current: ImageItem[], uploaded: ImageItem[], replacingId: string | null, maxItems: number, singlePrimary: boolean): ImageItem[] | null {
  const next = current.map((image) => ({ ...image }));
  if (replacingId) {
    const index = next.findIndex((image) => image.id === replacingId);
    if (index < 0) return null;
    if (uploaded[0]) next[index] = { ...uploaded[0], isPrimary: next[index].isPrimary };
  } else {
    next.push(...uploaded.slice(0, Math.max(0, maxItems - next.length)));
  }
  if (singlePrimary && next.length && !next.some((image) => image.isPrimary)) next[0].isPrimary = true;
  return next;
}

