import { describe, expect, it } from "vitest";

import { GIT_CLONE_URL } from "./git-url";

/** The same cases as the backend's `git-clone-url.spec.ts`. */
describe("GIT_CLONE_URL", () => {
  it.each([
    "https://git.example.com/acme/api.git",
    "http://git.internal/acme/api",
    "https://deploy:token@git.example.com/a/b.git",
    "ssh://git@git.example.com:2222/acme/api.git",
    "git://git.example.com/acme/api.git",
    "git@github.com:acme/api.git",
    "deploy@10.0.0.7:repos/api.git",
  ])("takes %s", (url) => {
    expect(GIT_CLONE_URL.test(url)).toBe(true);
  });

  it.each([
    "not a url",
    "github.com/acme/api",
    "https://git.example.com",
    "ftp://git.example.com/acme/api.git",
    "git@github.com",
    "file:///srv/repo.git",
    // A leading `-` is read by git or ssh as an option, wherever it sits.
    "-oProxyCommand=touch@host:x",
    "--upload-pack=touch@host:x",
    "git@-oProxyCommand=touch:x",
    "git@-host.example.com:x",
    "ssh://-oProxyCommand=touch/acme/api.git",
    "ssh://git@-oProxyCommand=touch/acme/api.git",
    "ssh://-oProxyCommand=touch@host/acme/api.git",
    "https://-host.example.com/acme/api.git",
  ])("refuses %s", (url) => {
    expect(GIT_CLONE_URL.test(url)).toBe(false);
  });
});
