# A template's values are made once at setup and saved where typed values are; a compose part never takes an Output

Status: accepted. Builds on [ADR-0029](0029-the-project-config-is-the-one-record-of-what-a-project-runs-and-the-console-edits-it.md) (the config holds variable names, never values), [ADR-0031](0031-a-wired-variable-is-a-config-link-filled-in-at-deploy-never-a-saved-value.md) (Wired variables) and [ADR-0019](0019-a-response-replaces-a-secret-with-its-presence.md). Extends [ADR-0063](0063-a-template-is-offered-only-where-its-deploy-target-can-make-every-entry-and-a-compose-part-needs-a-server.md) by one rule. Corrected by the owner's decision on #1369: `base64` is 32 bytes, as the list below says; the Plan line's example once read 64.

A **Template**'s `cloudgate.yaml` lists variable names only, so its `template.yaml` has to say how each value is made. The old `template.toml` made values with inline `${password}`-style helpers, re-made them on every preview and every deploy, and needed a `regenerated` report to say which values on the review screen were not the ones that would exist.

## Decision

- **One rule per name.** `template.yaml` has `inputs:`, a map from variable name to one rule. Every name the template's `cloudgate.yaml` lists without a link must have a rule. So must every `${NAME}` its compose file uses without a `:-default`. Nothing else may have one. A name listed on two entries gets one value, saved on both.
- **Four kinds.**
  - `generate`: one of `password` (letters and digits, 32), `hex` (64), `base64` (32 bytes), `uuid`, or `jwt` (`secret:` another input, `payload:`, HS256, no expiry unless the payload sets one). All use a cryptographically secure source. No fake emails, usernames, timestamps or random ports.
  - `ask`: `label`, `description`, `default`, `required` (default true), `secret`, and at most one check, `format: email | url | number` or `pattern`.
  - `value`: fixed text, which may refer to other inputs as `{{NAME}}` and to a Domain as `{{domains.<name>.url}}` or `{{domains.<name>.host}}`. `<name>` is a compose service or an own `web`'s config name. A loop, an unknown name, or a name that is both fails the check. Config file text uses the same references.
  - Wired: written in `cloudgate.yaml` as a link (ADR-0031), never in `inputs:`.
- **Made once, at setup.** Asked values exist at setup, so every other value is made then too, along with the host of each own `web` a value refers to. They wait as one encrypted pending set on the Environment, keyed by config name and variable name. The Apply that creates each Service writes its values into that Service's own `env`, uses the picked host for its generated Domain, and deletes them from the set. That works the same for a repository-kept config whose push comes days later.
- **Saved where a typed value is.** After Apply a value is an ordinary value in the Service's own `env` in that Environment, never the Environment's or Project's, so two templates set up side by side cannot collide.
- **Shown as a rule, never as a secret.** The Plan shows how each value is made (`generated (base64, 32 bytes)`, `asked`). A secret is never shown, per ADR-0019; a non-secret asked value may be. A generated password is read afterwards on the Service's variables page, like any value.
- **A compose part gets plain values, never an Output.** It receives every input its compose file uses as `${NAME}`, in the stack's own `env`. The catalogue check refuses a compose part that needs an own-kind entry's Output.
- **Not offered where a URL can't be known at setup** (extends ADR-0063). A template whose values refer to an own `web`'s URL is not offered in an Environment whose target gives that `web` no generated host at setup, such as a Cloud account.

## Considered options

- **Make generated values at Apply.** Rejected: asked values need a home between setup and Apply anyway, and two moments would mean two places to look.
- **Save shared values on the Environment and refer to them with `${{environment.KEY}}`.** Rejected: two templates in one Environment would collide on common names like `SECRET_KEY`.
- **Copy an Output into the compose stack's `env`.** Rejected: it is the saved copy ADR-0031 rejected, and it drifts after a password change. Letting console-managed entries take links is a larger change and belongs with the `kind: compose` work.
- **Railway-style open generators (any length, any alphabet).** Rejected: a small fixed set covers today's templates, is easy to check in CI, and can't produce a weak secret by accident.
- **Ask the user for a URL a cloud can't give yet, or leave it unset with a note.** Rejected: the first is a guess and the second is a broken app.

## Consequences

- `${password}`-style helpers, the `regenerated` report and the double-resolve preview go with `template.toml`. Porting a template by hand means rewriting its helpers as `inputs:`.
- Today's `generatePassword` (`Math.random`, lowercased) is not reused.
- When an unused pending set is dropped is decided in [How does setting up a template become a Plan?](https://github.com/octabyte-io/cloudgate/issues/1352).
