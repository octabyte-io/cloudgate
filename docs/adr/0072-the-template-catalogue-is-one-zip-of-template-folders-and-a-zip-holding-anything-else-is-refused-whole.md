# The Template catalogue is one zip of template folders, and a zip holding anything else is refused whole

Status: accepted. Amends [ADR-0062](0062-the-template-catalogue-is-on-by-default-read-as-the-newest-fixed-release-of-cg-templates-in-one-file.md). Discussed in [#1403](https://github.com/octabyte-io/cloudgate/issues/1403).

ADR-0062 publishes each version of the **Template catalogue** as one `catalogue.json` holding every template's files, with a PNG logo as base64. That doesn't scale: at 500 templates the text alone is a few MB, and logos can push the file far past its 10 MB cap. A file over the cap is refused, so new templates quietly stop reaching installs. #1403 asked instead for Cloudgate to read the `cg-templates` repository live, one file at a time. We keep ADR-0062's model of one fixed release downloaded once, and change only what is in it: a **zip**, with one folder per template. Because the zip comes from the internet, its layout is checked strictly before anything in it is read, and a zip that holds anything Cloudgate does not expect is refused as a whole.

## Decision

- **What is published.** Each `cg-templates` release carries one `catalogue.zip`, built by CI from the template folders and never edited by hand. The default `CLOUDGATE_TEMPLATES_URL` becomes `https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip`. Everything else in ADR-0062 stands: a version is fixed once released, an install fetches a release it already holds never again, checks at most once an hour, keeps the last good copy in the database, and shows an unreachable catalogue as unreachable, never as empty.
- **What the zip holds, and nothing else.**

  ```
  catalogue.json                 # index: format, and each template's id and revision. No file contents.
  templates/<id>/template.yaml
  templates/<id>/cloudgate.yaml
  templates/<id>/docker-compose.yml   # only with a compose part
  templates/<id>/files/…              # the config files it ships
  templates/<id>/logo.svg | logo.png
  ```

  Every folder under `templates/` is named in the index and every id in the index has a folder. The website's `index.md` and `screenshots/` live beside these files in the repository, but CI leaves them out of the zip.
- **The zip is checked as a package before any file in it is read, and one failure refuses the whole zip.** The last good copy is kept and the console names the reason. The zip is refused if:
  - any entry's path is not one of the paths above, exactly as spelled (a website file, a second compose file, a stray file at the root or in a folder), or any config file under `files/` breaks the rules below;
  - a path is absolute, contains `..`, a backslash, a NUL or an empty segment, or two entries have the same path, including paths that differ only in letter case;
  - an entry is a symlink, encrypted, or compressed by a method other than stored or deflate;
  - the download is over 10 MB, the unpacked total is over 50 MB, any one file is over its own cap (a logo's stays 100 KB), or there are more than 20,000 entries. Sizes are counted as the bytes are unpacked and the zip's own headers are never trusted, so a zip bomb is stopped where it crosses the cap.

  It is read in memory and never written to disk.
- **Which config files a template may ship under `files/`.** A config file is text the template's own containers read. Cloudgate never runs it itself. Every one must pass all of these, or the whole zip is refused:
  - it is listed in that template's `template.yaml` `files`, so nothing sits in a folder that the template does not say it uses;
  - its name ends in one of `.conf`, `.cfg`, `.ini`, `.yaml`, `.yml`, `.json`, `.toml`, `.xml`, `.properties`, `.sql`, `.txt`, `.html`, `.css`, `.tmpl`, or it is named `Caddyfile`. Any other name is refused, which includes scripts (`.sh`, `.py`, `.js`, …), programs, archives, images and hidden files such as `.env`;
  - it is UTF-8 text with no NUL byte;
  - it is at most 256 KB, and one template's `files/` is at most 1 MB in all;
  - its path stays inside `files/`, is written plainly, and holds no `"`, `` ` ``, `$`, `\` or line break (today's `filesRule`).

  The zip's own file modes are never read, so nothing arrives executable. A new kind of config file is added to the list only by amending this ADR.
- **A sound zip still hides one bad template alone.** The package check above is about the zip's shape. Inside a sound zip, ADR-0062 and spec #1356 still apply: each template is checked on its own, and one that fails is hidden with its reason, without hiding the rest.
- **A contributor's folder in the repository may hold the website's files.** `cloudgate template check <folder>` accepts `index.md` and `screenshots/` by those names and skips them. Any other unknown file is still refused, so a misnamed `docker-compose.yaml` or a config file outside `files/` is still caught. The zip itself never holds them.
- **Not live from `main`.** #1403's live read is rejected for ADR-0062's reasons, which grow with the catalogue: a list and a setup could read different commits, GitHub's raw host caches each file separately so one read can mix two commits, every refresh would take thousands of requests at 500 templates, the saved copy for outages would have to rebuild a snapshot anyway, and a mirror would have to serve the whole tree.

## Consequences

- `downloadCatalogue` keeps its redirect-is-the-release logic and its cap while reading. `readCatalogueFile` and the check take the unpacked zip in place of JSON. `encodeCatalogue` becomes the zip builder that `cg-templates` CI and `cloudgate template check` share; CI publishes with `cloudgate template pack <folder> <out> --revision <sha>`, which writes nothing unless every template passes. The zip is read and written by a small reader of Cloudgate's own over `node:zlib`, not a zip library, because a library's defaults (extracting to disk, following symlinks, trusting declared sizes) are what this decision refuses.
- An operator whose `CLOUDGATE_TEMPLATES_URL` names a mirrored `catalogue.json` gets a refusal that names the change: this Cloudgate reads `catalogue.zip`. Their saved copy is kept until they mirror the zip. `deploy/env/cloudgate-backend.example` and `docs/deploy.md` name the new default address.
- The trust rules from ADR-0062 carry over unchanged: the address is an instance setting, only the backend talks to the catalogue (logos travel inside the zip), and everything is checked before any write.
