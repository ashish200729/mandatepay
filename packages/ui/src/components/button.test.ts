import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, buttonVariants } from "./button";

describe("button variants", () => {
  it("lets a caller override conflicting layout classes", () => {
    const classes = buttonVariants({
      size: "lg",
      className: "h-14 rounded-xl px-8",
    });

    expect(classes).toContain("h-14");
    expect(classes).not.toContain("h-12");
    expect(classes).toContain("rounded-xl");
    expect(classes).not.toContain("rounded-full");
    expect(classes).toContain("px-8");
    expect(classes).not.toContain("px-6");
  });

  it("keeps keyboard focus styling in the shared contract", () => {
    const classes = buttonVariants();

    expect(classes).toContain("focus-visible:outline-solid");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-offset-4");
    expect(classes).toContain("focus-visible:outline-ring");
  });

  it("renders native disabled state and disabled interaction styles", () => {
    const markup = renderToStaticMarkup(
      createElement(Button, { disabled: true }, "Approve with PayPal"),
    );

    expect(markup).toContain("disabled");
    expect(markup).toContain("disabled:pointer-events-none");
    expect(markup).toContain("disabled:opacity-45");
  });
});
