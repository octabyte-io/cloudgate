import { getTableColumns } from 'drizzle-orm';
import { serviceTypeEnum } from '../../src/applications/application.schema';
import type { ServiceSource } from '../../src/environments/environment-services';
import {
  SERVICE_SOURCES,
  summaryColumns,
} from '../../src/environments/environment-services';

/**
 * Plaintext columns that are still credentials or identities a service list
 * has no business publishing. Everything else sensitive on these tables is an
 * `encryptedText` column, which is detected rather than listed.
 *
 * `refresh_token` left this list by ceasing to qualify for it: the
 * deploy-webhook secret on `application` and `compose` is `encryptedText` now,
 * so {@link sensitiveColumnsOf} finds it on its own, and leaving the name here
 * would only hide that it ever had to be written down. Both remaining entries
 * are identities rather than secrets — the half of a credential pair whose
 * other half is encrypted — which is why neither is a candidate for the same
 * treatment.
 */
const PLAINTEXT_SECRETS = ['username', 'database_user'];

/** The db column names on a table that must never reach a client here. */
function sensitiveColumnsOf(source: ServiceSource): string[] {
  return Object.values(getTableColumns(source.table))
    .filter(
      (column) =>
        // `encryptedText` is the only custom column type in the schema, so
        // every PgCustomColumn is a secret decrypted on read (ADR 0006).
        column.columnType === 'PgCustomColumn' ||
        PLAINTEXT_SECRETS.includes(column.name),
    )
    .map((column) => column.name);
}

describe('SERVICE_SOURCES', () => {
  it.each(serviceTypeEnum.enumValues)(
    'has a source for the %s service type',
    (serviceType) => {
      // Exhaustive over the service_type enum: a service kind missing here is
      // a service kind missing from every Environment read.
      expect(SERVICE_SOURCES[serviceType]?.serviceType).toBe(serviceType);
      expect(SERVICE_SOURCES[serviceType].table).toBeDefined();
    },
  );

  it('registers each table exactly once', () => {
    const tables = Object.values(SERVICE_SOURCES).map((source) => source.table);
    expect(new Set(tables).size).toBe(tables.length);
  });
});

describe('summaryColumns', () => {
  const sources = Object.values(SERVICE_SOURCES);

  it.each(sources)(
    'projects no credential of a $serviceType',
    (source: ServiceSource) => {
      const sensitive = sensitiveColumnsOf(source);
      // Guard against a detection that quietly stops finding anything.
      expect(sensitive.length).toBeGreaterThan(0);

      const projected = Object.values(summaryColumns(source)).map(
        (column) => column.name,
      );
      expect(projected.filter((name) => sensitive.includes(name))).toEqual([]);
    },
  );

  it('projects the same summary shape from every table', () => {
    const shapes = sources.map((source) =>
      Object.keys(summaryColumns(source)).join(','),
    );
    // The arms are `union all`-ed, so a table projecting a different set of
    // columns would be a SQL error rather than a wrong answer.
    expect(new Set(shapes).size).toBe(1);
  });

  it('projects every column the summary declares', () => {
    expect(Object.keys(summaryColumns(SERVICE_SOURCES.application))).toEqual([
      'serviceId',
      'name',
      'appName',
      'configName',
      'description',
      'status',
      'serverId',
      'createdAt',
    ]);
  });
});
