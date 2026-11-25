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
    <div className="relative col-span-full aspect-[3/1] overflow-hidden rounded-2xl shadow-sm ring-1 ring-slate-900/8">
      <BannerFrame banner={banner} slot="INLINE" />
    </div>
  );
}
