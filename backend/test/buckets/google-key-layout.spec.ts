import {
  googleKeyAddresses,
  googleKeyLayout,
} from '../../src/buckets/google-key-layout';

const KEY = { accessKeyId: 'GOOG1NEW', secretAccessKey: 'new-secret' };

/**
 * Which key slots a bucket on Cloud Storage's state holds, read off
 * its row, so every definition of it writes those and no other.
 */
describe('googleKeyLayout', () => {
  it('is the one key in the first slot for a bucket never rotated', () => {
    expect(
      googleKeyLayout({ googleKeySlot: null, rotationKeys: null }),
    ).toEqual({ live: 'key', spare: false });
  });

  it('is the one key in the slot a rotation moved it to', () => {
    expect(
      googleKeyLayout({ googleKeySlot: 'key_b', rotationKeys: null }),
    ).toEqual({ live: 'key_b', spare: false });
  });

  it('holds the other slot too while a rotation keeps its new key there', () => {
    expect(
      googleKeyLayout({
        googleKeySlot: null,
        rotationKeys: { newKey: KEY, strayKeyIds: [] },
      }),
    ).toEqual({ live: 'key', spare: true });
  });

  it('holds the other slot too while a key there could not be destroyed', () => {
    expect(
      googleKeyLayout({
        googleKeySlot: 'key_b',
        rotationKeys: { newKey: null, strayKeyIds: ['GOOG1OLD'] },
      }),
    ).toEqual({ live: 'key_b', spare: true });
  });

  it('holds only the live slot once a rotation kept nothing apart', () => {
    expect(
      googleKeyLayout({
        googleKeySlot: 'key_b',
        rotationKeys: { newKey: null, strayKeyIds: [] },
      }),
    ).toEqual({ live: 'key_b', spare: false });
  });
});

/** A Delete's key destroy names every slot that holds one. */
describe('googleKeyAddresses', () => {
  it('is the live slot alone without a spare', () => {
    expect(googleKeyAddresses({ live: 'key', spare: false })).toEqual([
      'google_storage_hmac_key.key',
    ]);
    expect(googleKeyAddresses({ live: 'key_b', spare: false })).toEqual([
      'google_storage_hmac_key.key_b',
    ]);
  });

  it('is both slots, the live one first, with a spare', () => {
    expect(googleKeyAddresses({ live: 'key_b', spare: true })).toEqual([
      'google_storage_hmac_key.key_b',
      'google_storage_hmac_key.key',
    ]);
  });
});
