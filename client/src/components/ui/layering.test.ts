/**
 * **قانونُ طبقات النوافذ — محروسٌ نصّياً** (#122، وُسِّع ٢/٩/٢٦ ببلاغ المالك).
 *
 * الترتيب الحاكم من الأدنى إلى الأعلى:
 *
 * | الطبقة | مَن | لماذا |
 * |---|---|---|
 * | `z-50`    | نوافذ Radix الأساسية (Dialog/Sheet/Drawer) | الحاوي |
 * | `z-[100]` | النوافذ اليدوية `fixed inset-0` | فوق الحاوي |
 * | `z-[150]` | **القوائم المنبثقة** (select · dropdown · popover · tooltip) | فوق أيّ حاوٍ |
 * | `z-[200]` | حوار التأكيد `confirm()` | القمّة دائماً |
 *
 * **العطبُ الذي أوجب `z-[150]`:** المنبثقات تُصيَّر في **Portal على `body`**، فهي شقيقةٌ
 * لكلّ نافذةٍ يدويّة لا ابنةٌ لها. وبطبقة `z-50` كانت تقع **خلف** كلّ نافذةٍ يدويّة
 * (`z-[100]`) — تُفتَح فعلاً ولا تُرى ولا تُنتقى. أصاب «تسليم لمندوب» (بلاغ المالك بالصورة)،
 * وكان كامناً في **عشرة ملفات** فيها نوافذ يدوية تحوي قوائم.
 *
 * ⛔ ولا تتجاوز `z-[200]`: حوارُ التأكيد يجب أن يبقى فوق الجميع، وإلّا عاد عطبُ #122 نفسه
 * (تجمّدُ الشاشة حين يُستدعى `confirm()` من داخل نافذة).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PORTALLED_POPUPS = ["select", "dropdown-menu", "popover", "tooltip"] as const;

function read(name: string): string {
  return readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");
}

/** يستخرج كل طبقات z المصرَّح بها في الملفّ (`z-50` أو `z-[150]`). */
function layersOf(source: string): string[] {
  return Array.from(source.matchAll(/z-\[?(\d+)\]?/g)).map((m) => m[1]);
}

describe("قانون طبقات النوافذ", () => {
  it("⭐ كلُّ منبثقٍ مُصيَّرٍ في Portal طبقتُه z-[150] — لا z-50", () => {
    for (const name of PORTALLED_POPUPS) {
      const source = read(name);
      // إثباتُ أنّه Portal فعلاً — وإلّا لم يكن القانون منطبقاً عليه أصلاً.
      expect(source, `${name}: يُفترض أن يُصيَّر في Portal`).toContain("Portal");
      const layers = layersOf(source);
      expect(layers.length, `${name}: بلا طبقةٍ مصرَّح بها`).toBeGreaterThan(0);
      for (const layer of layers) {
        expect(
          layer,
          `${name}: طبقة z-${layer} — المنبثق يجب أن يكون 150 ليعلو النوافذ اليدوية (z-100)`,
        ).toBe("150");
      }
    }
  });

  it("⛔ ولا يعلو حوارَ التأكيد (z-[200]) فيحبسه خلفه — عطب #122", () => {
    for (const name of PORTALLED_POPUPS) {
      for (const layer of layersOf(read(name))) {
        expect(Number(layer), `${name}: تجاوز طبقة حوار التأكيد`).toBeLessThan(200);
      }
    }
  });

  it("حوارُ التأكيد العام يبقى في القمّة", () => {
    // `AlertDialog` هو أساسُ `confirm()` — طبقتُه رُفعت إلى z-[200] في #122.
    const alertDialog = read("alert-dialog");
    expect(alertDialog).toContain("z-[200]");
  });
});
