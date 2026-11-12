import { listComposeVolumes } from '../../src/compose/compose.utils';

/**
 * The volumes a stack's Delete removes (`docker compose down --volumes`), as
 * Docker names them, which a plan's destroy line names (ADR-0069).
 */
describe('listComposeVolumes', () => {
  const file = [
    'services:',
    '  db:',
    '    image: postgres:18',
    '    volumes: [data:/var/lib/postgresql/data]',
    'volumes:',
    '  data:',
    '  cache: {}',
    '  named:',
    '    name: analytics-uploads',
    '  shared:',
    '    external: true',
  ].join('\n');

  it('names each declared volume under the project, or by its own name, never an external one', () => {
    expect(
      listComposeVolumes(file, 'compose-analytics-x1', 'docker-compose'),
    ).toEqual([
      'compose-analytics-x1_data',
      'compose-analytics-x1_cache',
      'analytics-uploads',
    ]);
  });

  it('names none for a stack, whose docker stack rm removes no volume', () => {
    expect(listComposeVolumes(file, 'compose-analytics-x1', 'stack')).toEqual(
      [],
    );
  });

  it('names none for a file that declares none, or does not parse', () => {
    expect(
      listComposeVolumes(
        'services:\n  a:\n    image: x\n',
        'p',
        'docker-compose',
      ),
    ).toEqual([]);
    expect(listComposeVolumes('services: [', 'p', 'docker-compose')).toEqual(
      [],
    );
  });
});
