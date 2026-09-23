/**
 * Storefront visual tokens.
 *
 * Keep primitives, semantic intent and component-specific values separate so
 * the mobile commerce experience stays coherent while campaigns change.
 */
const primitive = {
  ink: "#183D36",
  inkSoft: "#5C716C",
  canvas: "#FFF8F2",
  surface: "#FFFFFF",
  line: "#E2E8F0",
  emerald: "#0E806A",
  emeraldDeep: "#075B4E",
  emeraldSoft: "#E6F5F1",
  azure: "#0E806A",
  azureDeep: "#075B4E",
  azureSoft: "#E6F5F1",
  sky: "#E6F5F1",
  coral: "#F05D53",
  coralSoft: "#FFF0F0",
  sand: "#FFF4DE",
  blueSoft: "#E6F5F1",
  muted: "#5C716C",
  mutedSoft: "#8FA39E",
  white: "#FFFFFF",
} as const;

const semantic = {
  background: primitive.canvas,
  surface: primitive.surface,
  foreground: primitive.ink,
  secondaryText: primitive.muted,
  border: primitive.line,
  brand: primitive.emerald,
  brandStrong: primitive.emeraldDeep,
  highlight: primitive.sky,
  promotion: primitive.coral,
  promotionSurface: primitive.coralSoft,
  safeSurface: primitive.emeraldSoft,
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
