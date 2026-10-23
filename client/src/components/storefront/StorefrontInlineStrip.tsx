import {
  BannerFrame,
  type StoreBannerCreative,
} from "@/components/store/BannerFrame";

export type BannerItem = StoreBannerCreative;

export function InlineStrip({
  banner,
}: {
  banner: BannerItem;
  tone?: "emerald" | "amber";
}) {
  return (
    <div className="relative col-span-full aspect-[3/1] overflow-hidden rounded-xl shadow-sm">
      <BannerFrame banner={banner} slot="INLINE" />
    </div>
  );
}
