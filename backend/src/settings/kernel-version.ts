/**
 * **Which Linux kernel a host really runs, and whether MongoDB 8 starts on it**
 * (#104).
 *
 * MongoDB 8's official images (`mongo:8`, `mongo:8.0.x`, `mongo:latest`) exit 1
 * at start on kernels 6.19.0 through 7.0.13 with "MongoDB cannot start: Linux
 * kernel versions 6.19.0 through 7.0.13 have a known incompatibility with this
 * version of MongoDB" (SERVER-121912). Swarm restarts the task forever while the
 * Deployment reads done, so the console has to say it before anyone deploys.
 *
 * **Why `/proc/version_signature` first.** Ubuntu's kernel release hides the
 * upstream version: every Ubuntu 26.04 7.0 kernel is `uname -r` =
 * `7.0.0-<abi>-generic`, the affected `7.0.0-30` and the fixed `7.0.0-43` alike.
 * Ubuntu writes the upstream base as the **last field** of
 * `/proc/version_signature` (`Ubuntu 7.0.0-30.30-generic 7.0.12`), measured
 * live on 2026-11-17. Other distributions have no such file, and there
 * `uname -r`'s leading `X.Y.Z` is the upstream version.
 *
 * Rejected: deciding on `uname -r` alone, which reads `7.0.0` on every Ubuntu
 * 7.0 kernel and would warn on a host that is already fixed; and overriding
 * `GLIBC_TUNABLES` in the image so it starts anyway, which MongoDB says has
 * critical performance implications, for a fault a kernel update removes.
 */

/** An upstream kernel version, `major.minor.patch`. */
export interface KernelVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * The upstream kernel version a host's answer names, or null when it names
 * none. `answer` is `/proc/version_signature` where the host has one, and
 * `uname -r` (or `uname -sr`) otherwise: the probe sends whichever it read.
 */
export function upstreamKernelVersion(answer: string): KernelVersion | null {
  const text = answer.trim();
  if (!text) return null;
  // Ubuntu's signature: `Ubuntu <release> <upstream>`. The last field is the
  // upstream version; the release beside it is the one that hides it, so a
  // signature cut short of its third field names nothing rather than that.
  const fields = text.split(/\s+/);
  const candidate = text.startsWith('Ubuntu ')
    ? fields.length >= 3
      ? fields[fields.length - 1]
      : undefined
    : // `uname -sr` puts the kernel name first; `uname -r` is the release alone.
      fields[fields[0] === 'Linux' ? 1 : 0];
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?![\d.])/.exec(candidate ?? '');
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

/** `7.0.12`, the way MongoDB's refusal and kernel.org write a version. */
export function kernelVersionText(version: KernelVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** The first kernel MongoDB 8 refuses, and the last. Both inclusive. */
const FIRST_REFUSED: KernelVersion = { major: 6, minor: 19, patch: 0 };
const LAST_REFUSED: KernelVersion = { major: 7, minor: 0, patch: 13 };

/** Whether MongoDB 8 refuses to start on this kernel: 6.19.0 to 7.0.13. */
export function mongoRefusesKernel(version: KernelVersion): boolean {
  return (
    compare(version, FIRST_REFUSED) >= 0 && compare(version, LAST_REFUSED) <= 0
  );
}

function compare(a: KernelVersion, b: KernelVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
