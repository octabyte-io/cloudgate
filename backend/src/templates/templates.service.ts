import {
  BadGatewayException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { FetchClient } from '../git-providers/fetch.provider';
import { FETCH_CLIENT } from '../git-providers/fetch.provider';
import { CLOUDGATE_VERSION } from '../settings/version';
import { downloadCatalogue } from './catalogue-download';
import { catalogueSource } from './catalogue-source';
import type { CatalogueSource } from './catalogue-source';
import { checkCatalogue } from './check';
import type { Template } from './check';
import { templateCatalogue } from './template-catalogue.schema';
import type { TemplateCatalogueRow } from './template-catalogue.schema';
import { whereItRuns } from './where-it-runs';
import type { RunsOn } from './where-it-runs';

/**
 * The `code` on the 503 every catalogue read answers while templates are off
 * (`CLOUDGATE_TEMPLATES_URL=off`, or only the old setting set), so the
 * console branches on a name rather than on the sentence, and does not retry a
 * refusal whose answer cannot change until the instance is reconfigured. The
 * name predates `off`; it is kept because it is the wire contract.
 */
export const TEMPLATES_CATALOGUE_NOT_CONFIGURED_CODE =
  'TEMPLATES_CATALOGUE_NOT_CONFIGURED';

/** How long a check stands before opening the templates screen checks again. */
export const CATALOGUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** One Template as the catalogue routes list it. */
export interface TemplateSummary {
  /** The folder name: a Config name, never changing. */
  readonly id: string;
  /** The last catalogue commit that changed the folder. */
  readonly revision: string;
  readonly name: string;
  readonly description: string;
  /** The app's version, display only; null when the template states none. */
  readonly version: string | null;
  readonly tags: readonly string[];
  readonly links: {
    readonly website?: string;
    readonly docs?: string;
    readonly source?: string;
  };
  /**
   * The logo from the catalogue zip, as a `data:` address. The backend is
   * the only thing that talks to the catalogue, so the logo travels with the
   * list rather than as a third-party image request; and an SVG drawn by an
   * `<img>` from a `data:` address runs no script.
   */
  readonly logo: string;
  /** Where it can run: a Server, and each cloud that makes every entry. */
  readonly runsOn: readonly RunsOn[];
}

/** The saved copy the list was read from, for the screen's staleness note. */
export interface CatalogueCopy {
  /** When this copy was fetched: how old it is. */
  readonly fetchedAt: string;
  /** When the address was last checked for a newer copy. */
  readonly checkedAt: string;
  /** Why the last check kept this copy; null when it found nothing wrong. */
  readonly problem: string | null;
}

export interface TemplateCatalogue {
  readonly templates: readonly TemplateSummary[];
  readonly copy: CatalogueCopy;
}

/** A saved copy, without the body: what deciding whether to check needs. */
type CopyFacts = Omit<TemplateCatalogueRow, 'body'>;

/**
 * **The catalogue reader** (ADR-0062, ADR-0072): the official `cg-templates`
 * release's `catalogue.zip` by default, the last good copy kept in the
 * database, re-checked at most once an hour and only when someone opens the
 * templates screen.
 *
 * - A copy checked within the hour is served as it is.
 * - A check that finds the release already held reads no body.
 * - A new file goes through the Template check; a file that is oversize, not
 *   a catalogue, a format-1 `catalogue.json`, or a zip holding anything a
 *   template does not is refused whole and the old copy kept.
 * - An unreachable address serves the saved copy, saying why and how old it
 *   is. With no saved copy it is a 502, or a 504 on the 10-second deadline,
 *   never an empty list.
 *
 * Templates the Template check hides are left out of the list; why each is
 * hidden goes to the log when a new copy is saved.
 */
@Injectable()
export class TemplatesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TemplatesService.name);

  /** Checks in flight, per address, so concurrent opens share one. */
  private readonly checking = new Map<string, Promise<TemplateCatalogue>>();

  /** The last saved copy checked, so a copy is not re-read on every list. */
  private checked: {
    readonly sourceUrl: string;
    readonly fetchedAt: string;
    readonly templates: readonly TemplateSummary[];
  } | null = null;

  constructor(
    @Inject(FETCH_CLIENT) private readonly fetchClient: FetchClient,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
  ) {}

  /** ADR-0066: an install that kept only the old setting is told at startup. */
  onApplicationBootstrap(): void {
    const source = this.source();
    if (!source.on) this.logger.warn(source.message);
  }

  /** The Templates this instance offers, and the copy they were read from. */
  async listTemplates(now = new Date()): Promise<TemplateCatalogue> {
    return this.catalogue(now);
  }

  /** Every tag on an offered Template, once each. */
  async getTags(now = new Date()): Promise<string[]> {
    const { templates } = await this.catalogue(now);
    return [...new Set(templates.flatMap((template) => template.tags))];
  }

  /**
   * One Template as setup sets it up: from the saved copy, through the
   * Template check on exactly the bytes held, never fetched (spec #1356).
   * A template the check hides is not set up, and its reason is said.
   */
  async savedTemplate(templateId: string): Promise<Template> {
    const source = this.source();
    if (!source.on) {
      throw new ServiceUnavailableException({
        message: source.message,
        code: TEMPLATES_CATALOGUE_NOT_CONFIGURED_CODE,
      });
    }
    const [row] = await this.db
      .select({ body: templateCatalogue.body })
      .from(templateCatalogue)
      .where(eq(templateCatalogue.sourceUrl, source.url));
    if (!row) {
      throw new NotFoundException(
        'Template not found: the template catalogue has not been read yet',
      );
    }
    const result = checkCatalogue(savedBytes(row.body), {
      cloudgateVersion: CLOUDGATE_VERSION,
    });
    if (!result.ok) {
      throw new BadGatewayException(
        `The saved template catalogue cannot be read by this Cloudgate: ${result.reason}`,
      );
    }
    const offered = result.offered.find((one) => one.id === templateId);
    if (offered) return offered;
    const hidden = result.hidden.find((one) => one.id === templateId);
    throw new NotFoundException(
      hidden
        ? `Template ${templateId} is not offered: ${hidden.reason}`
        : 'Template not found',
    );
  }

  /**
   * Read per call rather than captured at wiring, so a test (and a reload)
   * can change it.
   */
  private source(): CatalogueSource {
    return catalogueSource({
      url: this.config.get<string>('CLOUDGATE_TEMPLATES_URL'),
      oldBaseUrl: this.config.get<string>('CLOUDGATE_TEMPLATES_BASE_URL'),
    });
  }

  private async catalogue(now: Date): Promise<TemplateCatalogue> {
    const source = this.source();
    if (!source.on) {
      throw new ServiceUnavailableException({
        message: source.message,
        code: TEMPLATES_CATALOGUE_NOT_CONFIGURED_CODE,
      });
    }
    const url = source.url;
    const saved = await this.savedCopy(url);
    if (
      saved &&
      now.getTime() - Date.parse(saved.checkedAt) < CATALOGUE_CHECK_INTERVAL_MS
    ) {
      return this.serve(saved);
    }

    const inFlight = this.checking.get(url);
    if (inFlight) return inFlight;
    const pending = this.check(url, saved, now).finally(() => {
      this.checking.delete(url);
    });
    this.checking.set(url, pending);
    return pending;
  }

  /** Checks the address for a newer copy, keeping the saved one on any failure. */
  private async check(
    url: string,
    saved: CopyFacts | null,
    now: Date,
  ): Promise<TemplateCatalogue> {
    const checkedAt = now.toISOString();
    const download = await downloadCatalogue(
      this.fetchClient,
      url,
      saved?.release ?? null,
    );

    if (download.kind === 'held') {
      // Only a saved copy has a version to be held, so `saved` is set here.
      if (saved)
        return this.serve(await this.markChecked(saved, checkedAt, null));
    }
    if (download.kind === 'unreachable') {
      this.logger.warn(download.message);
      if (saved) {
        return this.serve(
          await this.markChecked(saved, checkedAt, download.message),
        );
      }
      throw download.timedOut
        ? new GatewayTimeoutException(download.message)
        : new BadGatewayException(download.message);
    }

    let refusal: string;
    if (download.kind === 'fetched') {
      const result = checkCatalogue(download.bytes, {
        cloudgateVersion: CLOUDGATE_VERSION,
      });
      if (result.ok) {
        for (const hidden of result.hidden) {
          this.logger.warn(`Template ${hidden.id} is hidden: ${hidden.reason}`);
        }
        const row: TemplateCatalogueRow = {
          sourceUrl: url,
          release: download.release,
          body: Buffer.from(download.bytes).toString('base64'),
          fetchedAt: checkedAt,
          checkedAt,
          problem: null,
        };
        await this.db
          .insert(templateCatalogue)
          .values(row)
          .onConflictDoUpdate({
            target: templateCatalogue.sourceUrl,
            set: {
              release: row.release,
              body: row.body,
              fetchedAt: row.fetchedAt,
              checkedAt: row.checkedAt,
              problem: null,
            },
          });
        const templates = result.offered.map(summarize);
        this.checked = { sourceUrl: url, fetchedAt: checkedAt, templates };
        return { templates, copy: copyOf(row) };
      }
      refusal = `The newest template catalogue was refused: ${result.reason}`;
    } else if (download.kind === 'refused') {
      refusal = download.reason;
    } else {
      refusal = 'The template catalogue answered with no copy to read';
    }

    this.logger.warn(refusal);
    if (saved) {
      return this.serve(await this.markChecked(saved, checkedAt, refusal));
    }
    throw new BadGatewayException(refusal);
  }

  private async savedCopy(url: string): Promise<CopyFacts | null> {
    const [row] = await this.db
      .select({
        sourceUrl: templateCatalogue.sourceUrl,
        release: templateCatalogue.release,
        fetchedAt: templateCatalogue.fetchedAt,
        checkedAt: templateCatalogue.checkedAt,
        problem: templateCatalogue.problem,
      })
      .from(templateCatalogue)
      .where(eq(templateCatalogue.sourceUrl, url));
    return row ?? null;
  }

  private async markChecked(
    saved: CopyFacts,
    checkedAt: string,
    problem: string | null,
  ): Promise<CopyFacts> {
    await this.db
      .update(templateCatalogue)
      .set({ checkedAt, problem })
      .where(eq(templateCatalogue.sourceUrl, saved.sourceUrl));
    return { ...saved, checkedAt, problem };
  }

  /** The saved copy's Templates, read and checked once per copy. */
  private async serve(saved: CopyFacts): Promise<TemplateCatalogue> {
    const copy = copyOf(saved);
    if (
      this.checked?.sourceUrl === saved.sourceUrl &&
      this.checked.fetchedAt === saved.fetchedAt
    ) {
      return { templates: this.checked.templates, copy };
    }
    const [row] = await this.db
      .select({ body: templateCatalogue.body })
      .from(templateCatalogue)
      .where(eq(templateCatalogue.sourceUrl, saved.sourceUrl));
    const result = checkCatalogue(savedBytes(row?.body ?? ''), {
      cloudgateVersion: CLOUDGATE_VERSION,
    });
    if (!result.ok) {
      // Only a Cloudgate that reads a different format than the one that
      // saved it gets here; the copy is of no use to it.
      throw new BadGatewayException(
        `The saved template catalogue cannot be read by this Cloudgate: ${result.reason}`,
      );
    }
    const templates = result.offered.map(summarize);
    this.checked = {
      sourceUrl: saved.sourceUrl,
      fetchedAt: saved.fetchedAt,
      templates,
    };
    return { templates, copy };
  }
}

/**
 * A saved copy's zip, from the base64 `template_catalogue.body` holds it as
 * (a zip is not UTF-8 text; the schema's `body` says why base64).
 */
function savedBytes(body: string): Buffer {
  return Buffer.from(body, 'base64');
}

function copyOf(saved: CopyFacts): CatalogueCopy {
  return {
    fetchedAt: saved.fetchedAt,
    checkedAt: saved.checkedAt,
    problem: saved.problem,
  };
}

function summarize(template: Template): TemplateSummary {
  return {
    id: template.id,
    revision: template.revision,
    name: template.name,
    description: template.description,
    version: template.version ?? null,
    tags: template.tags,
    links: template.links,
    logo: `data:${template.logo.mediaType};base64,${Buffer.from(template.logo.bytes).toString('base64')}`,
    runsOn: whereItRuns(template.config),
  };
}
