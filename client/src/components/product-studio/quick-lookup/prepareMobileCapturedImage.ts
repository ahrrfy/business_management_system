import { compressCanvas } from "@/components/form/ImageUploader";

/**
 * مقياس ضغط آمن ومحكوم لتجهيز صور كاميرا الهاتف (خصوصا أجهزة أندرويد القديمة)
 * دون استنزاف الذاكرة أو التسبب في انهيار المتصفح.
 */
export async function prepareMobileCapturedImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذر قراءة ملف الصورة"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("تعذر تحميل بيانات الصورة"));
      img.onload = async () => {
        try {
          const MAX_DIM = 1600;
          let { width, height } = img;
          if (width > MAX_DIM || height > MAX_DIM) {
            if (width > height) {
              height = Math.round((height * MAX_DIM) / width);
              width = MAX_DIM;
            } else {
              width = Math.round((width * MAX_DIM) / height);
              height = MAX_DIM;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) {
            reject(new Error("تعذر إنشاء سياق معالجة الصورة"));
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, width, height);

          // ضغط محكوم وفق سلم ImageUploader لضمان حجم خفيف مناسب للهواتف و≤700KB
          const compressed = await compressCanvas(canvas);
          resolve(compressed.dataUrl);
        } catch (err) {
          reject(
            err instanceof Error ? err : new Error("تعذر ضغط وتجهيز الصورة"),
          );
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
