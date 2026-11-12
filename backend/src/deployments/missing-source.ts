import type { SourceType } from '../git-providers/git-provider.schema';

/**
 * The columns that say where an Application's or a Compose stack's code comes
 * from. A stack has no image or upload columns, so those two are optional.
 */
export interface SourceColumns {
  sourceType: SourceType;
  repository?: string | null;
  gitlabRepository?: string | null;
  giteaRepository?: string | null;
  bitbucketRepository?: string | null;
  customGitUrl?: string | null;
  dockerImage?: string | null;
  dropBuildPath?: string | null;
}

const GIT_PROVIDER: Partial<
  Record<SourceType, { label: string; column: keyof SourceColumns }>
> = {
  github: { label: 'GitHub', column: 'repository' },
  gitlab: { label: 'GitLab', column: 'gitlabRepository' },
  gitea: { label: 'Gitea', column: 'giteaRepository' },
  bitbucket: { label: 'Bitbucket', column: 'bitbucketRepository' },
};

/**
 * What a row still needs before there is anything to build, as a clause — or
 * `null` when its source is set.
 *
 * `source_type` defaults to `github` on both tables, so a row nobody has
 * pointed anywhere *claims* GitHub. The type alone therefore cannot say whether
 * a source was chosen; the column the type reads from can. A `github` row with
 * no repository is told apart from the others for that reason: it is the
 * fresh-create row, so its clause names no type. Every other type is set only
 * by choosing it, so its clause can name what that choice still lacks. The clause names the
 * missing thing (a repository, a URL, an image, the files) rather than the
 * provider connection, because the worker's own failure for this row — "has no
 * GitHub provider linked" — sent the operator to Settings instead of to the
 * source they had not chosen.
 *
 * A `drop` row counts as set once an upload has written `dropBuildPath`: the
 * upload route is the only writer of that column. `raw` is a stack whose
 * source is its own compose file, which has its own gate.
 */
export function missingSource(row: SourceColumns): string | null {
  const provider = GIT_PROVIDER[row.sourceType];
  if (provider) {
    if (!blank(row[provider.column])) return null;
    // `github` with no repository is exactly what create leaves behind, so the
    // type is the column default rather than anyone's choice, and naming it
    // would present the default as the operator's configuration.
    return row.sourceType === 'github'
      ? 'no source is chosen'
      : `no ${provider.label} repository is chosen`;
  }
  switch (row.sourceType) {
    case 'git':
      return blank(row.customGitUrl) ? 'no git URL is set' : null;
    case 'docker':
      return blank(row.dockerImage) ? 'no Docker image is set' : null;
    case 'drop':
      return blank(row.dropBuildPath) ? 'no files have been uploaded' : null;
    default:
      return null;
  }
}

function blank(value: string | null | undefined): boolean {
  return !value || value.trim() === '';
}
