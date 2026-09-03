export function marketingCarouselGeometry(viewportWidth: number) {
  const cardWidth = Math.min(Math.max(viewportWidth - 32, 288), 480);
  return {
    cardWidth,
    sideInset: Math.max(16, (viewportWidth - cardWidth) / 2),
  };
}
