import { DangerZone } from "@/components/console/danger-zone";
import { settingsApi } from "@/lib/api/endpoints/settings";
import { useInvalidate } from "@/lib/api/use-invalidate";

import { useInstanceGate } from "./use-platform";

/**
 * The two prunes that take images a rollback point may still need.
 *
 * They are here and the five ordinary cleanups are not, which is the distinction
 * the phase brief asks for by name: pruning dangling images is a Tuesday-afternoon
 * action, and `docker system prune --all` takes every image not backing a running
 * container. Putting them in one list would say they were the same kind of thing.
 *
 * Both are off, with the backend's sentence, for a caller without instance
 * authority (ADR-0013) — `DangerZone`'s `unavailable` is the one way a
 * row here says it cannot run.
 */
export function MaintenanceDangerZone() {
  const invalidate = useInvalidate();
  const gate = useInstanceGate();
  const unavailable = gate.allowed ? undefined : gate.refusal;
  const after = async (run: () => Promise<unknown>) => {
    await run();
    await invalidate.instanceSettings();
  };

  return (
    <DangerZone
      sub="Both of these take images a rollback point may still need."
      actions={[
        {
          id: "docker-prune",
          title: "Prune everything unused",
          description:
            "docker system prune --all, then a builder prune. Every image, network and container not backing something that is running right now.",
          button: "Prune everything",
          unavailable,
          consequences: (
            <>
              <p>
                Runs{" "}
                <code className="font-mono">
                  docker system prune --all --force
                </code>{" "}
                and then{" "}
                <code className="font-mono">
                  docker builder prune --all --force
                </code>
                . That takes <strong className="font-medium">every image</strong>{" "}
                not backing a running container — not just dangling ones — plus
                every stopped container, every unused network and the whole build
                cache.
              </p>
              <p className="mt-2">
                A rollback point is an image tag. Any rollback whose image is not
                currently running becomes unusable, and the Rollbacks tab will
                show it as such rather than warning you first. Volumes are the
                one thing this does not touch.
              </p>
            </>
          ),
          run: () => after(() => settingsApi.cleanup("docker-prune")),
          done: "The prune is running.",
        },
        {
          id: "cleanup-all",
          title: "Run every cleanup at once",
          description:
            "Containers, images, builders and a system prune, started in the background. Volumes are excluded.",
          button: "Run every cleanup",
          unavailable,
          consequences: (
            <>
              <p>
                Starts four prunes at once —{" "}
                <code className="font-mono">container</code>,{" "}
                <code className="font-mono">image --all</code>,{" "}
                <code className="font-mono">builder --all</code> and{" "}
                <code className="font-mono">system --all</code> — with the same
                consequence for rollback images as pruning everything, above.
              </p>
              <p className="mt-2">
                It runs{" "}
                <strong className="font-medium">in the background</strong> and
                answers immediately, so a success here means it started. Failures
                are logged on the server and are not reported back to this screen
                at all.
              </p>
            </>
          ),
          run: () => after(() => settingsApi.cleanup("all")),
          done: "Every cleanup has been started in the background.",
        },
      ]}
    />
  );
}
