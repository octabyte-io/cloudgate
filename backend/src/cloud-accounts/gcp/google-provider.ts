import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { Env } from '../../common/config/env.schema';
import { encryptValue } from '../../common/encryption/encryption';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { cloudAccount } from '../../db/schema';
import type { CloudAccount } from '../../db/schema';
import { InstanceUrlService } from '../../settings/instance-url.service';
import {
  AWS_COLUMNS,
  connectChecked,
  editChecked,
  openSetupToken,
  passed,
  reachingCloud,
  recordUseFailure,
  without,
} from '../cloud-account-rows';
import type {
  CloudAccountView,
  GoogleCloudAccountSetup,
  GoogleKeyChanged,
  GoogleNewKey,
} from '../cloud-accounts.service';
import { googleAccountOf } from '../cloud-provider';
import type { GcpCloudAccount } from '../cloud-provider';
import type { CloudProvider, ConnectCheckOutcome } from '../cloud-providers';
import type { GoogleCredential } from '../cloud.port';
import type {
  CreateCloudAccountInput,
  SetupCloudAccountInput,
  UpdateCloudAccountInput,
} from '../dto/cloud-account.dto';
import { GOOGLE_CLOUD_PORT } from '../google-cloud.port';
import type { GoogleAccessToken, GoogleCloudPort } from '../google-cloud.port';
import { policyStanding } from '../aws/policy-standing';
import { runGoogleConnectCheck } from './connect-check';
import type {
  GoogleConnectCheckInput,
  GoogleConnectCheckResult,
} from './connect-check';
import { GOOGLE_ROLE, makesBuildIdentity } from './deploy-role';
import { buildIdentityNames } from './cloud-build-names';
import type { GoogleRole } from './deploy-role';
import {
  jwksOf,
  makeSigningKey,
  RUN_TOKEN_SECONDS,
  signIdToken,
  signingKeyOf,
  tokenAudience,
  tokenIssuer,
  tokenSubject,
} from './id-token';
import type { PublicJwk, SigningKey } from './id-token';
import { runGoogleRegionCheck } from './region-check';
import type { GoogleRegionCheckResult } from './region-check';
import { googleSetupNames, googleSetupTemplate } from './setup-script';
import type { GoogleSetupTemplate } from './setup-script';

/**
 * How long the deploy service account's access token a Cloud run takes for
 * Cloudgate's own calls lives: Google's default limit for one.
 */
const RUN_ACCESS_SECONDS = 60 * 60;

const DUPLICATE =
  'This Google Cloud project is already connected to this Organization as a Cloud account';

/** The fields a Google Cloud account's edit reruns the connect check for. */
const CREDENTIAL_FIELDS = [
  'workloadIdentityProvider',
  'deployServiceAccount',
] as const;

/**
 * A Google setup token's contents: the Cloud account's id, its key pair and
 * the issuer its tokens name, fixed here because the script hands that issuer
 * to the provider it makes.
 */
interface GoogleSetupIds {
  cloud: 'gcp';
  organizationId: string;
  cloudAccountId: string;
  signingKey: SigningKey;
  issuer: string;
}

/**
 * **A Cloud account at Google Cloud** (the Google Cloud spec; ADR-0043): a
 * project whose workload identity provider trusts tokens Cloudgate signs
 * with the Cloud account's own key, to act as a deploy service account the
 * operator made from Cloudgate's setup script. Every call goes through the
 * Google port, which the e2e specs fake.
 */
@Injectable()
export class GoogleProvider implements CloudProvider {
  readonly cloud = 'gcp' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(GOOGLE_CLOUD_PORT) private readonly port: GoogleCloudPort,
    @Inject(GOOGLE_ROLE) private readonly role: GoogleRole,
    private readonly instanceUrl: InstanceUrlService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * The setup script for a Google Cloud project not yet connected (the
   * Google Cloud spec, "Setup script"), with the JWKS and the role definition
   * beside it.
   *
   * **The key pair is made here**, before anything is saved, because the
   * script uploads its public half before the Cloud account exists. Like
   * AWS's external id it travels in the sealed setup token (ADR-0006), bound
   * to the Organization, so the private half reaches the browser only as
   * ciphertext only this instance can open, and is never shown. Passing the
   * token back keeps the key and the id. Calls nothing in Google and keeps
   * nothing.
   */
  async setup(
    organizationId: string,
    data: SetupCloudAccountInput,
  ): Promise<GoogleCloudAccountSetup> {
    if (data.cloud !== 'gcp') throw notGoogle(data.cloud);
    let ids: GoogleSetupIds;
    if (data.setupToken) {
      ids = this.readSetupToken(organizationId, data.setupToken);
    } else {
      const cloudAccountId = nanoid();
      ids = {
        cloud: 'gcp',
        organizationId,
        cloudAccountId,
        signingKey: makeSigningKey(),
        issuer: await this.issuer(cloudAccountId),
      };
    }
    return {
      cloud: 'gcp',
      setupToken: encryptValue(JSON.stringify(ids)),
      cloudAccountId: ids.cloudAccountId,
      signingKeyId: ids.signingKey.keyId,
      signingPublicKey: JSON.stringify(ids.signingKey.publicJwk),
      template: googleSetupTemplate(
        {
          projectId: data.cloudId,
          cloudAccountId: ids.cloudAccountId,
          issuer: ids.issuer,
          publicKeys: [ids.signingKey.publicJwk],
        },
        this.role,
      ),
    };
  }

  /**
   * Connects a Google Cloud project (the Google Cloud spec, "Connecting"): the Google
   * connect check, signed with the key the setup token carries, and on a pass
   * the row with the project number it read, the provider, the service
   * account, the key pair (the private half encrypted, ADR-0006), the issuer
   * the setup fixed and the role version it held the service account to.
   */
  async connect(
    organizationId: string,
    data: CreateCloudAccountInput,
  ): Promise<CloudAccount> {
    if (data.cloud !== 'gcp') throw notGoogle(data.cloud);
    const ids = this.readSetupToken(organizationId, data.setupToken);
    return connectChecked(
      this.db,
      {
        organizationId,
        cloud: 'gcp',
        cloudId: data.cloudId,
        duplicate: DUPLICATE,
      },
      () =>
        this.runCheck({
          projectId: data.cloudId,
          cloudAccountId: ids.cloudAccountId,
          workloadIdentityProvider: data.workloadIdentityProvider,
          deployServiceAccount: data.deployServiceAccount,
          signingKey: ids.signingKey,
          issuer: ids.issuer,
        }),
      (pass) => ({
        cloudAccountId: ids.cloudAccountId,
        organizationId,
        name: data.name,
        cloud: 'gcp',
        cloudId: data.cloudId,
        projectNumber: pass.projectNumber,
        workloadIdentityProvider: data.workloadIdentityProvider,
        deployServiceAccount: data.deployServiceAccount,
        signingKey: ids.signingKey.privateKey,
        signingKeyId: ids.signingKey.keyId,
        signingPublicKey: JSON.stringify(ids.signingKey.publicJwk),
        tokenIssuer: ids.issuer,
      }),
    );
  }

  /**
   * An edit by {@link editChecked}'s rules: a changed
   * provider or service account reruns the connect check, signed with the
   * key that signs today. The project, its number, the key and the issuer
   * are not edited here.
   */
  async edit(
    row: CloudAccount,
    data: UpdateCloudAccountInput,
  ): Promise<Partial<CloudAccount>> {
    if (data.cloud !== 'gcp') throw notGoogle(data.cloud);
    const stored = googleAccountOf(row);
    const merged = {
      name: data.name ?? stored.name,
      workloadIdentityProvider:
        data.workloadIdentityProvider ?? stored.workloadIdentityProvider,
      deployServiceAccount:
        data.deployServiceAccount ?? stored.deployServiceAccount,
    };
    return editChecked(stored, merged, CREDENTIAL_FIELDS, () =>
      this.runCheck(checkInput({ ...stored, ...merged })),
    );
  }

  /** Signed with the key that signs today, never a pending one. */
  check(row: CloudAccount): Promise<ConnectCheckOutcome> {
    return this.runCheck(checkInput(googleAccountOf(row)));
  }

  /**
   * The setup script at the current role version: its own names, its stored
   * issuer, and a JWKS of the key that signs plus the pending one while a key
   * change waits, so uploading it never locks out either.
   */
  template(row: CloudAccount): GoogleSetupTemplate {
    const account = googleAccountOf(row);
    const publicKeys = [JSON.parse(account.signingPublicKey) as PublicJwk];
    if (account.pendingSigningKey !== null) {
      publicKeys.push(signingKeyOf(account.pendingSigningKey).publicJwk);
    }
    return googleSetupTemplate(
      {
        projectId: account.cloudId,
        cloudAccountId: account.cloudAccountId,
        issuer: account.tokenIssuer,
        publicKeys,
      },
      this.role,
    );
  }

  /**
   * The Google region check (the Google Cloud spec, "Region check"), signed with the key
   * it signs with now: its warnings, or a 400 naming the region. A call
   * Google never answered is a 502.
   */
  async checkRegion(row: CloudAccount, region: string): Promise<string[]> {
    const found = googleAccountOf(row);
    const issuer = await this.issuer(found.cloudAccountId);
    const result: GoogleRegionCheckResult = await reachingCloud(
      'Google Cloud',
      () =>
        runGoogleRegionCheck(this.port, {
          projectId: found.cloudId,
          cloudAccountId: found.cloudAccountId,
          workloadIdentityProvider: found.workloadIdentityProvider,
          deployServiceAccount: found.deployServiceAccount,
          signingKey: {
            privateKey: found.signingKey,
            keyId: found.signingKeyId,
          },
          issuer,
          region,
        }),
    );
    if (!result.ok) throw new BadRequestException(result.message);
    return result.warnings;
  }

  signIn(
    row: CloudAccount,
  ): Promise<{ ok: true } | { ok: false; refusal: string }> {
    return this.runSession(googleAccountOf(row));
  }

  /**
   * A Google Cloud account's proof for one Cloud run (the Google Cloud spec, S16): a
   * token signed for 2 hours with the key it signs with today, inside the
   * credential configuration the run's provider reads — written into the
   * run's own folder and gone with it — and the deploy service account's
   * access token, for the calls Cloudgate makes beside `tofu` (the search by
   * name). A refusal names the Cloud account and Google's own words, and is
   * recorded on the Cloud account like any failed use.
   */
  async runSession(
    account: GcpCloudAccount,
  ): Promise<
    | { ok: true; credential: GoogleCredential; token: GoogleAccessToken }
    | { ok: false; refusal: string }
  > {
    let subjectToken: string;
    try {
      subjectToken = signIdToken(
        { privateKey: account.signingKey, keyId: account.signingKeyId },
        {
          issuer: account.tokenIssuer,
          subject: tokenSubject(account.cloudAccountId),
          workloadIdentityProvider: account.workloadIdentityProvider,
          lifetimeSeconds: RUN_TOKEN_SECONDS,
        },
      );
    } catch (error) {
      return {
        ok: false,
        refusal: `Cloud account ${account.name}'s signing key could not sign its proof: ${error instanceof Error ? error.message : String(error)}. Change its key in Organization settings, then Check for changes`,
      };
    }
    const audience = tokenAudience(account.workloadIdentityProvider);
    let signedIn: Awaited<ReturnType<GoogleProvider['signInWith']>>;
    try {
      signedIn = await this.signInWith(account, audience, subjectToken);
    } catch (error) {
      return {
        ok: false,
        refusal: `Google Cloud could not be reached for Cloud account ${account.name}: ${error instanceof Error ? error.message : String(error)}. Check for changes to read it again`,
      };
    }
    if (!signedIn.ok) {
      const words = `${signedIn.code}: ${signedIn.message}`;
      await recordUseFailure(this.db, account.cloudAccountId, words);
      return {
        ok: false,
        refusal: `Cloud account ${account.name} could not sign in to Google Cloud: ${signedIn.step}, answering ${words}. Run Check now on it in Organization settings, then Check for changes`,
      };
    }
    const { token } = signedIn;
    return {
      ok: true,
      token,
      credential: this.port.credentialConfiguration({
        audience,
        serviceAccount: account.deployServiceAccount,
        subjectToken,
      }),
    };
  }

  /**
   * "New key": makes a new key pair and keeps its private
   * half as pending, encrypted (ADR-0006), answering the setup with a JWKS of
   * both public halves. Nothing signs with it yet: Check now and every use
   * keep the old key until {@link checkNewKey} passes, so a provider still
   * holding only the old JWKS goes on working. Asking again replaces the
   * pending key. Calls nothing in Google.
   */
  async newKey(stored: GcpCloudAccount): Promise<GoogleNewKey> {
    const key = makeSigningKey();
    const [updated] = await this.db
      .update(cloudAccount)
      .set({ pendingSigningKey: key.privateKey })
      .where(eq(cloudAccount.cloudAccountId, stored.cloudAccountId))
      .returning();
    return {
      signingKeyId: key.keyId,
      signingPublicKey: JSON.stringify(key.publicJwk),
      template: this.template(updated),
    };
  }

  /**
   * The connect check signed with the pending key. A failure
   * is a `400` that changes nothing — not the key, not the last check, which
   * says how the key that signs is doing. A pass switches: the pending key
   * signs from now on, the old one is dropped, the pass is recorded, and the
   * answer reminds the operator to upload the JWKS holding the new key alone,
   * so the provider stops trusting the old one. The switch takes only the key
   * that was checked: asked for another new key meanwhile, it is a `409` that
   * leaves that one waiting, unchecked.
   */
  async checkNewKey(stored: GcpCloudAccount): Promise<GoogleKeyChanged> {
    if (stored.pendingSigningKey === null) {
      throw new BadRequestException(
        `Cloud account ${stored.name} has no new key waiting; ask for a new key first`,
      );
    }
    const key = signingKeyOf(stored.pendingSigningKey);
    const result = await this.runCheck(checkInput(stored, key));
    if (!result.ok) throw new BadRequestException(result.message);

    const updated = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ pendingSigningKey: cloudAccount.pendingSigningKey })
        .from(cloudAccount)
        .where(eq(cloudAccount.cloudAccountId, stored.cloudAccountId))
        .for('update');
      if (current?.pendingSigningKey !== stored.pendingSigningKey) {
        throw new ConflictException(
          `Cloud account ${stored.name} was asked for another new key while this one was checked; check the new key again`,
        );
      }
      const [switched] = await tx
        .update(cloudAccount)
        .set({
          signingKey: key.privateKey,
          signingKeyId: key.keyId,
          signingPublicKey: JSON.stringify(key.publicJwk),
          pendingSigningKey: null,
          ...passed(result.policyVersion),
        })
        .where(eq(cloudAccount.cloudAccountId, stored.cloudAccountId))
        .returning();
      return switched;
    });
    return {
      cloudAccount: this.view(updated),
      jwks: `${JSON.stringify(jwksOf([key.publicJwk]), null, 2)}\n`,
      message: `Cloud account ${stored.name} now signs with key ${key.keyId}. Upload the JWKS that holds only the new key to provider ${stored.workloadIdentityProvider}, so the old key is no longer trusted`,
    };
  }

  view(row: CloudAccount): CloudAccountView {
    const account = googleAccountOf(row);
    return {
      ...without(account, [...AWS_COLUMNS, 'signingKey', 'pendingSigningKey']),
      // The role's version, by the same rule as the AWS policy's.
      ...policyStanding(
        row.policyVersion,
        this.role.version,
        this.role.requiredPermissions,
      ),
      hasSigningKey: account.signingKey.length > 0,
      hasPendingSigningKey: account.pendingSigningKey !== null,
    };
  }

  /**
   * What a Delete leaves for the operator to remove by hand (the Google Cloud spec): the
   * pool and provider its setup made — the pool read from the stored
   * provider, in case the operator named it differently — the custom role
   * and the deploy service account, and, once checked at version 6, the
   * build identity and its role.
   */
  leftovers(row: CloudAccount): string {
    const account = googleAccountOf(row);
    const names = googleSetupNames(account.cloudId, account.cloudAccountId);
    const pool =
      /\/workloadIdentityPools\/([^/]+)\//.exec(
        account.workloadIdentityProvider,
      )?.[1] ?? names.pool;
    // A setup at a Hosted version (6, 8) also made the build identity.
    const build = makesBuildIdentity(row.policyVersion)
      ? buildIdentityNames({
          projectId: account.cloudId,
          cloudAccountId: account.cloudAccountId,
        })
      : null;
    const made = build
      ? `the custom roles projects/${account.cloudId}/roles/${names.role} and projects/${account.cloudId}/roles/${build.role}, the deploy service account ${account.deployServiceAccount} and the build service account ${build.serviceAccountEmail}`
      : `the custom role projects/${account.cloudId}/roles/${names.role} and the deploy service account ${account.deployServiceAccount}`;
    return `Cloud account ${account.name} is removed from Cloudgate. Nothing was removed in Google Cloud project ${account.cloudId}: the workload identity pool ${pool}, its provider ${account.workloadIdentityProvider}, ${made} are yours to remove.`;
  }

  /** STS, then the deploy service account, with a run's proof; a refusal says which step refused. */
  private async signInWith(
    account: GcpCloudAccount,
    audience: string,
    subjectToken: string,
  ): Promise<
    | { ok: true; token: GoogleAccessToken }
    | { ok: false; step: string; code: string; message: string }
  > {
    const federated = await this.port.exchangeToken({
      audience,
      subjectToken,
    });
    if (!federated.ok) {
      return { ...federated, step: "Google's STS refused its proof" };
    }
    const impersonated = await this.port.impersonate(federated.value, {
      serviceAccount: account.deployServiceAccount,
      lifetimeSeconds: RUN_ACCESS_SECONDS,
    });
    return impersonated.ok
      ? { ok: true, token: impersonated.value }
      : {
          ...impersonated,
          step: `it could not act as its deploy service account ${account.deployServiceAccount}`,
        };
  }

  /**
   * The Google connect check through its port, as AWS's is: a call Google
   * never answered is a 502.
   */
  private runCheck(
    input: GoogleConnectCheckInput,
  ): Promise<GoogleConnectCheckResult> {
    return reachingCloud('Google Cloud', () =>
      runGoogleConnectCheck(this.port, input, this.role),
    );
  }

  /**
   * The issuer a Google Cloud account's tokens name (S16): the install's own
   * address — the instance URL, else the one it was installed at — followed
   * by the Cloud account's id. Google never fetches it; the provider only
   * matches it, so an install no one can reach from outside still has one.
   * An install that knows neither address is refused: there is nothing to
   * set the provider's issuer to.
   */
  private async issuer(cloudAccountId: string): Promise<string> {
    const installUrl =
      (await this.instanceUrl.getInstanceUrl()) ??
      this.config.get('BETTER_AUTH_URL', { infer: true }) ??
      null;
    if (!installUrl) {
      throw new BadRequestException(
        "Cloudgate does not know its own address, which a Google Cloud project's provider names as the issuer. Set the instance URL in Settings first",
      );
    }
    return tokenIssuer(installUrl, cloudAccountId);
  }

  /** The id and key pair a Google setup token carries, if it is one this instance made for this Organization. */
  private readSetupToken(
    organizationId: string,
    token: string,
  ): GoogleSetupIds {
    return openSetupToken(
      organizationId,
      token,
      'The setup token is not one Cloudgate made for a Google Cloud project in this Organization; get the setup script again',
      (ids) => {
        const key = ids.signingKey as Partial<SigningKey> | undefined;
        return ids.cloud === 'gcp' &&
          typeof ids.cloudAccountId === 'string' &&
          typeof ids.issuer === 'string' &&
          typeof key?.privateKey === 'string' &&
          typeof key.keyId === 'string' &&
          typeof key.publicJwk === 'object'
          ? {
              cloud: 'gcp',
              organizationId,
              cloudAccountId: ids.cloudAccountId,
              signingKey: key as SigningKey,
              issuer: ids.issuer,
            }
          : null;
      },
    );
  }
}

/**
 * The connect check's input for a Google row's values, signed with `key` —
 * the one that signs today unless a key change is being checked — and
 * naming the issuer stored at connect, never one read from the install's
 * address now, which may have moved since.
 */
function checkInput(
  row: Pick<
    GcpCloudAccount,
    | 'cloudId'
    | 'cloudAccountId'
    | 'workloadIdentityProvider'
    | 'deployServiceAccount'
    | 'signingKey'
    | 'signingKeyId'
    | 'tokenIssuer'
  >,
  key: Pick<SigningKey, 'privateKey' | 'keyId'> = {
    privateKey: row.signingKey,
    keyId: row.signingKeyId,
  },
): GoogleConnectCheckInput {
  return {
    projectId: row.cloudId,
    cloudAccountId: row.cloudAccountId,
    workloadIdentityProvider: row.workloadIdentityProvider,
    deployServiceAccount: row.deployServiceAccount,
    signingKey: key,
    issuer: row.tokenIssuer,
  };
}

/** An input of another cloud handed to Google's provider: the caller chose by its `cloud`, so this is a bug. */
function notGoogle(cloud: string): Error {
  return new Error(
    `A ${cloud} Cloud account's input reached Google Cloud's provider`,
  );
}
