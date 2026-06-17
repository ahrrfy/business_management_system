// مُرمِّز ESC/POS بسيط. للعربية نستخدم الطباعة النقطية (raster) لأن معظم
// الطابعات الحرارية لا تدعم الخط العربي نصياً. دوال نقية قابلة للاختبار.

export interface Raster {
  width: number; // بكسل
  height: number; // بكسل
  data: Uint8Array; // 1bpp معبّأة صفّاً صفّاً، البت الأعلى = أقصى اليسار، 1 = أسود
}

export class EscPos {
  private chunks: number[] = [];

  /** ESC @ — تهيئة الطابعة. */
  init(): this {
    this.chunks.push(0x1b, 0x40);
    return this;
  }

  raw(...bytes: number[]): this {
    this.chunks.push(...bytes);
    return this;
  }

  /** GS v 0 — طباعة صورة نقطية. */
  raster(bmp: Raster): this {
    const widthBytes = Math.ceil(bmp.width / 8);
    this.chunks.push(
      0x1d, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      bmp.height & 0xff, (bmp.height >> 8) & 0xff
    );
    for (let i = 0; i < bmp.data.length; i++) this.chunks.push(bmp.data[i]);
    return this;
  }

  feed(lines = 1): this {
    for (let i = 0; i < lines; i++) this.chunks.push(0x0a);
    return this;
  }

  /** GS V B n — قطع جزئي بعد تغذية n. */
  cut(): this {
    this.chunks.push(0x1d, 0x56, 0x42, 0x00);
    return this;
  }

  /** فتح درج النقود (ESC p). */
  openDrawer(): this {
    this.chunks.push(0x1b, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

/**
 * تحويل ImageData إلى نقطية 1bpp (أسود/أبيض) بعتبة لمعان قابلة للضبط.
 * `threshold`: كل بكسل لمعانه أقلّ منه يُطبع أسود. الافتراض 128 (المنتصف، السلوك القديم).
 * رفع العتبة يلتقط هالة التنعيم (anti-alias) الرمادية حول الحروف ⇒ خطوط أسمك وأغمق
 * وأوضح على الطابعة الحرارية (يُعالج بهتان الإيصال). لا يؤثّر على المنادين الذين يتركون الافتراض.
 */
export function imageDataToRaster(
  img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  threshold = 128,
): Raster {
  const { width, height, data } = img;
  const widthBytes = Math.ceil(width / 8);
  const out = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const alpha = data[i + 3];
      const black = alpha > 128 && lum < threshold;
      if (black) out[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height, data: out };
}
