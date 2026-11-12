import type { TemplateOnPlan } from "@/lib/api/endpoints/project-config";

/**
 * A Template part's create on a plan: where it comes from, how each value
 * its setup holds is made, and, for a compose part, its Domains on their
 * picked hosts; for any part, the config files it mounts (#1373). Never a
 * value or a file's text (ADR-0064, ADR-0019).
 */
export function TemplateLines({ template }: { template: TemplateOnPlan }) {
  return (
    <div
      aria-label="From a template"
      className="grid gap-0.5 text-meta text-tx-2"
    >
      <p>
        From the {template.templateName} template, set up as{" "}
        <span className="font-mono">{template.setupName}</span>.
      </p>
      {template.values.length > 0 ? (
        <ul className="grid gap-0.5">
          {template.values.map((value) => (
            <li key={`${value.list}.${value.variable}`}>
              <span className="font-mono">
                {value.list}.{value.variable}
              </span>{" "}
              {value.made}
            </li>
          ))}
        </ul>
      ) : null}
      {template.domains?.map((domain) => (
        <p key={`${domain.host}${domain.path}`}>
          Domain{" "}
          <span className="font-mono">
            {domain.host}
            {domain.path === "/" ? "" : domain.path}
          </span>{" "}
          to {domain.service}:{domain.port}
        </p>
      ))}
      {template.files?.map((file) => (
        <p key={file.path}>
          File <span className="font-mono">{file.path}</span>
          {file.mount ? (
            <>
              {" "}
              mounted at <span className="font-mono">{file.mount}</span>
            </>
          ) : null}
        </p>
      ))}
    </div>
  );
}
