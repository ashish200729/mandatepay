# MandatePay visual foundation

## Direction

Warm editorial commerce, guided by the user's Runable screenshots: luminous ivory, quiet text navigation, upright serif display typography, and warm sand panels. A calm landscape photograph opens the page. Product permission examples carry the content; no invented social proof or transaction activity.

## Shared palette

All application surfaces use semantic tokens in packages/ui/src/styles/globals.css. This revision intentionally replaces the first foundation's gray neutral palette, as requested by the user.

| Role                 | Color   |
| -------------------- | ------- |
| Background           | #FEFAF6 |
| Foreground / primary | #1B140E |
| Secondary text       | #6A6158 |
| Borders              | #E7E0D7 |
| Subtle surfaces      | #F8F1EB |
| Cards                | #FFFFFF |
| Sand / accent panels | #F3E7C9 |
| Sand borders         | #E5DABD |
| Dark surfaces        | #251D17 |
| Inverse text         | #FEFAF6 |

## Typography

Hedvig Letters Serif for upright display headings; Satoshi Variable for body, navigation, controls, and data. Both match the font families found in Runable's public marketing stylesheet and are sourced from their official distributors. Self-host with next/font/local; retain font license files. Main headings use 34–80px, regular weight, and modest negative tracking. Body uses 14–18px with relaxed line height. Prices use tabular figures.

## Composition

A centered photographic hero, an illustrative natural-language mandate, three parallel outcome panels, a mandate-to-permission explanation, a compact control section, native FAQ disclosures, and a continuous photographic closing section and footer. Content widths are 900–1408px. Headings and subtitles are centered when introducing parallel content; task explanations use two columns. Preserve generous spacing while keeping the hero's primary action and example visible.

## Artwork

apps/web/public/images/mandatepay-meadow.webp is a generated editorial meadow photograph, optimized to approximately 163 KiB. Use next/image with responsive sizes and preload for the hero. Reuse the same asset lazily in the footer, with a lower landscape crop and a warm ivory overlay. The closing message and footer share one uninterrupted background. Footer secondary text uses darker foreground tones to maintain contrast over the photograph. All product copy remains HTML. The background has empty alt text because it is decorative. Full prompt: docs/design/hero-artwork.md.

## Components and behavior

Tailwind v4 and shared shadcn/ui primitives. Header destinations are plain text links, with one compact pill-shaped primary action. Hero actions retain 16px rounded rectangular surfaces. Shared buttons use consistent 44–48px target sizes, icon spacing, hover and pressed tones, and one high-contrast solid focus outline. Class overrides pass through cn so variant and responsive classes cannot collide. No transform or scale animation on controls. Elevation is reserved for the hero's floating mandate and the mobile navigation panel. Native details drives mobile navigation and FAQs; anchors navigate the page. Respect reduced-motion settings.

## Product truth

This remains a foundation template. No AI, payments, policy enforcement, database, or provider integration is connected. Purchase examples are labeled illustrative. No fake signup or checkout action is introduced. Preserve the backend and workspace architecture.
