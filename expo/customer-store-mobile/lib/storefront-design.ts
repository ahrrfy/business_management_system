/**
 * Storefront visual tokens.
 *
 * Keep primitives, semantic intent and component-specific values separate so
 * the mobile commerce experience stays coherent while campaigns change.
 */
const primitive = {
  ink: "#161A22",
  inkSoft: "#59616F",
  canvas: "#F3F5F9",
  surface: "#FFFFFF",
  line: "#E2E7EF",
  azure: "#2898E5",
  azureDeep: "#147FCB",
  azureSoft: "#E7F4FE",
  sky: "#D9F0FF",
  coral: "#F05252",
  coralSoft: "#FFF0F0",
  sand: "#FFF4DE",
  blueSoft: "#ECF5FF",
  muted: "#737B88",
  mutedSoft: "#ADB5C0",
  white: "#FFFFFF",
} as const;

const semantic = {
  background: primitive.canvas,
  surface: primitive.surface,
  foreground: primitive.ink,
  secondaryText: primitive.muted,
  border: primitive.line,
  brand: primitive.azure,
  brandStrong: primitive.azureDeep,
  highlight: primitive.sky,
  promotion: primitive.coral,
  promotionSurface: primitive.coralSoft,
  safeSurface: primitive.azureSoft,
} as const;

export const storefrontDesign = {
  primitive,
  semantic,
  component: {
    appBar: {
      background: semantic.background,
      iconBackground: semantic.surface,
      iconBorder: semantic.border,
    },
    search: {
      background: semantic.surface,
      border: semantic.border,
      actionBackground: semantic.brandStrong,
    },
    card: {
      background: semantic.surface,
      border: semantic.border,
      radius: 24,
    },
    primaryButton: {
      background: semantic.brandStrong,
      foreground: primitive.white,
      radius: 16,
    },
  },
} as const;

export type StorefrontDesign = typeof storefrontDesign;
