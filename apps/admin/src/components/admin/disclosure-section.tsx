import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function DisclosureSection({
  title,
  children,
  open = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
  className?: string;
}) {
  return (
    <details open={open} className={`group border-t ${className}`}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="pb-6 pt-2">{children}</div>
    </details>
  );
}
