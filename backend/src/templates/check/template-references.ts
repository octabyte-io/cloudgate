/**
 * The `{{…}}` references a template's fixed values and config file text may
 * make (ADR-0064): `{{NAME}}` for another input, and `{{domains.<name>.url}}`
 * or `{{domains.<name>.host}}` for a Domain, where `<name>` is a compose
 * service listed in `domains` or an own `web`'s Config name.
 *
 * Exported for the setup service, which fills them in on the same reading
 * the check approved.
 */
export type TemplateReference =
  | { readonly kind: 'input'; readonly name: string }
  | {
      readonly kind: 'domain';
      readonly name: string;
      readonly part: 'url' | 'host';
    };

/** One `{{…}}` as written, and the reference it makes, or null when none. */
export interface WrittenReference {
  readonly written: string;
  readonly reference: TemplateReference | null;
}

const BRACES = /\{\{(.*?)\}\}/g;
const INPUT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOMAIN = /^domains\.([a-z][a-z0-9-]*)\.(url|host)$/;

/** Every `{{…}}` in `text`, in order. No whitespace is trimmed inside. */
export function referencesIn(text: string): WrittenReference[] {
  return [...text.matchAll(BRACES)].map(([written, inside]) => {
    if (INPUT.test(inside)) {
      return { written, reference: { kind: 'input', name: inside } };
    }
    const domain = DOMAIN.exec(inside);
    if (domain) {
      return {
        written,
        reference: {
          kind: 'domain',
          name: domain[1],
          part: domain[2] as 'url' | 'host',
        },
      };
    }
    return { written, reference: null };
  });
}

export const REFERENCE_FORMS =
  '{{NAME}}, {{domains.<name>.url}} or {{domains.<name>.host}}';
