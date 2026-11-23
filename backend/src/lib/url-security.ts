/**
 * Outbound-URL safety for server-initiated HTTP calls (issue #1849).
 *
 * The backend fetches URLs that registered users supply. Without validation
 * that is a server-side request forgery primitive: the server can be pointed at
 * itself, at RFC1918 neighbours, or at a cloud metadata service
 * (`https://169.254.169.254/latest/meta-data/`), and the response body is then
 * readable by whoever can watch the delivery logs.
 *
 * Two checks are exposed:
 *  - `assertSafeWebhookTarget` for registration/update time, and
 *  - the same function re-invoked per delivery attempt, because a hostname can
 *    answer differently between registration and the actual request (DNS
 *    rebinding).
 *
 * Redirects are never followed (see `deliverWebhook`), so a public host cannot
 * bounce the request into a blocked range.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from './api-error.js';

/** Injection seam so tests can answer for a hostname without a resolver. */
export type LookupFn = (hostname: string) => Promise<string[]>;

export const ERROR_CODE = 'WEBHOOK_URL_INVALID';

function invalid(message: string, details?: unknown): ApiError {
  return new ApiError(400, ERROR_CODE, message, details);
}

/** Resolve a hostname to every address a caller could connect to. */
export const systemLookup: LookupFn = async (hostname) => {
  // `verbatim: true` keeps Node's resolver from accepting legacy inet_aton
  // shapes (`127.1`, `0177.0.0.1`) that would bypass the literal checks.
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

function ipv4Octets(ip: string): number[] {
  return ip.split('.').map(Number);
}

function isDecimalOctet(label: string): boolean {
  return /^\d{1,3}$/.test(label) && Number(label) <= 255;
}

/**
 * Expand an IPv6 literal to its 16 bytes.
 *
 * Written out by hand because the string forms differ: `isIP` accepts
 * `::ffff:127.0.0.1`, WHATWG `URL` prints the same address back as
 * `::ffff:7f00:1`, and a prefix test on the text would answer differently for
 * the two. Every check that follows works on bytes so the answer cannot depend
 * on how the address happened to be spelled.
 */
function ipv6ToBytes(input: string): number[] | null {
  let value = input.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  // More than one `::` is not a valid address, and neither is `:::`.
  if (value.indexOf('::') !== value.lastIndexOf('::')) return null;

  // A trailing dotted quad stands in for the final two groups.
  if (value.includes('.')) {
    const start = value.lastIndexOf(':') + 1;
    const octets = value.slice(start).split('.');
    if (octets.length !== 4 || !octets.every(isDecimalOctet)) return null;
    const hi = ((Number(octets[0]) << 8) | Number(octets[1])).toString(16);
    const lo = ((Number(octets[2]) << 8) | Number(octets[3])).toString(16);
    value = `${value.slice(0, start)}${hi}:${lo}`;
  }

  const toHextets = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const part of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  const compressed = value.includes('::');
  const head = toHextets(compressed ? value.split('::')[0]! : value);
  const tail = toHextets(compressed ? (value.split('::')[1] ?? '') : '');
  if (head === null || tail === null) return null;

  if (!compressed) {
    if (head.length !== 8) return null;
    return head.flatMap((h) => [(h >> 8) & 0xff, h & 0xff]);
  }
  if (head.length + tail.length > 7) return null;
  const zeros = Array.from({ length: 8 - head.length - tail.length }, () => 0);
  return [...head, ...zeros, ...tail].flatMap((h) => [(h >> 8) & 0xff, h & 0xff]);
}

const isZero = (bytes: number[], from: number, to: number): boolean =>
  bytes.slice(from, to).every((byte) => byte === 0);

/**
 * The IPv4 carried inside an IPv6 address, for the transition mechanisms whose
 * payload a dual-stack host will really route: IPv4-compatible (`::/96`,
 * deprecated but still answered by some resolvers), mapped (`::ffff/96`),
 * 6to4 (`2002::/16`), and NAT64 (`64:ff9b::/96`).
 */
function embeddedIpv4(bytes: number[]): string | null {
  if (isZero(bytes, 0, 12)) return bytes.slice(12, 16).join('.');
  if (isZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12, 16).join('.');
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6).join('.');
  // Written `64:ff9b::/96`, so the leading zero byte of the `0064` group is
  // part of the prefix and the payload starts at byte 12.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    isZero(bytes, 4, 12)
  ) {
    return bytes.slice(12, 16).join('.');
  }
  return null;
}

/**
 * Addresses a server-initiated request must never reach. Covers loopback,
 * RFC1918, link-local (incl. cloud metadata), unique-local, multicast, and the
 * reserved ranges a provider or load balancer may answer with.
 */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ipv4Octets(ip);
    if (a === undefined || b === undefined) return true;
    return (
      a === 0 || // 0.0.0.0/8 "this network" (incl. 0.0.0.0)
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // RFC6598 CGNAT
      (a === 169 && b === 254) || // link-local: 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 TEST-NET-1
      (a === 192 && b === 168) || // RFC1918
      (a === 198 && (b === 18 || b === 19)) || // RFC2544 benchmarking
      (a === 198 && b === 51) || // TEST-NET-2
      (a === 203 && b === 113) || // TEST-NET-3
      a >= 224 // multicast (224/4) and reserved (240/4), incl. 255.255.255.255
    );
  }

  if (isIP(ip) === 6) {
    const bytes = ipv6ToBytes(ip);
    if (bytes === null) return true; // parsable by isIP but not by us: fail closed

    const v4 = embeddedIpv4(bytes);
    if (v4 !== null) return isBlockedAddress(v4);

    return (
      (bytes[0]! & 0xfe) === 0xfc || // fc00::/7 unique local
      (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
      bytes[0] === 0xff || // ff00::/12 multicast
      (bytes[0] === 0x01 && bytes[1] === 0x00 && isZero(bytes, 2, 8)) || // 100::/64 discard
      (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) // 2001::/32 Teredo
    );
  }

  // Not a parsable IP at all — treat as unsafe rather than guess.
  return true;
}

/**
 * Names that mean "this machine" or "the provider's key store" regardless of
 * what a resolver answers: RFC 6761 special-use (`localhost`), mDNS (`.local`),
 * and the private-use `.internal` / `.metadata.goog` zones a cloud instance is
 * configured to resolve. They are refused by name because the address they
 * resolve to is not the point — a requester-controlled resolver can return a
 * public IP for them and still serve loopback on the other side of it.
 */
function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.metadata.goog')
  );
}

/**
 * Reject hosts that are not real domain names: IPv4 dotted quads and the
 * decimal (`2130706433`), hex (`0x7f000001`), or short dotted (`127.1`) forms
 * that some resolvers and middleboxes fold back into `127.0.0.1`. Bracketed
 * IPv6 literals are left to `isBlockedAddress`, which can read their ranges.
 */
function isNumericHostForm(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (/^\d+$/.test(host)) return true; // decimal integer
  if (/^0x[0-9a-f]+$/.test(host)) return true; // hex integer
  if (/^0[0-9a-fx.]*$/.test(host) && host !== '0') return true; // octal / 0-prefixed
  const labels = host.split('.');
  // A real domain always ends in an alphabetic TLD; an all-numeric label set is
  // an inet_aton-style IP literal (127.1, 10.1.1, 0x7f.0.0.1).
  if (labels.length > 0 && labels.every((label) => /^[0-9a-fx]+$/.test(label))) {
    return true;
  }
  return false;
}

/**
 * Validate a webhook target: HTTPS only, no credentials, no IP-shaped or
 * numeric-encoded host, and every address the name resolves to must be
 * publicly routable.
 */
export async function assertSafeWebhookTarget(
  rawUrl: string,
  lookup: LookupFn = systemLookup,
): Promise<URL> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw invalid('Webhook URL must be a non-empty string');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalid('Webhook URL is not a valid absolute URL');
  }

  if (url.protocol !== 'https:') {
    throw invalid('Webhook URL must use HTTPS');
  }

  if (url.username || url.password) {
    throw invalid('Webhook URL must not embed credentials');
  }

  // `URL.hostname` strips the brackets from IPv6 literals; keep both forms.
  const rawHost = url.hostname;
  const hostname = rawHost.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (hostname.length === 0) {
    throw invalid('Webhook URL must have a hostname');
  }

  if (isBlockedHostname(hostname)) {
    throw invalid(
      'Webhook URL host must not be a loopback, local-network, or metadata service name',
      { hostname, reason: 'blocked_hostname' },
    );
  }

  if (isNumericHostForm(rawHost)) {
    throw invalid(
      'Webhook URL host must be a domain name or a plain IP address',
      { hostname: rawHost, reason: 'encoded_ip' },
    );
  }

  const addresses = isIP(hostname) ? [hostname] : await lookup(hostname);

  if (!addresses || addresses.length === 0) {
    throw invalid('Webhook URL host does not resolve', { hostname });
  }

  const blocked = addresses.filter((address) => isBlockedAddress(address));
  if (blocked.length > 0) {
    throw invalid(
      'Webhook URL resolves to a blocked private, loopback, link-local, or metadata address',
      { hostname, addresses: blocked },
    );
  }

  return url;
}
