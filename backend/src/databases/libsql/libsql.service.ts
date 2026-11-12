import { BadRequestException, Injectable } from '@nestjs/common';
import type { PortConfig } from 'dockerode';
import { eq } from 'drizzle-orm';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import type { PermissionCtx } from '../../rbac/permission.service';
import { server } from '../../servers/server.schema';
import { BaseDatabaseService } from '../common/database-service';
import type { CreateLibsqlDto } from './dto/libsql.dto';
import { libsql } from './libsql.schema';
import type { Libsql } from './libsql.schema';

type LibsqlNested = Libsql & {
  environment: typeof environment.$inferSelect & {
    project: typeof project.$inferSelect;
  };
  server: typeof server.$inferSelect | null;
};

const DEFAULT_SQLD_COMMAND =
  'sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000';

/** LibSQL: a thin engine spec over the shared database base, with sqld node
 * topology and three published ports. */
@Injectable()
export class LibsqlService extends BaseDatabaseService<Libsql, LibsqlNested> {
  protected readonly engineLabel = 'LibSQL';
  protected readonly appNamePrefix = 'libsql';
  protected readonly serviceType = 'libsql' as const;
  protected readonly targetPort = 8080;
  protected readonly table = libsql;
  protected readonly columns = {
    id: libsql.libsqlId,
    appName: libsql.appName,
    environmentId: libsql.environmentId,
    serverId: libsql.serverId,
    applicationStatus: libsql.applicationStatus,
  };

  create(ctx: PermissionCtx, data: CreateLibsqlDto) {
    return this.createDatabase(ctx, { ...data });
  }

  protected idOf(row: Libsql): string {
    return row.libsqlId;
  }

  protected queryById(libsqlId: string) {
    return this.db.query.libsql.findFirst({
      where: eq(libsql.libsqlId, libsqlId),
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
  }

  /**
   * sqld authenticates HTTP with basic auth derived from the connection user
   * and password; a replica names its primary.
   *
   * Pairs rather than a dotenv body, for
   * {@link PostgresService.defaultEnv}' reason — and this engine is the one
   * where an operator's override of a derived name was worth the most.
   * `sqld` reads `SQLD_HTTP_AUTH` on **every** start, not once against a fresh
   * volume like the four entrypoint-driven engines, so an `env` assigning it
   * changed the credential the server actually accepted for as long as the row
   * lived. `common/reserved-env.ts` records that asymmetry between the engines,
   * because it is the difference between what the fix takes away here and what
   * it takes away there.
   *
   * The base64 is why `SQLD_HTTP_AUTH` is `databaseUser and databasePassword`'s
   * in `ENGINE_ENV_OWNERS` rather than one column's: two columns are joined
   * into one word, and a refusal that named only one of them would send the
   * operator to the wrong place.
   *
   * `?? ''` on the replica's primary URL rather than the `"null"` the old
   * template produced for a null column. `createLibsqlSchema` and
   * `updateLibsqlSchema` both refuse `sqldNode: 'replica'` without a
   * `sqldPrimaryUrl`, so neither spelling is reachable through the API and this
   * is only about which one a legacy row gets: an empty value fails sqld's own
   * parse, where the four characters `null` are a URL it would try.
   */
  protected defaultEnv(row: LibsqlNested): Record<string, string> {
    const basicAuth = Buffer.from(
      `${row.databaseUser}:${row.databasePassword}`,
      'utf-8',
    ).toString('base64');
    return {
      SQLD_NODE: row.sqldNode,
      SQLD_HTTP_AUTH: `basic:${basicAuth}`,
      ...(row.sqldNode === 'replica'
        ? { SQLD_PRIMARY_URL: row.sqldPrimaryUrl ?? '' }
        : {}),
    };
  }

  protected mountPath(): string {
    return '/var/lib/sqld';
  }

  /**
   * The image has no listener config of its own, so absent a row-supplied
   * `command` the entrypoint launches sqld with explicit http/grpc/admin
   * addresses and `--db-path iku.db` ({@link DEFAULT_SQLD_COMMAND}). A saved
   * `command` is honoured and **replaces that whole invocation** — only the
   * namespaces flag is appended — so a command without
   * `--http-listen-addr 0.0.0.0:8080` leaves sqld on its own default of
   * `127.0.0.1:8080`, unreachable from outside the container. `args` is read
   * by nothing. This used to say *"always launches sqld with explicit … addresses"*,
   * and the console said the column was *"saved and then ignored"*; neither
   * was true of a row with a command. The console now says so and warns
   * at save; refusing such a command here was not taken, because the column is
   * a free program-and-arguments and the refusal would have to parse every way
   * a sqld variant can spell its listen address.
   *
   * **`exec`, and it is a durability fix rather than tidiness.** What
   * broke first: without it `/bin/sh` stays resident as PID 1 and a Stop is
   * delivered to PID 1 only, so dash received the signal and sqld never did.
   * Measured for the identical shape in redis (`redis.service.ts` carries
   * the numbers): `docker stop -t 20` took the full **20.17 s** and the
   * container was SIGKILLed with its log ending at the ready line — no
   * shutdown, no flush — against **0.16 s** and a real shutdown line with
   * `exec`. `buildDatabaseServiceSpec` sets a 30-second `StopGracePeriod`
   * *"so they can flush to disk"*, and every Stop, Remove containers and
   * redeploy was spending it waiting on a shell that had already ignored the
   * signal.
   *
   * **`exec` unconditionally, including over a row-supplied `command`**, which
   * is the one judgement here. `exec` replaces the shell with the *first*
   * command of the word, so it would drop the second half of a compound
   * program like `a && b`. That is not what this column is: for the four
   * engines with no `containerCommand` of their own,
   * `buildDatabaseServiceSpec` turns `command` into argv with
   * `command.split(' ')`, which makes `&&` a literal argument — so the
   * platform's own contract for the column is *a program and its arguments*,
   * and this engine wrapping it in `/bin/sh -c` is the outlier rather than the
   * definition. The rejected alternative was `exec`ing only
   * {@link DEFAULT_SQLD_COMMAND} and leaving a row-supplied command
   * unprefixed: it keeps the defect for exactly the rows that opted into
   * running a real sqld variant, and it makes the emitted shape depend on which
   * column the program came from, which is one more thing to be wrong about
   * later. {@link MongoService.replicaSetStartupScript} is the engine that
   * genuinely cannot take `exec` and says why.
   */
  protected containerCommand(row: LibsqlNested) {
    let command = row.command ?? DEFAULT_SQLD_COMMAND;
    if (row.enableNamespaces) {
      command += ' --enable-namespaces';
    }
    return { Command: ['/bin/sh'], Args: ['-c', `exec ${command}`] };
  }

  /** The EndpointSpec: http (8080), grpc (5001) and admin (5000) publish
   * independently against their own external ports. */
  protected publishedPorts(row: LibsqlNested): PortConfig[] {
    const port = (target: number, published: number | null): PortConfig[] =>
      published
        ? [
            {
              Protocol: 'tcp',
              TargetPort: target,
              PublishedPort: published,
              PublishMode: 'host',
            },
          ]
        : [];
    return [
      ...port(8080, row.externalPort),
      ...port(5001, row.externalGRPCPort),
      ...port(5000, row.externalAdminPort),
    ];
  }

  /**
   * Persists all three ports and converges — except a replica has no gRPC
   * listener of its own to publish. A stopped database stays stopped and
   * publishes them at its next Start.
   */
  async saveExternalPorts(
    ctx: PermissionCtx,
    databaseId: string,
    data: {
      externalPort: number | null;
      externalGRPCPort: number | null;
      externalAdminPort: number | null;
    },
  ) {
    const owned = await this.findOwnedForUpdate(ctx, databaseId);
    const found = await this.queryById(owned.id);
    if (found?.sqldNode === 'replica' && data.externalGRPCPort !== null) {
      throw new BadRequestException(
        "externalGRPCPort cannot be set when sqldNode is 'replica'",
      );
    }
    await this.updateRow(owned.id, {
      externalPort: data.externalPort,
      externalGRPCPort: data.externalGRPCPort,
      externalAdminPort: data.externalAdminPort,
    });
    return this.deployInternal(owned.id, 'apply');
  }
}
