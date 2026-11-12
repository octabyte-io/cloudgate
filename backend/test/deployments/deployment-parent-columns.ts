import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { deployment } from '../../src/deployments/deployment.schema';

/**
 * The foreign keys on `deployment` that **qualify** a parent rather than
 * being one, each beside the parent column it qualifies.
 *
 * `preview_deployment_id` names the Preview deployment an
 * `application`-parented build built. The row stays in its Application's
 * history, `deployment_at_most_one_parent` still counts five columns, and
 * ADR-0017 is unamended, so `DeploymentParent` has no arm for it and neither
 * writer claims it. The composite key
 * `deployment_preview_belongs_to_its_application` pairs it with the column it
 * qualifies, which is why a key naming a qualifier is not read as a parent.
 *
 * **Listing it here is the argued case the censuses below exist to force.**
 * A foreign key added to `deployment` and named nowhere still reds both of
 * them; putting it in this map is the claim that it qualifies a parent, and
 * `deployment-parent.spec.ts` checks the claim against the table.
 */
export const QUALIFIER_COLUMNS: Readonly<Record<string, string>> = {
  previewDeploymentId: 'applicationId',
};

/**
 * The foreign keys on `deployment` that are **neither a parent nor a
 * qualifier of one**: a reference the row carries about what governed it,
 * each beside the table it references.
 *
 * `held_by_plan_id` names the plan a build was held for. It is set on
 * a row that already has its Application parent, kept once the build is
 * released, and `set null` with the plan; `deployment_at_most_one_parent`
 * still counts five columns and ADR-0017 is unamended, so `DeploymentParent`
 * has no arm for it and neither writer claims it.
 *
 * As with {@link QUALIFIER_COLUMNS}, **listing a column here is an argued
 * claim**, and `deployment-parent.spec.ts` checks it against the table: the
 * column is a one-column key on `deployment`, referencing the table named
 * here, and no arm writes it.
 */
export const NON_PARENT_REFERENCE_COLUMNS: Readonly<Record<string, string>> = {
  heldByPlanId: 'plan',
  // The plan a cloud Service's deploy stopped on: set on a row that
  // already has its Application parent, `set null` with the plan.
  reviewPlanId: 'plan',
  // "For Service" (S14, ADR-0017 amended): the Service an Environment
  // network's Domain run is about, on a row whose parent stays the network;
  // it lists the run on the Service, and is `set null` with it.
  forServiceId: 'application',
};

/** `deployment`'s foreign keys, each as the property names of its columns. */
export function deploymentForeignKeys(): string[][] {
  return deploymentForeignKeysWithTargets().map(({ columns }) => columns);
}

/**
 * `deployment`'s foreign keys, each as the property names of its columns and
 * the name of the table it references.
 */
export function deploymentForeignKeysWithTargets(): {
  columns: string[];
  references: string;
}[] {
  const propertyByColumnName = new Map(
    Object.entries(getTableColumns(deployment)).map(([property, column]) => [
      column.name,
      property,
    ]),
  );
  return getTableConfig(deployment).foreignKeys.map((key) => {
    const reference = key.reference();
    return {
      columns: reference.columns.map((column) => {
        const property = propertyByColumnName.get(column.name);
        if (property === undefined) {
          throw new Error(
            `deployment has a foreign key on "${column.name}" with no property`,
          );
        }
        return property;
      }),
      references: getTableConfig(reference.foreignTable).name,
    };
  });
}

/**
 * Every parent column the table has, derived from its own foreign keys: each
 * key that names no qualifier and no non-parent reference, column by column.
 * A key that names a qualifier is the qualifier's own reference or its
 * pairing with the parent it qualifies, and the parent is already counted by
 * its own one-column key; a key on a {@link NON_PARENT_REFERENCE_COLUMNS}
 * column is not a parent at all.
 */
export function parentColumnsOnTheTable(): string[] {
  return deploymentForeignKeys()
    .filter(
      (columns) =>
        !columns.some(
          (name) =>
            name in QUALIFIER_COLUMNS || name in NON_PARENT_REFERENCE_COLUMNS,
        ),
    )
    .flat();
}
