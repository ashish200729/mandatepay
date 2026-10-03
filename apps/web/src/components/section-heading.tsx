import { cn } from "@mandatepay/ui/lib/utils";

export function SectionHeading({
  id,
  children,
  className,
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "font-editorial text-[34px] leading-[1.18] font-normal tracking-[-0.03em] text-balance sm:text-[44px] lg:text-[48px]",
        className,
      )}
    >
      {children}
    </h2>
  );
}
