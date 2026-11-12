import { BadRequestException } from '@nestjs/common';
import {
  MAX_BUCKET_ORIGINS,
  parseBrowserOrigin,
  parseBucketOrigins,
} from '../../src/buckets/bucket-origins';

describe('parseBrowserOrigin', () => {
  it.each([
    'https://app.example.com',
    'http://localhost:3000',
    'https://staging.example.com:8443',
    'http://127.0.0.1:5173',
    'http://[::1]:8080',
  ])('takes %s as a browser sends it', (origin) => {
    expect(parseBrowserOrigin(origin)).toBe(origin);
  });

  it('trims the space around it', () => {
    expect(parseBrowserOrigin('  https://app.example.com ')).toBe(
      'https://app.example.com',
    );
  });

  it.each([
    'app.example.com',
    'https://app.example.com/',
    'https://app.example.com/upload',
    'https://app.example.com?x=1',
    'https://user@app.example.com',
    'https://App.Example.com',
    'https://app.example.com:443',
    'ftp://app.example.com',
    'https://*.example.com',
    'https://a&b.example.com',
    '*',
    '',
  ])('refuses %j, naming it', (origin) => {
    expect(() => parseBrowserOrigin(origin)).toThrow(BadRequestException);
    expect(() => parseBrowserOrigin(origin)).toThrow(
      /is not a web origin — write it as a browser sends it/,
    );
  });
});

describe('parseBucketOrigins', () => {
  it('keeps a repeat once, in the order written', () => {
    expect(
      parseBucketOrigins([
        'https://b.example.com',
        'https://a.example.com',
        'https://b.example.com',
      ]),
    ).toEqual(['https://b.example.com', 'https://a.example.com']);
  });

  it('takes an empty list: no browser uploads', () => {
    expect(parseBucketOrigins([])).toEqual([]);
  });

  it(`refuses more than ${MAX_BUCKET_ORIGINS}`, () => {
    const many = Array.from(
      { length: MAX_BUCKET_ORIGINS + 1 },
      (_, i) => `https://h${i}.example.com`,
    );
    expect(() => parseBucketOrigins(many)).toThrow(
      `A bucket trusts at most ${MAX_BUCKET_ORIGINS} origins`,
    );
  });
});
