"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mandatepay/ui/components/button";
import {
  DangerConfirmDialog,
  ReasonDialog,
  type ActionConfirmation,
} from "@/components/admin/action-dialogs";
import { postAdminControl } from "@/lib/admin-action";
import { parseAdminMe } from "@/lib/session";
import {
  requireAdminReason,
  type AdminEntityCapability,
  type AdminMandate,
  type AdminProposal,
  type AdminUser,
} from "@mandatepay/shared";

function allowed(capabilities: AdminEntityCapability[], action: AdminEntityCapability["action"]) {
  return capabilities.find((item) => item.action === action)?.allowed === true;
}
function blockedReason(
  capabilities: AdminEntityCapability[],
  action: AdminEntityCapability["action"],
) {
  return (
    capabilities.find((item) => item.action === action)?.reason ?? "This action is unavailable."
  );
}

async function freshAuthUntil() {
  const response = await fetch("/api/admin/me", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const admin = parseAdminMe(await response.json().catch(() => null));
  return admin?.session.freshAuthUntil;
}

export function UserControls({ user }: { user: AdminUser }) {
  const router = useRouter();
  const [disableOpen, setDisableOpen] = useState(false);
  const [enableOpen, setEnableOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [autonomyOpen, setAutonomyOpen] = useState(false);
  const [fresh, setFresh] = useState<string>();
  const intent = `${user.id}:${user.updatedAt}:${user.accessVersion}`;
  async function ensureFresh() {
    setFresh(await freshAuthUntil());
  }
  async function run(path: string, extra: Record<string, unknown>, input: ActionConfirmation) {
    const result = await postAdminControl(`users/${encodeURIComponent(user.id)}/${path}`, {
      reason: input.reason,
      confirmation: true,
      requestKey: input.requestKey,
      expectedUpdatedAt: user.updatedAt,
      expectedAccessVersion: user.accessVersion,
      ...extra,
      ...(input.confirmation ? { typedConfirmation: input.confirmation } : {}),
    });
    router.refresh();
    return result;
  }
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Account controls</h2>
      <p className="text-sm text-muted-foreground">
        These actions change MandatePay access only. They cannot rewrite PayPal, AgentGuard, or
        payment records.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!allowed(user.capabilities, "users:disable-autonomy")}
          onClick={() => setAutonomyOpen(true)}
        >
          Disable autonomy
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void ensureFresh().then(() => setRevokeOpen(true));
          }}
        >
          Revoke sessions
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!allowed(user.capabilities, "users:enable")}
          onClick={() => setEnableOpen(true)}
        >
          Enable account
        </Button>
        <Button
          type="button"
          disabled={!allowed(user.capabilities, "users:disable")}
          onClick={() => {
            void ensureFresh().then(() => setDisableOpen(true));
          }}
        >
          Disable account
        </Button>
      </div>
      {!allowed(user.capabilities, "users:disable") && (
        <p className="text-sm text-muted-foreground">
          {blockedReason(user.capabilities, "users:disable")}
        </p>
      )}
      <ReasonDialog
        open={autonomyOpen}
        onOpenChange={setAutonomyOpen}
        title="Disable autonomous purchasing"
        description="Turn off automatic purchasing for this user. This never enables spending."
        target={{ id: user.id, label: user.email }}
        actionLabel="Disable autonomy"
        intentKey={`autonomy:${intent}`}
        onConfirm={(input) => run("disable-autonomy", {}, input)}
      />
      <DangerConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Revoke all sessions"
        description="End every live session for this user. They will need to sign in again."
        target={{ id: user.id, label: user.email }}
        actionLabel="Revoke sessions"
        intentKey={`sessions:${intent}`}
        freshAuthUntil={fresh}
        onConfirm={(input) => {
          void ensureFresh();
          return run("revoke-sessions", {}, input);
        }}
      />
      <ReasonDialog
        open={enableOpen}
        onOpenChange={setEnableOpen}
        title="Enable account"
        description="Restore sign-in and API access for this user. Existing sessions stay revoked."
        target={{ id: user.id, label: user.email }}
        actionLabel="Enable account"
        intentKey={`enable:${intent}`}
        onConfirm={(input) => run("enable", {}, input)}
      />
      <DangerConfirmDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="Disable account"
        description="Block sign-in and API access, and revoke all sessions. The administrator account cannot be disabled."
        target={{ id: user.id, label: user.email }}
        actionLabel="Disable account"
        intentKey={`disable:${intent}`}
        freshAuthUntil={fresh}
        onConfirm={(input) => run("disable", {}, input)}
      />
    </section>
  );
}

export function UserNotes({
  userId,
  notes,
}: {
  userId: string;
  notes: readonly { id: string; body: string; authorName: string | null; createdAt: string }[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const latestNoteId = notes[0]?.id;
  const requestKey = useMemo(() => crypto.randomUUID(), [latestNoteId]);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Admin notes</h2>
      <ul className="space-y-2 text-sm">
        {notes.map((note) => (
          <li key={note.id} className="rounded-xl border bg-card p-4">
            <p className="whitespace-pre-wrap">{note.body}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {note.authorName ?? "Administrator"} · {note.createdAt}
            </p>
          </li>
        ))}
        {!notes.length && <li>No admin notes yet.</li>}
      </ul>
      <form
        className="space-y-3 rounded-2xl border p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setError(null);
          try {
            const safeReason = requireAdminReason(reason);
            await postAdminControl(`users/${encodeURIComponent(userId)}/notes`, {
              reason: safeReason,
              requestKey,
              body: body.trim(),
            });
            setBody("");
            setReason("");
            router.refresh();
          } catch (failure) {
            setError(
              failure instanceof Error && failure.message
                ? "Provide a reason and note without credential material."
                : "The note could not be saved. Check the current state before retrying.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <label className="block text-sm">
          Reason
          <input
            className="mt-2 w-full rounded-xl border bg-background p-3"
            maxLength={255}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          Note
          <textarea
            className="mt-2 min-h-24 w-full rounded-xl border bg-background p-3"
            maxLength={2000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending || !body.trim() || !reason.trim()}>
          {pending ? "Saving…" : "Add note"}
        </Button>
      </form>
    </section>
  );
}

export function MandateControls({ mandate }: { mandate: AdminMandate }) {
  const router = useRouter();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [fresh, setFresh] = useState<string>();
  const intent = `${mandate.id}:${mandate.version}:${mandate.status}`;
  async function run(path: "pause" | "revoke", input: ActionConfirmation) {
    const result = await postAdminControl(`mandates/${encodeURIComponent(mandate.id)}/${path}`, {
      reason: input.reason,
      confirmation: true,
      requestKey: input.requestKey,
      expectedVersion: mandate.version,
      expectedStatus: mandate.status,
      typedConfirmation: input.confirmation,
    });
    router.refresh();
    return result;
  }
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Mandate controls</h2>
      <p className="text-sm text-muted-foreground">
        Pause and revoke use the existing mandate state machine. Permissions and limits are not
        edited. A paused mandate can still be resumed by the owner unless the account is disabled.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!allowed(mandate.capabilities, "mandates:pause")}
          onClick={() => {
            void freshAuthUntil().then((value) => {
              setFresh(value);
              setPauseOpen(true);
            });
          }}
        >
          Pause mandate
        </Button>
        <Button
          type="button"
          disabled={!allowed(mandate.capabilities, "mandates:revoke")}
          onClick={() => {
            void freshAuthUntil().then((value) => {
              setFresh(value);
              setRevokeOpen(true);
            });
          }}
        >
          Revoke mandate
        </Button>
      </div>
      <DangerConfirmDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title="Pause mandate"
        description="Pause this mandate through the existing lifecycle service. No permission fields are changed."
        target={{ id: mandate.id, label: mandate.title }}
        actionLabel="Pause mandate"
        intentKey={`pause:${intent}`}
        freshAuthUntil={fresh}
        onConfirm={(input) => run("pause", input)}
      />
      <DangerConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Revoke mandate"
        description="Revoke this mandate through the existing lifecycle service. This is terminal and does not edit permissions."
        target={{ id: mandate.id, label: mandate.title }}
        actionLabel="Revoke mandate"
        intentKey={`revoke:${intent}`}
        freshAuthUntil={fresh}
        onConfirm={(input) => run("revoke", input)}
      />
    </section>
  );
}

export function ProposalControls({ proposal }: { proposal: AdminProposal }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Proposal controls</h2>
      <p className="text-sm text-muted-foreground">
        Re-evaluation calls AgentGuard only. BLOCKED and terminal proposals cannot be forced to
        ALLOW.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={!allowed(proposal.capabilities, "proposals:re-evaluate")}
        onClick={() => setOpen(true)}
      >
        Re-evaluate with AgentGuard
      </Button>
      {!allowed(proposal.capabilities, "proposals:re-evaluate") && (
        <p className="text-sm text-muted-foreground">
          {blockedReason(proposal.capabilities, "proposals:re-evaluate")}
        </p>
      )}
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title="Re-evaluate proposal"
        description="Run the current AgentGuard evaluation. This cannot override a hard block or rewrite provider state."
        target={{ id: proposal.id, label: proposal.product.title }}
        actionLabel="Re-evaluate"
        intentKey={`reeval:${proposal.id}:${proposal.status}:${proposal.updatedAt}`}
        onConfirm={async (input) => {
          const result = await postAdminControl(
            `proposals/${encodeURIComponent(proposal.id)}/re-evaluate`,
            {
              reason: input.reason,
              confirmation: true,
              requestKey: input.requestKey,
              expectedStatus: proposal.status,
              expectedUpdatedAt: proposal.updatedAt,
            },
          );
          router.refresh();
          return result;
        }}
      />
    </section>
  );
}
