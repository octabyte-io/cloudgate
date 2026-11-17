import { useRuntimeInfo } from "@/lib/api/use-runtime-info";
import { cn } from "@/lib/utils";

/**
 * **MongoDB 8 will not start on a kernel from 6.19.0 to 7.0.13** (#104), and
 * what the console says about it, wherever it says it.
 *
 * The official `mongo:8` images exit 1 at start on those kernels ("MongoDB
 * cannot start: Linux kernel versions 6.19.0 through 7.0.13 have a known
 * incompatibility", SERVER-121912). Swarm restarts the task forever and the
 * deploy reads done, so the only useful moment to say it is before: on the
 * host's own readings, and where a MongoDB 8 is about to be put on it.
 *
 * **Two rules, each written once.** Which kernels are refused is the
 * backend's (`kernel-version.ts`), read as `RuntimeInfo.mongoRefusesKernel`,
 * because Ubuntu hides the upstream version and only the probe can read it.
 * Which images are MongoDB 8 is here (`isMongo8Image`), because the database
 * create form asks it of a field still being typed, and the Template setup of
 * the images its parts run.
 *
 * Never a refusal: a kernel can be updated after, and `mongo:7` starts on it.
 * Rejected: overriding `GLIBC_TUNABLES` so the image starts anyway, which
 * MongoDB says costs critical performance, for a fault a kernel update fixes.
 *
 * Shared by four features (the Server's Infrastructure tab, Settings ›
 * Instance, the database create form and Overview, and the Template setup),
 * so it lives here rather than in any one of them (§1.4).
 */

/**
 * Whether an image reference runs MongoDB 8: the official `mongo` image,
 * through any registry, tagged `8`, `8.x`, `8-<variant>`, or untagged or
 * `latest` (which is 8 today; if it moves to a 9 the sentence below is still
 * the right question to ask, and this is where to narrow it).
 */
export function isMongo8Image(image: string): boolean {
  const named = image.trim().split("@")[0];
  const lastPart = named.slice(named.lastIndexOf("/") + 1);
  const colon = lastPart.indexOf(":");
  const repository = colon === -1 ? lastPart : lastPart.slice(0, colon);
  if (repository !== "mongo") return false;
  const tag = colon === -1 ? "latest" : lastPart.slice(colon + 1);
  return tag === "latest" || /^8(?:$|[.-])/.test(tag);
}

/**
 * The kernel MongoDB 8 refuses on a host, `7.0.12`, or null: it starts
 * there, the kernel was not read, or `enabled` is false and nothing was
 * asked. A refusal of the read itself (a member's 403) is null as well: the
 * warning is a courtesy, and its absence claims nothing.
 */
export function useMongoRefusedKernel(
  serverId: string | null | undefined,
  enabled = true,
): string | null {
  const runtime = useRuntimeInfo(serverId ?? null, {
    enabled: enabled && serverId !== undefined,
  });
  if (!enabled || serverId === undefined) return null;
  return runtime.data?.mongoRefusesKernel
    ? (runtime.data.kernel.observed ?? null)
    : null;
}

/** What updates an Ubuntu host's kernel; the reboot is what boots it. */
const UBUNTU_UPDATE = "sudo apt update && sudo apt full-upgrade";

/**
 * The sentence, inline: what will not start, on which kernel, and the fix.
 * `host` names the machine as the screen does ("this Server", "the platform
 * host"); the Infrastructure finding passes none, since its row is the host.
 */
export function MongoKernelText({
  kernel,
  host,
}: {
  kernel: string;
  host?: string;
}) {
  return (
    <>
      MongoDB 8 will not start on {host ? `${host}'s` : "this"} kernel,
      Linux {kernel}: kernels 6.19 to 7.0.13 have a known incompatibility.
      Update the kernel and reboot: on Ubuntu, <code className="font-mono">
        {UBUNTU_UPDATE}
      </code>, then <code className="font-mono">sudo reboot</code>.
    </>
  );
}

/**
 * The sentence as a note, in the console's warning box, for a form or a
 * card that has no finding row to put it in. `children` follows the
 * sentence: the database form's "or pick `mongo:7`".
 */
export function MongoKernelNote({
  kernel,
  host,
  className,
  children,
}: {
  kernel: string;
  host?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <p
      role="note"
      className={cn(
        "rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta wrap-anywhere text-tx-2",
        className,
      )}
    >
      <MongoKernelText kernel={kernel} host={host} />
      {children ? <> {children}</> : null}
    </p>
  );
}
