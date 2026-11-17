import { Banner, BannerRow } from "@/components/console/banner";
import {
  MongoKernelText,
  isMongo8Image,
  useMongoRefusedKernel,
} from "@/components/console/mongo-kernel";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";

/**
 * Why a deployed MongoDB 8 never comes up on its host (#104), on its
 * Overview above the container output that shows it restarting.
 *
 * A database's deploy converges the Swarm service and reads done whether
 * or not the engine starts, so a `mongo:8` on a kernel from 6.19 to 7.0.13
 * restarts forever with nothing on the status to say so. This reads the
 * host's kernel only for a MongoDB 8 row, and says nothing otherwise.
 */
export function MongoKernelBanner({
  database,
  kind,
}: {
  database: Pick<Database, "serverId" | "dockerImage">;
  kind: DatabaseKind;
}) {
  const kernel = useMongoRefusedKernel(
    database.serverId,
    kind === "mongo" && isMongo8Image(database.dockerImage),
  );
  if (!kernel) return null;
  return (
    <Banner
      icon="alert"
      title="This MongoDB will not start on its host."
      className="animate-rise border-warn-line"
    >
      <BannerRow
        tone="warn"
        title="Swarm restarts it until the host's kernel is updated."
        description={
          <MongoKernelText
            kernel={kernel}
            host={
              database.serverId === null ? "this Cloudgate host" : "its Server"
            }
          />
        }
      />
    </Banner>
  );
}
