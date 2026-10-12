import { expect, type Page } from "@playwright/test";

export type ChatStreamFrame = { event: string; data: Record<string, unknown> };
export type CapturedChat = {
  status: number;
  contentType: string;
  body: string;
};

/**
 * Chromium does not retain streamed (text/event-stream) response bodies, so specs cannot read
 * them from `page.waitForResponse`. This routes chat requests through `route.fetch`, records the
 * complete upstream body and replays it unchanged to the page.
 */
export async function captureChat(page: Page) {
  const ready: CapturedChat[] = [];
  const waiting: Array<(entry: CapturedChat) => void> = [];
  await page.route(/\/api\/agent\/chat(?:\/stream)?$/u, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch({ timeout: 140_000 });
    const body = await response.text();
    const entry = {
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
      body,
    };
    const waiter = waiting.shift();
    if (waiter) waiter(entry);
    else ready.push(entry);
    await route.fulfill({ response, body });
  });
  return {
    next(): Promise<CapturedChat> {
      const entry = ready.shift();
      return entry
        ? Promise.resolve(entry)
        : new Promise<CapturedChat>((resolve) => waiting.push(resolve));
    },
  };
}

export function chatStreamFrames(entry: CapturedChat): ChatStreamFrame[] {
  expect(entry.contentType).toContain("text/event-stream");
  return entry.body
    .split("\n\n")
    .map((frame) => frame.split("\n").filter((line) => line && !line.startsWith(":")))
    .filter((lines) => lines.length)
    .map((lines) => ({
      event: lines.find((line) => line.startsWith("event: "))!.slice(7),
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6)),
    }));
}

/** The chat result from the streaming endpoint, or from its JSON fallback. */
export function chatResult(entry: CapturedChat): Record<string, unknown> {
  if (!entry.contentType.includes("text/event-stream")) return JSON.parse(entry.body);
  const result = chatStreamFrames(entry).find((frame) => frame.event === "result");
  expect(result, "streamed chat result").toBeTruthy();
  return result!.data;
}
