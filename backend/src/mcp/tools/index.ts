import type { AnyTool } from '../tool-definition';
import { HEALTH_TOOLS } from './health.tools';
import { METRICS_TOOLS } from './metrics.tools';
import { NAVIGATION_TOOLS } from './navigation.tools';
import { PREVIEW_TOOLS } from './preview.tools';
import { PROJECT_CONFIG_TOOLS } from './project-config.tools';
import { RUNTIME_LOG_TOOLS } from './runtime-log.tools';
import { SERVICE_TOOLS } from './service.tools';
import { WRITE_TOOLS } from './write.tools';

/**
 * Every tool the MCP endpoint serves, in the order `tools/list` shows them.
 * The only list: `McpModule` builds the `ToolRegistry` from it and the censuses
 * walk it. The eleven of the spec's tool table and the six Requested-preview
 * tools, `get_service_health`, `get_service_metrics`, and the Project
 * config tools; the count is frozen.
 */
export const MCP_TOOLS: readonly AnyTool[] = [
  ...NAVIGATION_TOOLS,
  ...SERVICE_TOOLS,
  ...HEALTH_TOOLS,
  ...METRICS_TOOLS,
  ...WRITE_TOOLS,
  ...PREVIEW_TOOLS,
  ...PROJECT_CONFIG_TOOLS,
  // read_runtime_log, behind the Agent's Can read runtime logs switch.
  ...RUNTIME_LOG_TOOLS,
];
