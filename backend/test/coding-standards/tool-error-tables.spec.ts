import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FINALITY_SENTENCE } from '../../src/mcp/mcp-answers';
import { answerFor } from '../../src/mcp/tool-errors';
import { MCP_TOOLS } from '../../src/mcp/tools';
import {
  ACCESS_NOT_GRANTED_CODE,
  NOT_A_MEMBER_CODE,
} from '../../src/rbac/permission.service';

/**
 * Every tool's error table, against the refusals it has to fold into one
 * answer (ADR-0024).
 *
 * An id-addressed tool must answer its target's 404 **and** each
 * `*_ACCESS_NOT_GRANTED` 403 with `grant` — the one byte-identical
 * `Not found or not permitted` — or a missing id and an ungranted one become
 * distinguishable, which is an oracle over another Organization's ids. The
 * codes are written out here rather than read from `ACCESS_NOT_GRANTED_CODE`,
 * and the two are held equal, so a fourth code added there reds until every
 * table is checked against it.
 *
 * The tables are exercised through `answerFor`, the function the dispatcher
 * calls, with real Nest exceptions shaped the way `PermissionService` throws
 * them — so "maps" means what the dispatcher would do, not what a table says.
 */

const GRANT_CODES = [
  'PROJECT_ACCESS_NOT_GRANTED',
  'ENVIRONMENT_ACCESS_NOT_GRANTED',
  'SERVICE_ACCESS_NOT_GRANTED',
];

/** Tools with no target id: a list whose unknown scope lists nothing. */
const FROZEN_NOT_ID_ADDRESSED = ['list_projects', 'list_environments'];

describe('answerFor', () => {
  it('knows every row-level refusal code PermissionService publishes', () => {
    expect(Object.values(ACCESS_NOT_GRANTED_CODE).sort()).toEqual(
      [...GRANT_CODES].sort(),
    );
  });

  it('holds the tools that are not id-addressed to the frozen list', () => {
    expect(
      MCP_TOOLS.filter((tool) => !tool.targetId).map((tool) => tool.name),
    ).toEqual(FROZEN_NOT_ID_ADDRESSED);
  });

  it("maps an id-addressed tool's 404 and every *_ACCESS_NOT_GRANTED to grant", () => {
    const unmapped = MCP_TOOLS.filter((tool) => tool.targetId).flatMap(
      (tool) => {
        const refusals = [
          ['404', new NotFoundException('Environment not found')],
          ...GRANT_CODES.map((code) => [
            code,
            new ForbiddenException({ message: "You don't have access", code }),
          ]),
        ] as const;
        return refusals
          .filter(([, error]) => answerFor(tool.errors, error) !== 'grant')
          .map(([label]) => `${tool.name}: ${label}`);
      },
    );
    expect(unmapped).toEqual([]);
  });

  it('maps no role refusal and no missing membership: those are not grant decisions', () => {
    const swallowed = MCP_TOOLS.flatMap((tool) =>
      [
        new ForbiddenException('Permission denied'),
        new ForbiddenException({
          message: 'Permission denied',
          code: NOT_A_MEMBER_CODE,
        }),
      ]
        .filter((error) => answerFor(tool.errors, error) !== null)
        .map((error) => `${tool.name}: ${error.message}`),
    );
    expect(swallowed).toEqual([]);

    // The shape that would swallow them: a 403 entry with no code.
    const uncoded = MCP_TOOLS.flatMap((tool) =>
      tool.errors
        .filter(
          (entry) =>
            entry.exception === ForbiddenException && entry.code === undefined,
        )
        .map(() => tool.name),
    );
    expect(uncoded).toEqual([]);
  });

  it('declares no failure text that carries the finality sentence', () => {
    const final = MCP_TOOLS.flatMap((tool) =>
      tool.errors
        .map((entry) => entry.answer)
        .filter(
          (answer): answer is { failed: string } =>
            typeof answer === 'object' &&
            answer.failed.includes(FINALITY_SENTENCE),
        )
        .map(() => tool.name),
    );
    expect(final).toEqual([]);
  });
});
