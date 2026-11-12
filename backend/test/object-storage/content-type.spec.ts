import { contentTypeOf } from '../../src/object-storage/content-type';

describe('contentTypeOf', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/app.JS', 'text/javascript; charset=utf-8'],
    ['assets/site.css', 'text/css; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['fonts/inter.woff2', 'font/woff2'],
    ['app.wasm', 'application/wasm'],
  ])('uploads %s as %s, as nginx serves it on a Server', (file, type) => {
    expect(contentTypeOf(file)).toBe(type);
  });

  it("uploads a file with no known extension as nginx's default type", () => {
    expect(contentTypeOf('LICENSE')).toBe('application/octet-stream');
    expect(contentTypeOf('data.bin')).toBe('application/octet-stream');
  });
});
