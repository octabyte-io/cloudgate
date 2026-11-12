import { switchView } from '../../src/databases/postgres/database-switches';

/**
 * The sentence a Service's page shows for a switch asked for (
 * ADR-0033). A switch to an existing database takes two Applies: the first
 * deletes the database Cloudgate made, and only the plan after that Delete
 * adds the existing one. A switch the other way is one Apply.
 */
describe('switchView', () => {
  it('says a switch to an existing database is added by the plan after the Delete', () => {
    const view = switchView(
      {
        to: 'existing',
        identifier: 'acme-prod',
        configName: 'pg',
        kind: 'postgres',
      },
      null,
    );

    expect(view).toEqual({
      to: 'existing',
      identifier: 'acme-prod',
      sentence:
        "The next plan switches pg to the existing database acme-prod: its Apply deletes the database Cloudgate made, as its Delete would, and no data is copied. Once that Delete is done, the next plan's Apply adds acme-prod",
    });
  });

  it('says the same of a cache', () => {
    const view = switchView(
      {
        to: 'existing',
        identifier: 'acme-cache',
        configName: 'cache',
        kind: 'redis',
      },
      null,
    );

    expect(view.sentence).toBe(
      "The next plan switches cache to the existing cache acme-cache: its Apply deletes the cache Cloudgate made, as its Delete would, and no data is copied. Once that Delete is done, the next plan's Apply adds acme-cache",
    );
  });

  it('says a switch to a Cloudgate-made database removes only the records of the one it leaves', () => {
    const view = switchView(
      { to: 'made', identifier: null, configName: 'pg', kind: 'postgres' },
      'acme-prod',
    );

    expect(view).toEqual({
      to: 'made',
      identifier: null,
      sentence:
        "The next plan switches pg to a database Cloudgate makes: its Apply removes only Cloudgate's records of acme-prod, which is left as it was, and no data is copied",
    });
  });
});
