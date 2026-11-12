import type {
  ConfigReader,
  ConfigReadRequest,
  ConfigReadResult,
} from '../../src/project-config/reader/config-reader.port';

interface FakeRepository {
  defaultBranch: string;
  unreachable: boolean;
  /** branch → (path → file); a branch with no entry does not exist. */
  branches: Map<string, { commitSha: string; files: Map<string, string> }>;
}

/**
 * The config reader port faked in memory (spec seam 2): a
 * (repository, branch, path) → text map, each branch at one commit, that can
 * also answer "unreachable", "branch missing" and "file missing" the way a
 * provider implementation does.
 *
 * `createTestApp` registers one for every e2e spec, so no spec ever reaches
 * a provider's API for a config, and `resetDb` empties it. A spec gets it as
 * `ctx.configReader`.
 */
export class FakeConfigReader implements ConfigReader {
  /** Every read, in order, for a spec asserting who read what. */
  readonly calls: ConfigReadRequest[] = [];
  private readonly repositories = new Map<string, FakeRepository>();
  private commits = 0;

  read(request: ConfigReadRequest): Promise<ConfigReadResult> {
    this.calls.push(request);
    const { repository, path } = request;
    const found = this.repositories.get(repository.toLowerCase());
    if (!found || found.unreachable) {
      return Promise.resolve({
        ok: false,
        reason: 'repository-unreachable',
        branch: request.ref,
        message: `Repository ${repository} does not exist or the connection cannot reach it`,
      });
    }
    const branch = request.ref ?? found.defaultBranch;
    const head = found.branches.get(branch);
    if (!head) {
      return Promise.resolve({
        ok: false,
        reason: 'branch-missing',
        branch,
        message: `Repository ${repository} has no branch ${branch}`,
      });
    }
    const text = head.files.get(path);
    if (text === undefined) {
      return Promise.resolve({
        ok: false,
        reason: 'file-missing',
        branch,
        message: `There is no file ${path} in repository ${repository} on branch ${branch}`,
      });
    }
    return Promise.resolve({
      ok: true,
      text,
      commitSha: head.commitSha,
      branch,
      fileUrl: `https://git.example/${repository}/blob/${head.commitSha}/${path}`,
    });
  }

  /**
   * Commits `text` at `path` on `branch` (the default branch when omitted),
   * moving that branch to a new commit, whose sha it answers.
   */
  commit(
    repository: string,
    text: string,
    {
      path = 'cloudgate.yaml',
      branch,
    }: { path?: string; branch?: string } = {},
  ): string {
    const found = this.repository(repository);
    const name = branch ?? found.defaultBranch;
    const head = found.branches.get(name) ?? {
      commitSha: '',
      files: new Map<string, string>(),
    };
    head.commitSha = `c${String(++this.commits).padStart(7, '0')}`;
    head.files.set(path, text);
    found.branches.set(name, head);
    return head.commitSha;
  }

  /** Sets a repository's default branch (`main` until set). */
  setDefaultBranch(repository: string, branch: string): void {
    this.repository(repository).defaultBranch = branch;
  }

  /** Makes a known repository unreachable, or reachable again. */
  setUnreachable(repository: string, unreachable = true): void {
    this.repository(repository).unreachable = unreachable;
  }

  reset(): void {
    this.repositories.clear();
    this.calls.length = 0;
  }

  private repository(name: string): FakeRepository {
    const key = name.toLowerCase();
    let found = this.repositories.get(key);
    if (!found) {
      found = {
        defaultBranch: 'main',
        unreachable: false,
        branches: new Map(),
      };
      this.repositories.set(key, found);
    }
    return found;
  }
}
