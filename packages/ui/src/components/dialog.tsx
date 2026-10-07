"use client";

import * as React from "react";
import { Dialog as Primitive } from "radix-ui";
import { cn } from "@mandatepay/ui/lib/utils";

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export function DialogContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onOverlayPointerDown,
  ...props
}: React.ComponentProps<typeof Primitive.Content> & {
  onOverlayPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  const opener = React.useRef<HTMLElement | null>(null);
  return (
    <Primitive.Portal>
      <Primitive.Overlay
        className="fixed inset-0 z-50 bg-foreground/35"
        onPointerDown={onOverlayPointerDown}
      />
      <Primitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-popover p-6 text-popover-foreground shadow-xl outline-none sm:p-8",
          className,
        )}
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented && opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title
      className={cn("font-editorial text-2xl leading-tight", className)}
      {...props}
    />
  );
}
export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description
      className={cn("mt-2 text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}
