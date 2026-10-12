import { expect, type Page, type TestInfo } from "@playwright/test";

export async function captureWorkspace(page: Page, testInfo: TestInfo, name: string) {
  const original = page.viewportSize();
  for (const width of [1440, 390, 320, 768]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    const overflow = await page.evaluate(() => {
      if (document.documentElement.scrollWidth <= window.innerWidth) return null;
      const widest = [...document.querySelectorAll("body *")]
        .map((element) => ({ element, right: element.getBoundingClientRect().right }))
        .filter(({ right }) => right > window.innerWidth + 1)
        .sort((a, b) => b.right - a.right)[0];
      return widest
        ? `${widest.element.tagName.toLowerCase()}.${widest.element.className} → ${Math.round(widest.right)}px`
        : `document ${document.documentElement.scrollWidth}px`;
    });
    expect(overflow, `no horizontal overflow at ${width}px`).toBeNull();
    if (new URL(page.url()).pathname === "/chat") {
      const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
      expect(send).not.toBeNull();
      expect(send!.y + send!.height).toBeLessThanOrEqual(width < 600 ? 844 : 900);
      const heights = await page.evaluate(() => ({
        document: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
      }));
      expect(heights.document, `chat must fit the ${width}px viewport`).toBeLessThanOrEqual(
        heights.viewport + 1,
      );
      await page.getByRole("log", { name: "Shopping conversation" }).evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    }
    if (width === 1440 || width === 390)
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${width === 1440 ? "desktop" : "mobile"}.png`),
        fullPage: true,
      });
  }
  if (original) await page.setViewportSize(original);
}
