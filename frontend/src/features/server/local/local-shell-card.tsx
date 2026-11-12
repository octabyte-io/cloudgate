import { useState } from "react";

import { Card } from "@/components/console/card";
import { Field } from "@/components/console/field";
import { Terminal } from "@/components/console/terminal";
import { useDock, useTerminalOffers } from "@/components/shell/dock-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInfrastructureHealth } from "@/features/settings/platform/use-platform";
import { Icon } from "@/lib/design/icons";

import { hostShellOffers } from "../shell-offers";

import {
  DEFAULT_LOCAL_SHELL,
  checkLocalShell,
  localShellAddress,
  type LocalShellSession,
} from "./local-shell-values";

/**
 * A shell on the machine Cloudgate runs on.
 *
 * **This is the only way into `serverId=local` from the console.** The gateway
 * has always had the target, and
 * resolves the right address for it, but nothing in this app ever asked for it:
 * the Terminal tab belongs to a Server row, and this host does not have one. It
 * belongs on the fleet screen because that is where the machines are, and
 * because the platform host *is* one of them — a service created without a
 * Server runs here (`connection-card.tsx` says the same thing from the database
 * end).
 *
 * **The session is opened from a form rather than a button, and asked for once.**
 * The two fields are what the gateway cannot look up for this target
 * the reasoning
 * for asking at all, and for prefilling them, is in `local-shell-values.ts`.
 * Changing either ends the session and starts a new one — the `key` below — so a
 * frame never holds one user's scrollback under another user's name.
 *
 * Nothing here reports the state of the connection. The terminal does that
 * itself, and it has
 * something true to report: the gateway closes with a code and a reason
 * when the SSH channel fails, so a shell that cannot carry a byte stops claiming
 * it is running and says what happened instead. That sentence was a description
 * of the badge and a lie about the footer until
 * The line beside
 * the *Change the user or port* button opened "Signed in over SSH as…" whenever
 * `session` was set, which is a claim about the socket made from the one place
 * in this card that never sees it. It reports the request now, and points at the
 * terminal for the answer.
 *
 * **The copy says who this is for; it is not a gate.** Only an owner or admin
 * may open a shell on the platform host, and the gateway is what enforces that
 * (ADR-0010) — it closes the socket 4403 with its reason, which
 * `socket-stream-store.ts` already renders as a refusal. Hiding the form behind
 * a role read in the browser would be a claim about authority made where the
 * caller controls the answer, so the sentence is here and the decision is not.
 */
export function LocalShellCard() {
  const [draft, setDraft] = useState(DEFAULT_LOCAL_SHELL);
  const [errors, setErrors] = useState<{ username?: string; port?: string }>(
    {},
  );
  const [session, setSession] = useState<LocalShellSession | null>(null);
  const dock = useDock();
  // Under the Dock's `+`: this host as the fields ask for it — the
  // session this card opened, or the one the form would open now.
  const offered = session ?? checkLocalShell(draft).session ?? null;
  const offer = dock ? <OfferHostShell session={offered} /> : null;

  function open(event: React.SubmitEvent) {
    event.preventDefault();
    const checked = checkLocalShell(draft);
    setErrors(checked.errors);
    if (checked.session) setSession(checked.session);
  }

  if (session) {
    return (
      <>
        {offer}
        <Terminal
          // Not the target's own key, which is `server:local` for every session
          // this card opens: a change of user or port has to tear the emulator
          // down, not re-point a live one.
          key={`${session.username}:${session.port}`}
          target={{
            kind: "server",
            serverId: "local",
            name: "This host",
            address: localShellAddress(session),
          }}
          footer={
            <>
              You are <code className="font-mono">{session.username}</code>{" "}
              on
              the machine Cloudgate itself runs on. Stopping something here
              stops it for the platform, and nothing you run is in
              Cloudgate&rsquo;s record of the host.
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          {/* This line says what the session was *asked for*, not what came
              back. It used to open "Signed in over SSH as root…", which
              is a claim about the connection made by the one part of this card
              that cannot see one: the socket lives in `terminal-session.tsx`,
              and it rendered under a terminal reading "The Server refused this
              session: ssh: All configured authentication methods failed" and
              under "This session has ended". (That first sentence is history:
              it said "the Server" on a card headed "This host", and it called a
              key the far end would not accept a refusal — both fixed since,
              which is why grepping the tree for it now finds only this comment.)
              Lifting the socket's state up
              here was the alternative and it is the wrong one — it would
              duplicate the authority the docstring above deliberately leaves
              with the terminal. So the sentence stops claiming a connection
              and names where the answer is instead. */}
          <p className="min-w-0 flex-1 text-meta text-tx-2">
            This session asked for{" "}
            <code className="font-mono">{session.username}</code> on port{" "}
            <code className="font-mono">{session.port}</code>, with the key
            Cloudgate generated for itself. Whether the host accepted it is what
            the terminal above says.
          </p>
          <Button size="sm" onClick={() => setSession(null)}>
            Change the user or port
          </Button>
        </div>
      </>
    );
  }

  return (
    <Card>
      {offer}
      <Card.Header
        title="This host"
        sub="The machine Cloudgate itself runs on. It has no Server row, and a service deployed without a Server runs here."
        headingLevel={2}
      />
      <Card.Body>
        {/* There is no Server row to read a port and a user from, and the
            gateway refuses rather than guessing. It also asks who you are
            before it dials, since every Organization on the instance runs
            here — so the form is shown to everybody rather than pretending a
            hidden button is a lock. */}
        <p className="text-body text-tx-2">
          Name the user to sign in as, and Cloudgate opens a shell on its own
          host over SSH with a key it generates for itself. Only an owner or an
          admin can open it.
        </p>

        {/* Two rows, and the fields start at the same top rather than ending at
            the same bottom.

            `items-end` on one row of three is right only while every item has
            the same internal stack, and the first field here carries a hint. It
            aligned the *bottom* of that hint with the port field, so at 380px
            "SSH port" rendered level with "The user whose authorized_keys holds
            Cloudgate's key." and its input sat below both. `items-start` is
            what makes the two labels and the two inputs line up instead —
            both labels are one line, so equal tops mean equal input offsets
            however far the hint runs. The submit button leaves the row for the
            same reason, since bottom-aligning it against the hint is the same
            defect one item over; `manage-keys-modal.tsx` is the same shape.

            `max-w-64` is the fix's other half: unbounded, `flex-[1_1_…]` grew the
            user field to ~470px beside a 112px port field, which is a lot of
            track for a word like `root`. The `150px` basis is the part the fix put
            out of scope by name ("leave the basis alone") and is the tree's
            spelling for this class at seventeen other sites, two of them the
            same number. It decides where the row wraps, not how wide the field
            ends up — the cap is what answers the width, so there is nothing for
            the basis to buy here. */}
        <form
          method="post"
          noValidate
          onSubmit={open}
          className="mt-3 grid gap-3"
        >
          <div className="flex flex-wrap items-start gap-3">
            <Field
              name="username"
              label="SSH user"
              hint="The user whose authorized_keys holds Cloudgate's key."
              error={errors.username}
              className="min-w-0 max-w-64 flex-[1_1_150px]"
            >
              <Input
                value={draft.username}
                onChange={(event) =>
                  setDraft((was) => ({ ...was, username: event.target.value }))
                }
                autoComplete="off"
                className="font-mono"
              />
            </Field>
            <Field
              name="port"
              label="SSH port"
              error={errors.port}
              className="w-28"
            >
              <Input
                value={draft.port}
                onChange={(event) =>
                  setDraft((was) => ({ ...was, port: event.target.value }))
                }
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
              />
            </Field>
          </div>
          <Button type="submit" variant="pri" className="justify-self-start">
            <Icon name="term" size={15} />
            Open a shell
          </Button>
        </form>

        <p className="mt-3 text-meta text-tx-2">
          The first attempt fails until that user&rsquo;s{" "}
          <code className="font-mono">authorized_keys</code> holds the key; the
          terminal then prints the command to run on this host.
        </p>
      </Card.Body>
    </Card>
  );
}

/**
 * Offers this host under the Dock's `+`, to a caller with instance authority
 * only, and only once that is shown (`hostShellOffers`). Drawn only inside the
 * console shell, so the read is not made where no Dock can use it.
 */
function OfferHostShell({ session }: { session: LocalShellSession | null }) {
  const authority = useInfrastructureHealth();
  useTerminalOffers(hostShellOffers(authority, session));
  return null;
}
