import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { server } from '../../servers/server.schema';
import { BaseDatabaseService } from '../common/database-service';
import type { CreateMongoDto } from './dto/mongo.dto';
import { mongo } from './mongo.schema';
import type { Mongo } from './mongo.schema';

type MongoNested = Mongo & {
  environment: typeof environment.$inferSelect & {
    project: typeof project.$inferSelect;
  };
  server: typeof server.$inferSelect | null;
};

/**
 * The names the replica-set startup script reads the root credentials out of,
 * invented here so neither becomes a word of the container's argv.
 *
 * `CG_`-prefixed on `builders/build-env.ts`' precedent, and — unlike a build's
 * holders — reserved against the operator's own `env` by
 * `common/reserved-env.ts` rather than merely unlikely to be chosen.
 *
 * The username is a holder too, and not only for symmetry: `databaseUser` is a
 * bare `z.string().min(1)` on `createMongoSchema` and `updateMongoSchema`, and
 * it used to be interpolated into a JS string literal *inside* a single-quoted
 * `mongosh --eval '…'` word — so a username carrying `'` broke the script out
 * of its own quoting and a username carrying `"` broke the JSON. Reading both
 * out of the environment removes the interpolation rather than escaping it.
 */
const ROOT_USERNAME_HOLDER = 'CG_MONGO_ROOT_USERNAME';
const ROOT_PASSWORD_HOLDER = 'CG_MONGO_ROOT_PASSWORD';

/** MongoDB: a thin engine spec over the shared database base. */
@Injectable()
export class MongoService extends BaseDatabaseService<Mongo, MongoNested> {
  protected readonly engineLabel = 'MongoDB';
  protected readonly appNamePrefix = 'mongo';
  protected readonly serviceType = 'mongo' as const;
  protected readonly targetPort = 27017;
  protected readonly table = mongo;
  protected readonly columns = {
    id: mongo.mongoId,
    appName: mongo.appName,
    environmentId: mongo.environmentId,
    serverId: mongo.serverId,
    applicationStatus: mongo.applicationStatus,
  };

  create(ctx: PermissionCtx, data: CreateMongoDto) {
    return this.createDatabase(ctx, { ...data });
  }

  protected idOf(row: Mongo): string {
    return row.mongoId;
  }

  protected queryById(mongoId: string) {
    return this.db.query.mongo.findFirst({
      where: eq(mongo.mongoId, mongoId),
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
  }

  /**
   * The root user owns the server, so there is no database name to announce.
   *
   * `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` are the
   * operator's: on a non-replica-set row the image's own `docker-entrypoint.sh`
   * reads them, and on either they are what an application in the same network
   * reads to build a connection string. The two holders are this file's, and
   * only the replica-set branch emits them, because
   * {@link MongoService.replicaSetStartupScript} is their only reader.
   *
   * **Holders rather than the `MONGO_INITDB_*` pair the ticket suggested
   * reusing, for {@link RedisService.defaultEnv}' reason and it applies here
   * word for word.** `BaseDatabaseService.deployInternal` concatenated this
   * string and *then* the row's own `env`, and dotenv's parse let the later
   * assignment win — so a script reading `MONGO_INITDB_ROOT_PASSWORD` would let
   * an operator who sets that name create the root user with a password
   * `mongo.databasePassword` does not hold, which is exactly the defect
   * `CG_REDIS_REQUIREPASS` was invented to avoid. Under the holders that collision
   * is refused at the write instead (`common/reserved-env.ts`), and reusing the
   * operator's own name would have put the value back outside that rule's
   * reach.
   *
   * Two names for one value in one `Env` array is not a second audience: this
   * spec's `Env` held the password before and holds it after, and anything
   * that can read one name can read the other.
   *
   * **`MONGO_INITDB_DATABASE=admin` is gone, and it never did anything.**
   * It was emitted on the `replicaSets` branch only — which is the
   * one branch where {@link MongoService.containerCommand} replaces
   * `ContainerSpec.Command`, so the image's `docker-entrypoint.sh` never runs
   * and the only thing that reads that variable is never started. The
   * replica-set script names the database itself, in the one place it needs to:
   * `getSiblingDB("admin")`. The reason to drop it is that the docblock here
   * claimed replica-set mode *"additionally seeds the admin database"* on its
   * strength, which was not true of this variable — an inert line that a reader
   * has to disprove costs more than a missing one, and keeping it with a
   * comment saying so would have left `ENGINE_ENV_OWNERS` either carrying a
   * name derived from no column or silently skipping a name this method emits.
   *
   * Pairs rather than a dotenv body, for
   * {@link PostgresService.defaultEnv}' reason: `databaseUser` has no charset,
   * and it already had to come out of the *script* for the same reason it
   * comes out of the dotenv body here.
   */
  protected defaultEnv(row: MongoNested): Record<string, string> {
    return {
      MONGO_INITDB_ROOT_USERNAME: row.databaseUser,
      MONGO_INITDB_ROOT_PASSWORD: row.databasePassword,
      ...(row.replicaSets
        ? {
            [ROOT_USERNAME_HOLDER]: row.databaseUser,
            [ROOT_PASSWORD_HOLDER]: row.databasePassword,
          }
        : {}),
    };
  }

  protected mountPath(): string {
    return '/data/db';
  }

  /** With replicaSets on, the stock image can't bootstrap a replica set, so
   * the entrypoint becomes a script that starts mongod with --replSet,
   * initiates rs0 against the service's own DNS name, and creates the root
   * user once the node is primary. */
  protected containerCommand(row: MongoNested) {
    if (!row.replicaSets) return undefined;
    return {
      Command: ['/bin/bash'],
      Args: ['-c', this.replicaSetStartupScript(row)],
    };
  }

  /**
   * **The root credentials are referenced here, not written here, and
   * the audience that buys is every account on the Server.**
   *
   * What broke first: this script *is* PID 1 of the container — unlike redis's
   * wrapper, which `redis-server` argv-rewrote away — and the whole
   * script is `ContainerSpec.Args`, so `row.databasePassword` sat in
   * `/proc/1/cmdline`. Measured on Docker 29.3.1: that file is mode
   * `-r--r--r--` and `nobody` reads it for the container's whole life, where
   * `/proc/1/environ` is `-r--------` and refuses. This is the same
   * service-spec case ADR-0015's last bullet decides — for a spec, ask which
   * audience reads which field — and the answer is the same: the password has
   * to be in this spec's `Env` regardless, because it is the connection
   * credential the operator's own applications read, so a Docker secret would
   * remove one copy of a value the same document keeps.
   *
   * **`process.env` inside the JS, and the ticket's quoting rework is not
   * needed.** The ticket expected `pwd: "$MONGO_INITDB_ROOT_PASSWORD"` and therefore
   * expected the single-quoted `mongosh --eval '…'` word to be reworked into
   * something the shell expands inside. Rejected on measurement: mongosh is a
   * Node shell and exposes `process` (verified against mongo:8 —
   * `typeof process` is `object` and `process.env.CG_…` reads back), so the JS
   * can read the holder itself. That keeps the single quotes exactly as they
   * are, and it is *stronger* than the shell-expansion route rather than
   * merely tidier: an expansion inside a double-quoted `--eval` word would have
   * moved the password out of bash's argv and into **mongosh's** argv, which is
   * the same world-readable `/proc/<pid>/cmdline` one process along.
   *
   * **`exec` is not available here, and a trap is the answer.** The
   * `&`/`wait` shape is the point of the script: mongod has to be *running*
   * before `rs.initiate` can reach it, so the shell must outlive the start.
   * That leaves bash as PID 1, and a Stop is delivered to PID 1 only — measured
   * for the identical shape in redis, `docker stop -t 20` spent the full
   * 20.17 s and the container was SIGKILLed with no shutdown line in its log,
   * because dash swallowed the signal. `database-spec.ts` sets a 30-second
   * `StopGracePeriod` *so a database can flush to disk*, and it was being spent
   * waiting on a shell that had already ignored the signal. So `forwardStop`
   * relays SIGTERM to mongod and then `wait`s for it, which is what makes the
   * shell outlive the flush instead of exiting ahead of it; `wait` is the one
   * builtin a trapped signal interrupts, which is why the tail has to stay a
   * `wait` rather than becoming anything else.
   *
   * **Every way out of the script ends with mongod's exit status.** The
   * readiness loop used to be `while ! mongosh … ping; do sleep 2; done` and
   * nothing else, so a mongod that exited at startup — a data directory the
   * image could not read, exit 62 — left this shell pinging a port nothing
   * would ever open. The shell is PID 1, so the container stayed up, Swarm saw a
   * running task and neither restarted nor rolled back, and the deploy read
   * `done` over a server that refused every connection. The loop now asks
   * `kill -0` before each sleep, and both it and the tail end in
   * `exitWithMongod`, which reaps mongod and exits with its status: the
   * container stops, and Swarm records the task failed with
   * "task: non-zero exit (62)" — which is what the deploy verdict reads.
   * The tail is still a `wait` inside that function, so the trap above
   * interrupts it exactly as before.
   *
   * **A saved Run command runs beside mongod, not in place of the wait on it.**
   * It used to replace the tail, so a command that returned ended
   * the container on the spot, and one that did not left nothing watching
   * mongod — a mongod that died after the replica set was up was a running
   * task for as long as the command ran, and a Stop waited out the grace
   * period, because bash defers a trap until a foreground command completes.
   * {@link MongoService.savedRunCommand} starts it in the background once the
   * replica set is initiated, and the shell waits on mongod whatever it does.
   */
  private replicaSetStartupScript(row: MongoNested): string {
    return `
#!/bin/bash
mongod --port 27017 --replSet rs0 --bind_ip_all &
MONGOD_PID=$!

# A Stop is delivered to PID 1, which is this shell and not mongod. Relay it
# and then outlive the flush, or the 30s StopGracePeriod database-spec.ts sets
# is spent waiting on a shell that already ignored the signal.
forwardStop() {
	kill -TERM "$MONGOD_PID" 2>/dev/null
	wait "$MONGOD_PID" 2>/dev/null
	exit 0
}
trap forwardStop TERM INT

# mongod has exited: end this shell with its status, so the container stops
# and Swarm records a failed task instead of a running one. Its wait
# is also what the Stop trap interrupts, so a Stop still goes to forwardStop.
exitWithMongod() {
	wait "$MONGOD_PID"
	MONGOD_STATUS=$?
	echo "mongod exited with status $MONGOD_STATUS $1, so the replica-set bootstrap exits with it" >&2
	exit "$MONGOD_STATUS"
}

# Wait for MongoDB to be ready, for as long as there is a mongod to wait for
until mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; do
	kill -0 "$MONGOD_PID" 2>/dev/null || exitWithMongod "before it accepted connections"
	sleep 2
done

# Check if replica set is already initialized
REPLICA_STATUS=$(mongosh --quiet --eval "rs.status().ok || 0")

if [ "$REPLICA_STATUS" != "1" ]; then
	echo "Initializing replica set..."
	mongosh --eval '
	rs.initiate({
		_id: "rs0",
		members: [{ _id: 0, host: "${row.appName}:27017", priority: 1 }]
	});

	// Wait for the replica set to initialize
	while (!rs.isMaster().ismaster) {
		sleep(1000);
	}

	// Create root user after replica set is initialized and we are primary.
	// Read out of the environment and never written into this script: it is
	// PID 1 and /proc/1/cmdline is world-readable.
	db.getSiblingDB("admin").createUser({
		user: process.env.${ROOT_USERNAME_HOLDER},
		pwd: process.env.${ROOT_PASSWORD_HOLDER},
		roles: ["root"]
	});
	'

else
	echo "Replica set already initialized."
fi

${this.savedRunCommand(row)}exitWithMongod "after it accepted connections"`;
  }

  /**
   * The row's `command`, as a background job of the replica-set script:
   * after the replica set is initiated, and never in the way of the script's
   * wait on mongod. Braced so a command of several statements is one job, and
   * the closing brace on its own line so a trailing `#` comment cannot swallow
   * it. A blank column is no command.
   */
  private savedRunCommand(row: MongoNested): string {
    const command = row.command?.trim();
    if (!command) return '';
    return `# The saved Run command, beside mongod rather than in place of the wait on it
{
${command}
} &
`;
  }
}
