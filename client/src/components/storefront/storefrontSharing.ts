import { trpc } from "@/lib/trpc";
import type React from "react";
import type { CartLine } from "./storefrontCartMath";
import { STORE_NAME, type ShareFeedbackTone } from "./storefrontCatalogModel";
import {
  saveStorefrontWishlist,
  storefrontShareUrl,
} from "./storefrontPersistence";
interface Props {
  setHeartPulseTarget: React.Dispatch<React.SetStateAction<string | null>>;
  setHeartPulseNonce: React.Dispatch<React.SetStateAction<number>>;
  setSharePulseTarget: React.Dispatch<React.SetStateAction<string | null>>;
  setSharePulseNonce: React.Dispatch<React.SetStateAction<number>>;
  setWishlistIds: React.Dispatch<React.SetStateAction<Set<number>>>;
  setShareFeedback: React.Dispatch<
    React.SetStateAction<{ text: string; tone: ShareFeedbackTone } | null>
  >;
  cartLines: CartLine[];
  createCartShareM: Pick<
    ReturnType<typeof trpc.storefront.createCartShare.useMutation>,
    "isPending" | "mutateAsync"
  >;
}
export function storefrontSharingActions({
  setHeartPulseTarget,
  setHeartPulseNonce,
  setSharePulseTarget,
  setSharePulseNonce,
  setWishlistIds,
  setShareFeedback,
  cartLines,
  createCartShareM,
}: Props) {
  function pulseHeart(target: string) {
    setHeartPulseTarget(target);
    setHeartPulseNonce((value) => value + 1);
    window.setTimeout(
      () =>
        setHeartPulseTarget((current) => (current === target ? null : current)),
      620,
    );
  }
  function pulseShare(target: string) {
    setSharePulseTarget(target);
    setSharePulseNonce((value) => value + 1);
    window.setTimeout(
      () =>
        setSharePulseTarget((current) => (current === target ? null : current)),
      620,
    );
  }
  function toggleWishlist(productId: number, target = `product-${productId}`) {
    pulseHeart(target);
    setWishlistIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      saveStorefrontWishlist(next);
      return next;
    });
  }
  async function shareStorefrontContent(input: {
    title: string;
    text: string;
    url: string;
  }) {
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function"
      ) {
        await navigator.share(input);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(`${input.text}\\n${input.url}`);
        setShareFeedback({
          text: "تم نسخ رابط المشاركة — أرسله لمن تحب",
          tone: "ok",
        });
      } else {
        setShareFeedback({
          text: "انسخ الرابط من شريط العنوان لمشاركته",
          tone: "info",
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareFeedback({
        text: "تعذّرت المشاركة حالياً؛ يمكنك نسخ الرابط من شريط العنوان",
        tone: "err",
      });
    }
    window.setTimeout(() => setShareFeedback(null), 3600);
  }
  function shareProduct(productId: number, productName: string) {
    pulseShare(`product-${productId}`);
    void shareStorefrontContent({
      title: productName,
      text: `شاهد هذا المنتج من ${STORE_NAME}`,
      url: storefrontShareUrl({ product: String(productId) }),
    });
  }
  async function shareCart() {
    if (cartLines.length === 0 || createCartShareM.isPending) return;
    pulseShare("cart");
    try {
      const shared = await createCartShareM.mutateAsync({
        lines: cartLines.slice(0, 100).map((line) => ({
          productId: line.productId,
          productUnitId: line.productUnitId,
          quantity: Math.min(Math.max(Math.floor(line.qty), 1), 999),
        })),
      });
      await shareStorefrontContent({
        title: `سلة من ${STORE_NAME}`,
        text: `هذه سلة منتجات من ${STORE_NAME} — راجع الأسعار قبل تثبيت الطلب`,
        url: storefrontShareUrl({ cartToken: shared.token }),
      });
    } catch {
      setShareFeedback({
        text: "تعذّر إنشاء رابط السلة حالياً؛ يمكنك متابعة التصفح بشكل طبيعي",
        tone: "err",
      });
    }
  }
  return { pulseHeart, toggleWishlist, shareProduct, shareCart };
}
