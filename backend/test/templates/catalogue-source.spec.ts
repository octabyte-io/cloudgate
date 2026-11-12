import { catalogueSource } from '../../src/templates/catalogue-source';

/** The official address, written out rather than imported (§1.7). */
const OFFICIAL =
  'https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip';

const MIRROR = 'https://mirror.example.internal/catalogue.zip';

describe('catalogueSource', () => {
  it('reads the official catalogue when nothing is set', () => {
    expect(catalogueSource({ url: undefined, oldBaseUrl: undefined })).toEqual({
      on: true,
      url: OFFICIAL,
    });
  });

  it('reads the address CLOUDGATE_TEMPLATES_URL names, whatever the old setting says', () => {
    expect(catalogueSource({ url: MIRROR, oldBaseUrl: undefined })).toEqual({
      on: true,
      url: MIRROR,
    });
    expect(
      catalogueSource({ url: MIRROR, oldBaseUrl: 'https://old.example' }),
    ).toEqual({ on: true, url: MIRROR });
  });

  it('is off on off, saying so and naming the catalogue.zip a mirror serves', () => {
    expect(
      catalogueSource({ url: 'off', oldBaseUrl: 'https://old.example' }),
    ).toEqual({
      on: false,
      message:
        'Templates are turned off on this instance: CLOUDGATE_TEMPLATES_URL is off. Remove the setting to use the official catalogue, or set it to the address of a catalogue.zip.',
    });
  });

  it('is off while only the old setting is set, with ADR-0066 sentence', () => {
    expect(
      catalogueSource({ url: undefined, oldBaseUrl: 'https://old.example' }),
    ).toEqual({
      on: false,
      message:
        '`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read. Set `CLOUDGATE_TEMPLATES_URL`, or remove the old setting to use the official catalogue.',
    });
  });
});
