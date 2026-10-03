import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { AuthWorkspaceShell } from "@/components/auth-workspace-shell";
import { getServerSession, toClientPrincipal } from "@/lib/auth/server-api";
import { getSafeReturnTo } from "@/lib/auth/return-to";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const principal = await getServerSession();

  if (!principal) {
    const requestedPath = (await headers()).get("x-mandatepay-internal-pathname");
    redirect(`/signin?returnTo=${encodeURIComponent(getSafeReturnTo(requestedPath))}`);
  }

  return (
    <AuthWorkspaceShell principal={toClientPrincipal(principal)}>{children}</AuthWorkspaceShell>
  );
}
