import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@mandatepay/ui/lib/utils";
import { Slot } from "radix-ui";

const buttonStyles = cva(
  "inline-flex shrink-0 items-center justify-center gap-2.5 rounded-full text-sm leading-none font-medium whitespace-nowrap select-none transition-[color,background-color,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:outline-destructive [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/75",
        destructive:
          "bg-destructive text-primary-foreground hover:bg-destructive/85 active:bg-destructive/75",
        outline:
          "border border-border bg-card text-card-foreground hover:border-primary/25 hover:bg-secondary active:bg-secondary/80",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent/80",
        ghost: "text-foreground hover:bg-secondary active:bg-accent",
        link: "text-primary underline-offset-4 hover:underline active:text-muted-foreground",
      },
      size: {
        default: "h-11 px-5",
        xs: "h-8 gap-1.5 px-3 text-xs [&_svg]:size-3",
        sm: "h-10 gap-2 px-4",
        lg: "h-12 px-6 text-[15px]",
        icon: "size-11 rounded-xl",
        "icon-xs": "size-8 rounded-lg [&_svg]:size-3",
        "icon-sm": "size-10 rounded-xl",
        "icon-lg": "size-12 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function buttonVariants(options: VariantProps<typeof buttonStyles> & { className?: string } = {}) {
  const { className, ...variants } = options;
  return cn(buttonStyles(variants), className);
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
