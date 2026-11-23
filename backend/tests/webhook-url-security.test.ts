import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api-error.js';
import {
  ERROR_CODE,
  assertSafeWebhookTarget,
  isBlockedAddress,
  type LookupFn,
} from '../src/lib/url-security.js';

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700:4700::1111';

const resolver =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses;

// Shape rejects must prove they never reach a resolver: if the guard depended on
// DNS for these inputs, this lookup surfaces as a non-ApiError and fails the test.
const neverLookup: LookupFn = async (hostname: string): Promise<string[]> => {
  throw new Error(`webhook guard must not query DNS for ${hostname}`);
};

async function expectRejected(
  rawUrl: string,
  lookup: LookupFn = neverLookup,
): Promise<void> {
  let thrown: unknown;
  try {
    await assertSafeWebhookTarget(rawUrl, lookup);
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  const error = thrown as ApiError;
  expect(error.statusCode).toBe(400);
  expect(error.code).toBe('WEBHOOK_URL_INVALID');
}

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1',
    '127.2.3.4',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.5.4',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '100.127.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '100::',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '2002:a9fe:a9fe::',
    'not-an-ip',
    '',
  ];
  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  const allowed = [
    PUBLIC_V4,
    '8.8.8.8',
    '172.15.0.1',
    '100.63.255.255',
    '100.128.0.1',
    PUBLIC_V6,
    '2001:4860:4860::42',
  ];
  it.each(allowed)('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertSafeWebhookTarget rejects private-range IP literals without DNS', () => {
  it('exposes WEBHOOK_URL_INVALID as the error code', () => {
    expect(ERROR_CODE).toBe('WEBHOOK_URL_INVALID');
  });

  const blockedIpv4Urls = [
    'https://127.0.0.1/',
    'https://127.2.3.4/',
    'https://10.0.0.1/',
    'https://10.255.255.255/',
    'https://172.16.5.4/',
    'https://192.168.1.1/',
    'https://169.254.169.254/',
    'https://169.254.169.254/latest/meta-data/',
    'https://0.0.0.0/',
    'https://100.64.0.1/',
  ];
  it.each(blockedIpv4Urls)('rejects %s', (rawUrl) =>
    expectRejected(rawUrl),
  );

  const blockedIpv6Urls = [
    'https://[::1]/',
    'https://[::]/',
    'https://[fe80::1]/',
    'https://[fc00::1]/',
    'https://[ff02::1]/',
    'https://[2002:a9fe:a9fe::]/',
  ];
  it.each(blockedIpv6Urls)('rejects %s', (rawUrl) =>
    expectRejected(rawUrl),
  );
});

describe('assertSafeWebhookTarget rejects obfuscated numeric host encodings by shape', () => {
  const encodedIpUrls = [
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0x7f.0.0.1/',
    'https://127.1/',
    'https://10.1/',
    'https://2852039166/',
    'https://0xa9fea9fe/',
    'https://2130706433./',
    'https://0x7f000001./',
    'https://169.254.169.254./',
    'https://127.1./',
  ];
  it.each(encodedIpUrls)('rejects %s without a resolver', (rawUrl) =>
    expectRejected(rawUrl),
  );
});

describe('assertSafeWebhookTarget validates hostnames only through the injected lookup', () => {
  const blockedResolutions: ReadonlyArray<{
    url: string;
    addresses: string[];
  }> = [
    { url: 'https://evil.example/', addresses: ['169.254.169.254'] },
    { url: 'https://srv.internal.corp/', addresses: ['10.255.255.255'] },
    { url: 'https://printer.home.arpa/', addresses: ['192.168.1.1'] },
    { url: 'https://carrier.example/', addresses: ['100.64.0.1'] },
    { url: 'https://link.example/', addresses: ['fe80::1'] },
    { url: 'https://dual.example/', addresses: [PUBLIC_V4, '127.0.0.1'] },
    { url: 'https://ula.example/', addresses: ['fd00::1'] },
  ];
  it.each(blockedResolutions)('rejects $url when DNS answers $addresses', ({ url, addresses }) =>
    expectRejected(url, resolver(...addresses)),
  );

  it('rejects a hostname that resolves to nothing', () =>
    expectRejected('https://gone.example/', resolver()),
  );

  it('accepts evil.example when the injected lookup returns a public IP', async () => {
    const parsed = await assertSafeWebhookTarget(
      'https://evil.example/hook',
      resolver(PUBLIC_V4),
    );
    expect(parsed).toBeInstanceOf(URL);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('evil.example');
    expect(parsed.pathname).toBe('/hook');
  });

  const acceptedHosts: ReadonlyArray<{ url: string; addresses: string[] }> = [
    { url: 'https://good.example/webhook', addresses: [PUBLIC_V6] },
    { url: 'https://both.example/', addresses: [PUBLIC_V4, PUBLIC_V6] },
  ];
  it.each(acceptedHosts)('accepts $url when DNS answers only public IPs', ({ url, addresses }) =>
    expect(
      assertSafeWebhookTarget(url, resolver(...addresses)),
    ).resolves.toBeInstanceOf(URL),
  );
});

describe('assertSafeWebhookTarget rejects non-HTTPS schemes and bad authorities', () => {
  const malformed = [
    'http://good.example/',
    'http://2130706433/',
    'https://user:pass@good.example/',
    'https://user@good.example/',
    'not a url at all',
    '',
    'https://',
    'https://:8080/x',
  ];
  it.each(malformed)('rejects %j', (rawUrl) => expectRejected(rawUrl));
});

describe('assertSafeWebhookTarget blocks loopback and metadata hostnames by name, before DNS', () => {
  // neverLookup throws, so a rejection here proves the guard refused the name
  // rather than trusting whatever a requester-controlled resolver answered.
  const blockedNames = [
    'https://localhost/',
    'https://localhost:8443/hook',
    'https://svc.localhost/',
    'https://api.localhost/',
    'https://hook.local/',
    'https://metadata.google.internal/latest/meta-data/',
    'https://gce_metadata.metadata.goog/',
    'https://LOCALHOST./',
  ];
  it.each(blockedNames)('rejects %s without a resolver', (rawUrl) =>
    expectRejected(rawUrl),
  );

  // A name on the list stays blocked even if DNS would have returned a
  // routable address — the resolution result must not be able to rescue it.
  it.each(['https://localhost/', 'https://metadata.google.internal/'])(
    'rejects %s even when DNS answers a public IP',
    (rawUrl) => expectRejected(rawUrl, resolver(PUBLIC_V4)),
  );

  it('leaves unrelated domains that merely contain "localhost" or "internal" to DNS', async () => {
    await expect(
      assertSafeWebhookTarget('https://localhost.example.com/', resolver(PUBLIC_V4)),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeWebhookTarget('https://internal-payments.example/', resolver(PUBLIC_V6)),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe('IPv6 literals are read as bytes, so spelling cannot dodge a range', () => {
  const sameLoopback: string[] = [
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ];
  it.each(sameLoopback)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  const sameMetadata: string[] = [
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '2002:a9fe:a9fe::',
    '64:ff9b::a9fe:a9fe',
  ];
  it.each(sameMetadata)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  const samePrivate: string[] = [
    '::ffff:10.1.2.3',
    '2002:0a01:0203::',
    '64:ff9b::10.1.2.3',
  ];
  it.each(samePrivate)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  // fc00::/7 covers both halves; the older prefix test only caught fc.
  it('blocks the whole unique-local block, not just fc00::', () => {
    for (const ip of ['fc00::1', 'fd00::1', 'fd12:3456::1', 'fdff:ffff::1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('blocks fe80::/10 without blocking fe40::/8 neighbours', () => {
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('febf::1')).toBe(true);
    expect(isBlockedAddress('fec0::1')).toBe(false);
  });

  const urlsForSameAddresses: string[] = [
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:169.254.169.254]/',
    'https://[fd00::1]/',
    'https://[febf::1]/',
    'https://[2002:a9fe:a9fe::]/',
  ];
  it.each(urlsForSameAddresses)('rejects %s without a resolver', (rawUrl) =>
    expectRejected(rawUrl),
  );

  it('accepts a bracketed literal that maps to a public IPv4', async () => {
    await expect(
      assertSafeWebhookTarget('https://[::ffff:8.8.8.8]/', neverLookup),
    ).resolves.toBeInstanceOf(URL);
  });

  it('fails closed on an IPv6-shaped host it cannot expand', () => {
    // Neither is a valid address, so neither may be guessed at a range.
    expect(isBlockedAddress('::ffff:127.0.0.256')).toBe(true);
    expect(isBlockedAddress('1:2:3:4:5:6:7:8:9')).toBe(true);
  });
});
