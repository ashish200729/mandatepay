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

The application now includes authenticated mandates, product discovery, conversational proposals, deterministic policy enforcement, human approvals, Sandbox payment/refund APIs, audit history and analytics. Landing-page examples remain illustrative. Preserve the approved warm visual world across application surfaces. AI explanations must remain separate from actual AgentGuard and payment facts. Label Demo Catalog and Sandbox explicitly; hosted and live financial qualification are separate from local automated evidence.

## Dashboard Workspace

The authenticated workspace extends MandatePay’s established warm editorial system into a calm purchasing ledger. Use the existing semantic palette: warm ivory `#FEFAF6`, deep brown foreground `#1B140E`, muted brown text `#6A6158`, warm borders `#E7E0D7`, subtle surfaces `#F8F1EB`, white cards, sand `#F3E7C9`, and sand borders `#E5DABD`. Use Hedvig Letters Serif for page headings and Satoshi Variable for navigation, section headings, controls, labels, ledger data, and analytics. Monetary values use tabular figures.

On desktop, frame the workspace with a sticky, `h-dvh` 232px sidebar and a sticky 72px utility bar. The sidebar uses a quiet warm surface, sand active navigation, and compact account controls. The utility bar carries the current workspace path, PayPal Sandbox status, and the New mandate action. Workspace page headings use Hedvig at 30px on compact screens and 40px from the small breakpoint upward, with short descriptions and restrained vertical spacing.

Keep the primary dashboard sequence compact: four summary metrics, one bordered white transaction ledger, a read-only natural-language query row, labeled amount/decision/category filters, compact analysis bars, and policy history. The wide AG Grid ledgers appear at the `xl` breakpoint (1280px); below 1280px, complete stacked records replace them. On desktop, keep the initial transaction columns visible at 1280px and 1440px in this order: Activity date · UTC, Product, Amount, Decision, Payment. Give those columns explicit widths; keep Mandate, Merchant, Approval, and Refund available through internal ledger scrolling with an explicit scroll cue. The policy grid leads with UTC date, Product, and Reason, with secondary mandate details following. Use 44px table headers, 56px rows, warm borders, Satoshi data text, visible decision labels, and tabular amounts. Links should open the exact proposal, payment, or audit record.

The captured-purchases summary may include supporting counts, but label them explicitly as “Policy decisions” and “Human-approved decisions”; these labels must not imply that either count is a subset of captured purchases. Keep the financial meaning of captured purchases, policy outcomes, and approvals distinct.

At mobile widths, replace wide tables with complete stacked summaries. Each transaction summary retains product, amount, merchant, decision, date, mandate/version, approval, payment, and refund details. Policy events retain product, merchant, date, reason codes, and mandate/version. Preserve readable wrapping and touch-sized actions rather than hiding financial or policy context.

Every data surface needs an explicit state. Loading uses calm skeleton blocks and `role="status"` announcements. Empty transaction, chart, policy, mandate, and order states explain what will appear and provide the next useful action where one exists. Errors use a bordered alert with plain language and a visible retry action. Query, filter, and pagination failures remain local to the affected surface.

The mobile menu button exposes `aria-expanded` and `aria-controls`. When opened, focus moves to the active navigation link or first link; Escape closes the menu and restores focus to the trigger. Clicking the scrim or a navigation link closes the menu. Keep the skip-to-content link, visible focus rings, 44px touch targets, and reduced-motion behavior intact. No dashboard-specific raster assets were added.

## Admin workspace

The admin shell retains the warm ivory/sand palette, Hedvig page headings and Satoshi controls/data. It uses a 232px independently scrollable desktop sidebar, sticky utility bar with an explicit environment label, and a focus-trapped tablet/mobile drawer. Current session navigation is enabled; later modules show Soon until implemented. Shared collection tables become complete cards below the large breakpoint, preserving every field and exact detail link. Status tokens add restrained accessible success/warning/danger/info surfaces with text labels. Missing metrics display an em dash with an explanation. Shared dialogs show concrete targets, required reasons and fresh typed final review for sensitive actions. See [the admin UI contract](docs/architecture/admin-ui.md).

## Workspace task flows

Chat occupies the available viewport beneath the utility bar. Keep its conversation independently scrollable and its composer visible. The mandate selector gets a full row on phones; budget facts follow it. Follow the latest reply across resizing when the reader is already at the end, and offer a jump action while reading history. Show the actual answer immediately with readable paragraphs, lists, emphasis and tables. Keep server steps in an optional disclosure. Discovery replies use server-owned catalog and mandate facts; proposal cards carry the recorded policy result and the exact next action. AI explanations remain explanatory and cannot replace recorded policy or payment facts.

Discovery is a separate protected `/discover` page. Preserve an explicitly chosen mandate when arriving from chat; require a choice when multiple mandates are active. Keep comparison feedback and the proposal action with each product. A selected proposal opens its exact approval record. Approval details appear beside the inbox on desktop and replace the list on smaller screens, with a back action and keyboard focus restoration.

Selecting a previously displayed chat product preserves its verified title, listed price and retailer. Show retailer product links for external listings when available. Explain unsupported external checkout directly, without a service-unavailable error or a false order claim. Ask for clarification when multiple listings match; an expired selection restores the request and asks for a fresh search. Clear selection context when changing mandates or starting a new brief.

Mandate creation follows Describe, Review, Activate. Review begins with a readable summary of every permission; editing is an explicit step. Place consent and saving after the summary, without covering form fields. Saving leads to a focused activation checkpoint. Mandate and order collections use search, status filters, and readable rows. Receipts keep payment facts, refunds, and audit history distinct. Settings display confirmed server values and a saving state; checkout retries reload facts without starting payment. Preserve the existing explicit financial confirmations and server validation boundaries.

During mandate creation, show missing-information questions and request failures directly below the request input, before the review action. Focus and scroll the feedback into view, associate it with the input for assistive technology, preserve the request, and explain the next step in plain language. Missing information offers “Edit my request”; service failures offer “Try again.” Announce parsing while controls are disabled and focus the permission heading when review is ready.
