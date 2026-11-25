import Link from "next/link";

import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { cn } from "@/lib/utils";

/**
 * **The Same-machine warning** (`CONTEXT.md`, spec #146): a Service put on
 * the machine Cloudgate itself runs on is lost with Cloudgate's own records
 * if that machine is lost, so the console says so wherever one is put there.
 *
 * Never a refusal, and it cannot be hidden, as `MongoKernelNote` beside it:
 * the platform host is a normal place for a Self-hosted instance's Services
 * (ADR-0053's Self-hosted rule). It points to adding a Server, or to the
 * Hosted instance.
 *
 * **Self-hosted only, failing closed** like `useCreateServerPicker`: until
 * the mode has loaded, or on the Hosted instance (which refuses the place
 * outright, ADR-0053), it renders nothing.
 *
 * Shared by every create form's Server picker, Template setup, the AI
 * deploy draft, Get started and the Environment's Deploy target, so it lives
 * here rather than in any one feature (§1.4).
 */

/** The Hosted instance's address, which the note offers in a new tab. */
export const CLOUDGATE_HOSTED_URL = "https://cloudgate.octabyte.app";

const LINK =
  "font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline";

export function SameMachineNote({ className }: { className?: string }) {
  const selfHosted = useInstanceMode().data === "self-hosted";
  if (!selfHosted) return null;
  return (
    <p
      role="note"
      className={cn(
        "rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta wrap-anywhere text-tx-2",
        className,
      )}
    >
      Cloudgate itself runs on this machine. If the machine is lost, this
      Service and all of Cloudgate&apos;s records go with it: Projects,
      Servers, settings and Deployment history.{" "}
      <Link href="/servers" className={LINK}>
        Add a Server
      </Link>{" "}
      or use{" "}
      <a
        href={CLOUDGATE_HOSTED_URL}
        target="_blank"
        rel="noreferrer"
        className={LINK}
      >
        Cloudgate Hosted
      </a>{" "}
      to keep them apart.
    </p>
  );
}
