import { DomainError } from "../domain/errors";
import { normalizeHostname } from "../domain/validation";

const blockedSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

export function validateLiveHostname(value: unknown): string {
  const hostname = normalizeHostname(value);
  if (blockedSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw DomainError.invalid("Live diagnostics do not allow reserved or internal hostnames.", {
      hostname,
    });
  }
  return hostname;
}

export function isPublicIpAddress(value: string): boolean {
  const address = value.trim().toLowerCase();
  if (address.includes(".")) {
    const mapped = address.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPublicIpv4(mapped[1]);
  }
  if (!address.includes(":")) return false;
  if (!isValidIpv6(address)) return false;
  if (address === "::" || address === "::1") return false;
  if (address.startsWith("fc") || address.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(address)) return false;
  if (address.startsWith("ff")) return false;
  if (address.startsWith("2001:db8")) return false;
  return true;
}

function isValidIpv6(value: string): boolean {
  if (!/^[0-9a-f:]+$/.test(value) || value.includes(":::")) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function isPublicIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && octets[2] === 2) return false;
  if (first === 192 && second === 88 && octets[2] === 99) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first >= 224) return false;
  if (first === 192 && second === 0 && octets[2] === 0) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && octets[2] === 100) return false;
  if (first === 203 && second === 0 && octets[2] === 113) return false;
  return true;
}
