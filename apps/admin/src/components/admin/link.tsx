import NextLink from "next/link";
import type { ComponentProps } from "react";

/** Protected operational pages are read on navigation, never speculatively fetched. */
export function AdminLink(props: Omit<ComponentProps<typeof NextLink>, "prefetch">) {
  return <NextLink {...props} prefetch={false} />;
}
