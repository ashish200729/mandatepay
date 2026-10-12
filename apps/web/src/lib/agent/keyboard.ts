/** Enter sends, Shift+Enter inserts a line break, and IME composition is never interrupted. */
export function shouldSendOnKey(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean };
}) {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
}
