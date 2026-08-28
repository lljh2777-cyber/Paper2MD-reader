import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request, type RequestOptions } from "node:https";

const MAX_REDIRECTS = 3;

export interface SafeAcquisitionResponse {
  finalUrl: string;
  mime: string;
  bytes: Uint8Array;
}

export interface SafeAcquisitionFetchOptions {
  accept: readonly string[];
  maximumBytes: number;
  timeoutMilliseconds: number;
  lookup?: typeof dnsLookup;
}

function ipv4Number(value: string): number | undefined {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}

function inV4Range(value: number, base: string, prefix: number): boolean {
  const start = ipv4Number(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (start & mask);
}

function expandIpv6(value: string): number[] | undefined {
  let normalized = value.toLowerCase().split("%")[0]!;
  const mapped = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = ipv4Number(mapped[2]);
    if (v4 === undefined) return undefined;
    normalized = `${mapped[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right]
    .map((part) => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN);
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : undefined;
}

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value === undefined) return false;
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
    ];
    return !blocked.some(([base, prefix]) => inV4Range(value, base, prefix));
  }
  if (family !== 6) return false;
  const groups = expandIpv6(address);
  if (!groups) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6]! >>> 8}.${groups[6]! & 255}.${groups[7]! >>> 8}.${groups[7]! & 255}`;
    return isPublicInternetAddress(mapped);
  }
  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const first = groups[0]!;
  return !allZero && !loopback
    && (first & 0xfe00) !== 0xfc00
    && (first & 0xffc0) !== 0xfe80
    && (first & 0xff00) !== 0xff00
    && !(first === 0x2001 && groups[1] === 0x0db8)
    && !(first === 0x0064 && groups[1] === 0xff9b);
}

export function assertSafeAcquisitionUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Acquisition URL must be credential-free HTTPS on the default port");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Acquisition URL host is not public");
  }
  if (isIP(hostname) && !isPublicInternetAddress(hostname)) throw new Error("Acquisition URL resolves to a non-public address");
  url.hash = "";
  return url;
}

async function resolvedPublicAddresses(hostname: string, lookup: typeof dnsLookup): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const literalFamily = isIP(hostname);
  const answers = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => !isPublicInternetAddress(answer.address))) {
    throw new Error("Acquisition host did not resolve exclusively to public addresses");
  }
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
}

export function safeAcquisitionConnectionOptions(
  address: { address: string; family: 4 | 6 }
): Pick<RequestOptions, "family" | "lookup"> & { autoSelectFamily: false } {
  return {
    // Node 20+ may ask custom lookup callbacks for every address by passing
    // { all: true }. This request already pins one validated public address,
    // so the legacy single-address callback must opt out of that mode.
    autoSelectFamily: false,
    family: address.family,
    lookup: (_hostname, _lookupOptions, callback) => callback(null, address.address, address.family)
  };
}

function singleRequest(url: URL, options: SafeAcquisitionFetchOptions, address: { address: string; family: 4 | 6 }): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Uint8Array;
}> {
  return new Promise((resolve, reject) => {
    const requestHandle = request(url, {
      method: "GET",
      headers: { Accept: options.accept.join(","), "User-Agent": "Paper2MD-Reader/0.1" },
      ...safeAcquisitionConnectionOptions(address)
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > options.maximumBytes) response.destroy(new Error("Acquisition response exceeds the safe size limit"));
        else chunks.push(chunk);
      });
      response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.once("error", reject);
    });
    requestHandle.setTimeout(options.timeoutMilliseconds, () => requestHandle.destroy(new Error("Acquisition request timed out")));
    requestHandle.once("error", reject);
    requestHandle.end();
  });
}

export async function safeAcquire(value: string, options: SafeAcquisitionFetchOptions): Promise<SafeAcquisitionResponse> {
  let url = assertSafeAcquisitionUrl(value);
  const lookup = options.lookup ?? dnsLookup;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolvedPublicAddresses(hostname, lookup);
    const response = await singleRequest(url, options, addresses[0]!);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Acquisition redirect chain is invalid or too long");
      url = assertSafeAcquisitionUrl(new URL(location, url).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Acquisition provider returned HTTP ${response.status}`);
    const declared = Number(Array.isArray(response.headers["content-length"])
      ? response.headers["content-length"][0] : response.headers["content-length"] ?? 0);
    if (declared > options.maximumBytes) throw new Error("Acquisition response exceeds the safe size limit");
    const contentType = Array.isArray(response.headers["content-type"])
      ? response.headers["content-type"][0] : response.headers["content-type"];
    const mime = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!options.accept.includes(mime)) throw new Error(`Acquisition provider returned unsupported MIME type: ${mime || "missing"}`);
    return { finalUrl: url.href, mime, bytes: response.bytes };
  }
  throw new Error("Acquisition redirect chain is too long");
}
