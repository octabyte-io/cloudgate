/**
 * **Moved to `components/console/` by F15.**
 *
 * `ResourceSpec`, `ResourceList`, `ResourceFormModal` and `DeleteResourceModal`
 * were F10's, built for an Application's four child lists. F15 is the fifth
 * through eighth consumer — registries, destinations, AI providers and twelve
 * notification channels — and none of those belongs to an Application, which is
 * the promotion signal `frontend/docs/design-system.md` names.
 *
 * Re-exported from here so every F10 call site keeps working unchanged.
 */
export type {
  FieldSpec,
  RowColumn,
  ResourceSpec,
} from "@/components/console/resource-spec";
