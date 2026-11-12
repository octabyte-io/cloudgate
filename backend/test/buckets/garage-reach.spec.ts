import {
  garageRelayProgram,
  readRelayPort,
} from '../../src/buckets/garage-reach';

describe('garageRelayProgram', () => {
  // shell-quote escapes `:` and `,`, which the shell reads as themselves.
  it("opens a loopback-only relay to the bucket's Garage on cloudgate-network, pinned, and says its port", () => {
    expect(garageRelayProgram('bucket-abc123').split('\n')).toEqual([
      'set -e',
      'docker rm -f bucket-abc123-s3-relay >/dev/null 2>&1 || true',
      'docker run -d --rm --name bucket-abc123-s3-relay --network cloudgate-network -p 127.0.0.1::3900 alpine/socat\\:1.8.0.3 TCP-LISTEN\\:3900\\,fork\\,reuseaddr TCP\\:bucket-abc123\\:3900 >/dev/null',
      'docker port bucket-abc123-s3-relay 3900/tcp',
    ]);
  });
});

describe('readRelayPort', () => {
  it('reads the loopback port Docker gave the relay', () => {
    expect(readRelayPort('127.0.0.1:49153\n')).toBe(49153);
  });

  it('takes no binding off loopback, and nothing from an empty answer', () => {
    expect(readRelayPort('0.0.0.0:49153\n[::]:49153\n')).toBeNull();
    expect(readRelayPort('')).toBeNull();
  });
});
