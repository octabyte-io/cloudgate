import { parseProjectConfig } from '../format/parse-config';
import type { ProjectConfig } from '../project-config.types';
import type { ConfigOutline } from './plan.types';

/** What a config lists — names, kinds, console-managed or not — and nothing else. */
export function outlineOf(config: ProjectConfig): ConfigOutline {
  return {
    services: Object.fromEntries(
      Object.entries(config.services).map(([name, entry]) => [
        name,
        {
          kind: entry.kind,
          managed: entry.managed === 'console' ? 'console' : false,
        },
      ]),
    ),
  };
}

/** A text's outline, or `null` when it does not parse. */
export function outlineOfText(text: string): ConfigOutline | null {
  const parsed = parseProjectConfig(text);
  return parsed.ok ? outlineOf(parsed.config) : null;
}
