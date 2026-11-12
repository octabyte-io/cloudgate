# A template folder may hold a test-values file, which `template try` reads and the catalogue leaves out

Status: accepted. Amends [ADR-0072](0072-the-template-catalogue-is-one-zip-of-template-folders-and-a-zip-holding-anything-else-is-refused-whole.md).

`cloudgate template try` starts a Template's compose part on the local Docker with values made as setup makes them. A `generate` or `value` input needs nothing from the author, and an `ask` input takes its default or a sample made to fit its format or pattern. Some asked values cannot be faked from their rule, such as a licence key with a checksum, so an author needs somewhere to write the value `try` should use. ADR-0072 refuses any file in a template folder it does not name, other than the website's `index.md` and `screenshots/`.

**Decision.** A template folder in the repository may hold `test-values.yaml`: a map of an `ask` input's name to the text `try` uses for it. `template check` and `template pack` treat it like the website's files: they accept it by that exact name, skip it, and never put it in `catalogue.zip`, whose list of paths is unchanged. `try` uses this file's value first, then the ask's default, then a sample. A name in the file that is not one of the template's `ask` inputs fails `try`, and so does an `ask` input left with no value it can make.

**Rejected.** A `--values <file>` flag alone, with the file kept outside the folder: it splits one template's facts across two places, and CI would have to know a second layout. Both together: a second way to do the same thing, with nothing yet that needs it.
