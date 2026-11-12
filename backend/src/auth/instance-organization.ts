import { hashPassword } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DrizzleDB } from '../db/drizzle.module';
import { account, member, organization, user } from '../db/schema';
import { pinInstanceOrganization } from '../rbac/instance-organization-pin';
import { normalizeEmail } from '../users/user-email';
import { hasInstanceOwner } from './sign-up-state';

/**
 * What `create-instance-organization` is given: the first account, and
 * the name of the Organization it owns.
 */
export interface InstanceOrganizationInput {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  organizationName: string;
}

export interface InstanceOrganizationCreated {
  userId: string;
  organizationId: string;
  email: string;
  organizationName: string;
}

/**
 * A refusal the command prints as its one line and exits non-zero on: nothing
 * was written.
 */
export class InstanceOrganizationRefusal extends Error {}

/** better-auth's own bounds (`minPasswordLength`, `maxPasswordLength`). */
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
/** The ceiling `POST /organizations` puts on a name. */
const MAX_ORGANIZATION_NAME = 255;
/** The shape better-auth's sign-up accepts, near enough for a hand-run command. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Serialises two runs of the command, so the "no owner yet" check and the
 * owner row it guards cannot both pass for two of them. A transaction-scoped
 * advisory lock: released on commit or rollback, nothing to clean up.
 */
const LOCK_KEY = sql`hashtext('cloudgate:create-instance-organization')`;

function validated(
  input: InstanceOrganizationInput,
): InstanceOrganizationInput {
  const email = normalizeEmail(input.email);
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const organizationName = input.organizationName.trim();
  const problems: string[] = [];
  if (!EMAIL.test(email))
    problems.push(`"${input.email}" is not an email address`);
  if (firstName === '') problems.push('a first name is required');
  if (organizationName === '')
    problems.push('an Organization name is required');
  if (organizationName.length > MAX_ORGANIZATION_NAME) {
    problems.push(
      `an Organization name is at most ${MAX_ORGANIZATION_NAME} characters`,
    );
  }
  if (input.password.length < MIN_PASSWORD) {
    problems.push(`the password must be at least ${MIN_PASSWORD} characters`);
  }
  if (input.password.length > MAX_PASSWORD) {
    problems.push(`the password must be at most ${MAX_PASSWORD} characters`);
  }
  if (problems.length > 0) {
    throw new InstanceOrganizationRefusal(
      `Nothing was created: ${problems.join('; ')}.`,
    );
  }
  return {
    email,
    firstName,
    lastName,
    organizationName,
    password: input.password,
  };
}

/**
 * Makes the first account and the **Instance organization** it owns
 * (ADR-0051's sign-up decision), for the platform host's
 * `create-instance-organization` command.
 *
 * On the Hosted instance this is the only way the Instance organization comes
 * to exist: web sign-up says "not open yet" until it does
 * (`SignUpState`), so instance authority is Octabyte's from the first moment
 * rather than whoever reaches the form first. The Organization it makes is
 * **pinned** as the Instance organization in the same transaction
 * (`pinInstanceOrganization`, ADR-0077): instance authority is read from that
 * pin alone, so no later owner row can ever take it over.
 *
 * It writes what better-auth's own email sign-up writes (a `user`, its
 * `credential` account holding the scrypt hash better-auth verifies) plus the
 * owner membership `bootstrapDefaultOrganization` writes for a Self-hosted
 * first sign-up. The address is marked confirmed: whoever runs this is on the
 * box, and that is a stronger proof than a link. The Organization gets no
 * Hosted plan and no Servers — it holds only the staff who run the Instance.
 *
 * Refuses, writing nothing, once any owner exists: the Instance organization
 * is made once. It does not look at the instance mode, so a Self-hosted
 * operator can claim a fresh install from the box the same way.
 */
export async function createInstanceOrganization(
  db: DrizzleDB,
  input: InstanceOrganizationInput,
): Promise<InstanceOrganizationCreated> {
  const fields = validated(input);
  const passwordHash = await hashPassword(fields.password);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`);

    if (await hasInstanceOwner(tx)) {
      throw new InstanceOrganizationRefusal(
        'Nothing was created: this instance already has an Instance organization. It is made once; add staff to it by invitation from the console.',
      );
    }

    const now = new Date();
    const userId = nanoid();
    const inserted = await tx
      .insert(user)
      .values({
        id: userId,
        firstName: fields.firstName,
        lastName: fields.lastName,
        email: normalizeEmail(fields.email),
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: user.id });
    if (inserted.length === 0) {
      throw new InstanceOrganizationRefusal(
        `Nothing was created: an account already uses ${fields.email}.`,
      );
    }

    // `accountId` is the user's id, as better-auth's email sign-up writes it.
    await tx.insert(account).values({
      userId,
      accountId: userId,
      providerId: 'credential',
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    const [org] = await tx
      .insert(organization)
      .values({
        name: fields.organizationName,
        ownerId: userId,
        createdAt: now,
      })
      .returning({ id: organization.id });

    await tx.insert(member).values({
      organizationId: org.id,
      userId,
      role: 'owner',
      createdAt: now,
      isDefault: true,
    });

    if (!(await pinInstanceOrganization(tx, org.id))) {
      // Unreachable under the lock and the check above; refusing rolls the
      // whole account back rather than leaving an unpinned owner behind.
      throw new InstanceOrganizationRefusal(
        'Nothing was created: this instance already has an Instance organization.',
      );
    }

    return {
      userId,
      organizationId: org.id,
      email: fields.email,
      organizationName: fields.organizationName,
    };
  });
}
