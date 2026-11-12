import { staticStrategy } from '../../src/builders/strategies/static.strategy';

describe('staticStrategy.getProgram', () => {
  it('assembles an nginx image serving the publish directory', () => {
    const { command } = staticStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      buildNonce: 'nonce123456',
      publishDirectory: 'dist',
    });

    expect(command).toBe(
      `mkdir -p "/apps/web/code";
echo "LmdpdAouZW52CkRvY2tlcmZpbGUKLmRvY2tlcmlnbm9yZQ==" | base64 -d > "/apps/web/code/.dockerignore";
mkdir -p "/apps/web/code";
echo "RlJPTSBuZ2lueDphbHBpbmUKV09SS0RJUiAvdXNyL3NoYXJlL25naW54L2h0bWwvCkNPUFkgZGlzdCAuCkNNRCBbIm5naW54IiwgIi1nIiwgImRhZW1vbiBvZmY7Il0=" | base64 -d > "/apps/web/code/Dockerfile";
echo 'Building web' ;
cd /apps/web/code/ || {
  echo '❌ The path /apps/web/code/ does not exist' ;
  exit 1;
}
docker build -t web -f /apps/web/code/Dockerfile . || {
  echo "❌ Docker build failed" ;
  exit 1;
}
echo "✅ Docker build completed." ;`,
    );
  });

  it('adds SPA fallback nginx config and serves the code root when no publish directory is set', () => {
    const { command } = staticStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      buildNonce: 'nonce123456',
      isStaticSpa: true,
    });

    expect(command).toBe(
      `mkdir -p "/apps/web/code";
echo "Cndvcmtlcl9wcm9jZXNzZXMgMTsKCmV2ZW50cyB7CiAgd29ya2VyX2Nvbm5lY3Rpb25zIDEwMjQ7Cn0KCmh0dHAgewogIGluY2x1ZGUgbWltZS50eXBlczsKICBkZWZhdWx0X3R5cGUgIGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbTsKCiAgYWNjZXNzX2xvZyAvZGV2L3N0ZG91dDsKICBlcnJvcl9sb2cgL2Rldi9zdGRlcnI7CgogIHNlcnZlciB7CiAgICBsaXN0ZW4gODA7CiAgICBsb2NhdGlvbiAvIHsKICAgICAgcm9vdCAgIC91c3Ivc2hhcmUvbmdpbngvaHRtbDsKICAgICAgaW5kZXggIGluZGV4Lmh0bWwgaW5kZXguaHRtOwogICAgICB0cnlfZmlsZXMgJHVyaSAkdXJpLyAvaW5kZXguaHRtbDsKICAgIH0KICB9Cn0K" | base64 -d > "/apps/web/code/nginx.conf";
mkdir -p "/apps/web/code";
echo "LmdpdAouZW52CkRvY2tlcmZpbGUKLmRvY2tlcmlnbm9yZQ==" | base64 -d > "/apps/web/code/.dockerignore";
mkdir -p "/apps/web/code";
echo "RlJPTSBuZ2lueDphbHBpbmUKV09SS0RJUiAvdXNyL3NoYXJlL25naW54L2h0bWwvCkNPUFkgbmdpbnguY29uZiAvZXRjL25naW54L25naW54LmNvbmYKQ09QWSAuIC4KQ01EIFsibmdpbngiLCAiLWciLCAiZGFlbW9uIG9mZjsiXQ==" | base64 -d > "/apps/web/code/Dockerfile";
echo 'Building web' ;
cd /apps/web/code/ || {
  echo '❌ The path /apps/web/code/ does not exist' ;
  exit 1;
}
docker build -t web -f /apps/web/code/Dockerfile . || {
  echo "❌ Docker build failed" ;
  exit 1;
}
echo "✅ Docker build completed." ;`,
    );
  });
});
