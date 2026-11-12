import { parseProjectConfig } from '../../src/project-config';
import type { ConfigRefusal, ProjectConfig } from '../../src/project-config';

/**
 * A `kind: cron` entry, as the parser reads it: a `web`'s build
 * fields without `port`, a required `command` and `schedule`, and an
 * optional `timezone` and `timeout`.
 */
function cron(fields: string): string {
  const lines = ['kind: cron', 'command: node dist/report.js', fields]
    .filter((line) => line !== '')
    .join('\n')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `version: 1\nservices:\n  report:\n${lines}\n`;
}

function parsed(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function refused(text: string): ConfigRefusal {
  const result = parseProjectConfig(text);
  if (result.ok) throw new Error('parsed, but a refusal was expected');
  return result.refusal;
}

const schedule = (expression: string) =>
  `schedule: ${JSON.stringify(expression)}`;

describe('parseProjectConfig', () => {
  describe('a kind: cron entry', () => {
    it('reads a Cron service in backend field names, leaving out what it leaves out', () => {
      const config = parsed(
        cron(
          [
            'schedule: "0 3 * * *"',
            'source:\n  github: acme/reports',
            'build:\n  type: dockerfile',
            'args: [--all]',
            'size: small',
            'env: [DATABASE_URL]',
          ].join('\n'),
        ),
      );

      expect(config.services.report).toEqual({
        kind: 'cron',
        managed: false,
        command: 'node dist/report.js',
        args: ['--all'],
        schedule: '0 3 * * *',
        source: { sourceType: 'github', repository: 'acme/reports' },
        build: { buildType: 'dockerfile' },
        size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
        env: ['DATABASE_URL'],
        buildArgs: [],
        buildSecrets: [],
      });
    });

    it('reads timezone and timeout', () => {
      const entry = parsed(
        cron(
          `${schedule('30 2 * * *')}\ntimezone: Europe/Berlin\ntimeout: 90m`,
        ),
      ).services.report;
      expect(entry).toMatchObject({
        timezone: 'Europe/Berlin',
        timeoutSeconds: 5400,
      });
    });

    describe('required fields', () => {
      it('refuses an entry with no command', () => {
        expect(
          refused(
            'version: 1\nservices:\n  report:\n    kind: cron\n    schedule: "0 3 * * *"\n',
          ),
        ).toEqual({
          reason: 'invalid',
          at: 'report.command',
          message: 'report.command is required',
        });
      });

      it('refuses an entry with no schedule', () => {
        expect(refused(cron(''))).toEqual({
          reason: 'invalid',
          at: 'report.schedule',
          message: 'report.schedule is required',
        });
      });
    });

    describe('schedule', () => {
      it.each([
        ['0 3 * * *'],
        ['*/15 * * * *'],
        ['0 9-17/2 * * MON-FRI'],
        ['0 0 1,15 * *'],
        ['0 0 * JAN,JUL *'],
        ['30 4 * * sun'],
        ['0 0 * * 7'],
        ['0 12 * * WED'],
      ])('accepts %j', (expression) => {
        expect(
          parsed(cron(schedule(expression))).services.report,
        ).toMatchObject({ schedule: expression });
      });

      it.each([
        [
          'seconds',
          '0 0 3 * * *',
          'has six fields; seconds and a year are not taken',
        ],
        [
          'a year',
          '0 3 * * * 2026',
          'has six fields; seconds and a year are not taken',
        ],
        [
          'seconds and a year',
          '0 0 3 * * * 2026',
          'has seven fields; seconds and a year are not taken',
        ],
        ['?', '0 3 ? * *', 'uses ?, which is not taken'],
        ['L', '0 3 L * *', 'uses L, which is not taken'],
        ['W', '0 3 15W * *', 'uses W, which is not taken'],
        ['#', '0 3 * * MON#2', 'uses #, which is not taken'],
        [
          'an @ shortcut',
          '@daily',
          'uses the shortcut @daily, which is not taken',
        ],
        [
          'both day fields restricted',
          '0 3 1 * MON',
          'restricts both day-of-month and day-of-week',
        ],
        [
          'a value out of range',
          '61 3 * * *',
          'has 61 in its minute field, outside 0-59',
        ],
        [
          'a backwards range',
          '0 17-9 * * *',
          'has the range 17-9 in its hour field, which runs backwards',
        ],
        [
          'a word that is no name',
          '0 3 * * FUN',
          'has "FUN" in its day-of-week field',
        ],
        ['too few fields', '0 3 * *', 'has 4 fields'],
      ])('refuses %s, naming it', (_what, expression, says) => {
        const refusal = refused(cron(schedule(expression)));
        expect(refusal).toMatchObject({
          reason: 'invalid',
          at: 'report.schedule',
        });
        expect(refusal.message).toContain(`report.schedule ${says}`);
      });
    });

    describe('timezone', () => {
      it.each(['UTC', 'America/New_York', 'America/Argentina/Buenos_Aires'])(
        'accepts the IANA name %s',
        (timezone) => {
          expect(
            parsed(cron(`${schedule('0 3 * * *')}\ntimezone: ${timezone}`))
              .services.report,
          ).toMatchObject({ timezone });
        },
      );

      it.each(['EST', '+01:00', 'Mars/Olympus_Mons', 'Berlin'])(
        'refuses %s, which is not an IANA name',
        (timezone) => {
          expect(
            refused(cron(`${schedule('0 3 * * *')}\ntimezone: "${timezone}"`)),
          ).toEqual({
            reason: 'invalid',
            at: 'report.timezone',
            message:
              'report.timezone must be an IANA time zone name, e.g. Europe/Berlin or UTC',
          });
        },
      );
    });

    describe('timeout', () => {
      it('is left out when unstated, the planner reading 1h', () => {
        expect(
          parsed(cron(schedule('0 3 * * *'))).services.report,
        ).not.toHaveProperty('timeoutSeconds');
      });

      it.each([
        ['30m', 1800],
        ['2h', 7200],
        ['24h', 86400],
        ['1440m', 86400],
      ])('reads %s as %i seconds', (timeout, seconds) => {
        expect(
          parsed(cron(`${schedule('0 3 * * *')}\ntimeout: ${timeout}`)).services
            .report,
        ).toMatchObject({ timeoutSeconds: seconds });
      });

      it.each(['25h', '1441m'])(
        'refuses %s, over the 24h maximum',
        (timeout) => {
          expect(
            refused(cron(`${schedule('0 3 * * *')}\ntimeout: ${timeout}`)),
          ).toEqual({
            reason: 'invalid',
            at: 'report.timeout',
            message: 'report.timeout is longer than the 24h a run may take',
          });
        },
      );

      it.each(['30', '1d', '0m', '90s', '1h30m', '1.5h'])(
        'refuses %j, which is not minutes or hours',
        (timeout) => {
          expect(
            refused(cron(`${schedule('0 3 * * *')}\ntimeout: "${timeout}"`)),
          ).toEqual({
            reason: 'invalid',
            at: 'report.timeout',
            message:
              'report.timeout must be a duration in minutes or hours, e.g. 30m or 2h',
          });
        },
      );
    });

    it('refuses port, which a Cron service does not have', () => {
      expect(refused(cron(`${schedule('0 3 * * *')}\nport: 3000`))).toEqual({
        reason: 'invalid',
        at: 'report.port',
        message: 'report.port: it is not a field Cloudgate knows',
      });
    });

    it.each(['overlap: skip', 'retries: 3', 'paused: true'])(
      'refuses %s, a field it does not have',
      (field) => {
        const name = field.split(':')[0];
        expect(
          refused(cron(`${schedule('0 3 * * *')}\n${field}`)),
        ).toMatchObject({
          reason: 'invalid',
          at: `report.${name}`,
        });
      },
    );

    it('names cron among the kinds version 1 describes', () => {
      expect(
        refused('version: 1\nservices:\n  x:\n    kind: lambda\n').message,
      ).toContain(
        '(web, web-private, static, worker, postgres, mysql, redis, cron, bucket, compose)',
      );
    });
  });
});
