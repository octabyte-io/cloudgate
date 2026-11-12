/**
 * The Template check (spec #1356): one pure checker with three callers —
 * the catalogue reader, the setup service and `cloudgate template check`.
 * The CLI bundles this directory from source (`cli/build.mjs`), so nothing
 * reachable from here may need Nest's container or a database at runtime.
 */
export { checkCatalogue } from './template-check';
export type {
  CatalogueCheck,
  CheckingInstance,
  HiddenTemplate,
  Template,
} from './template-check';
export {
  CATALOGUE_FORMAT,
  CATALOGUE_MAX_BYTES,
  encodeCatalogue,
} from './catalogue-file';
export type { CatalogueFolder } from './catalogue-file';
export { isWebsiteFile } from './catalogue-layout';
export type { TemplateLogo } from './template-logo';
export type { InputRule, TemplateYaml } from './template-yaml';
export { askedValueProblem } from './template-inputs';
export { referencesIn } from './template-references';
export { composeVariables } from './compose-variables';
export type {
  TemplateReference,
  WrittenReference,
} from './template-references';
export { TEMPLATE_RULES } from './template-rules';
export type {
  ComposeFile,
  TemplateReading,
  TemplateRule,
} from './template-rules';
