# Third-party materials and public-release status

The root MIT license covers the project's original source and documentation. It does not relicense third-party fonts or dependencies. Retain the original notices and terms for those materials.

## Fonts

| Font                 | Current use                      | Included terms                                                           |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Hedvig Letters Serif | Active headings                  | `apps/web/fonts/HEDVIG-LETTERS-SERIF-LICENSE.txt`, SIL Open Font License |
| Satoshi Variable     | Active body and controls         | `apps/web/fonts/SATOSHI-LICENSE.txt`, ITF Free Font License              |
| Geist                | Retained from initial foundation | `apps/web/fonts/GEIST-LICENSE.txt`, SIL Open Font License                |
| Instrument Serif     | Retained from initial foundation | `apps/web/fonts/INSTRUMENT-SERIF-LICENSE.txt`, SIL Open Font License     |

The included Satoshi terms permit use and self-hosting for the licensee's own website/application. Section 02 also explicitly restricts distributing the font software through a repository. These are different permissions: its presence in this local website does not establish permission to publish its binary in an open-source repository.

The Satoshi binary is now excluded from Git. `scripts/setup-fonts.mjs` obtains it directly from the official Fontshare service before local web development/build; it validates the download and retains the approved typography. A clone contains the vendor license and setup code, not a redistributed font binary. Developers must comply with the vendor's terms for their own website/application use. The other listed font binaries remain under their included OFL licenses.

## Other assets and packages

The meadow image was generated for this project; its prompt and optimized asset path are recorded in `docs/design/hero-artwork.md`. No Runable photography or logos were copied.

Dependencies installed from the pnpm lockfile retain their own licenses. Review any enterprise AG Grid/AG Studio usage and sponsor-provided licenses before the public release. Those integrations are not installed or qualified yet.

This file records the current release assessment; it does not grant additional rights to any third-party material.
