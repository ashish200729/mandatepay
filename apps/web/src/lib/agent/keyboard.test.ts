import { describe, expect, it } from "vitest";
import { shouldSendOnKey } from "./keyboard";

const key = (overrides: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }>) => ({
  key: overrides.key ?? "Enter",
  shiftKey: overrides.shiftKey ?? false,
  nativeEvent: { isComposing: overrides.isComposing ?? false },
});

describe("chat composer keys", () => {
  it("sends on Enter and on Ctrl or Cmd+Enter", () => {
    expect(shouldSendOnKey(key({}))).toBe(true);
  });

  it("keeps Shift+Enter for a new line and never interrupts IME composition", () => {
    expect(shouldSendOnKey(key({ shiftKey: true }))).toBe(false);
    expect(shouldSendOnKey(key({ isComposing: true }))).toBe(false);
    expect(shouldSendOnKey(key({ key: "a" }))).toBe(false);
  });
});
