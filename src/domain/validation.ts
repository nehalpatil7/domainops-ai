import { DomainError } from "./errors";
import { simulationProfiles, type RegisterDomainInput, type SimulationProfile } from "./types";

const hostnamePattern =
  /^(?=.{1,253}\.?$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;
const workspacePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export function normalizeHostname(value: unknown, field = "hostname"): string {
  if (typeof value !== "string") throw DomainError.invalid(`${field} must be a string.`);
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!hostnamePattern.test(hostname)) {
    throw DomainError.invalid(`${field} must be a valid fully-qualified hostname.`, { field });
  }
  return hostname;
}

export function validateWorkspaceId(value: string): string {
  if (!workspacePattern.test(value)) {
    throw DomainError.invalid(
      "workspaceId must be 1-64 lowercase letters, numbers, underscores, or hyphens.",
      {
        field: "workspaceId",
      },
    );
  }
  return value;
}

export function validateDomainId(value: string): string {
  if (!identifierPattern.test(value)) {
    throw DomainError.invalid("domainId must be a UUID.", { field: "domainId" });
  }
  return value;
}

export function validateIdempotencyKey(value: string | null): string {
  if (!value || !idempotencyPattern.test(value)) {
    throw DomainError.invalid("Idempotency-Key must be 8-128 URL-safe characters.", {
      field: "Idempotency-Key",
    });
  }
  return value;
}

export function parseRegisterDomainInput(value: unknown): Omit<
  Required<RegisterDomainInput>,
  "observedDnsRecord"
> & {
  observedDnsRecord: string | null | undefined;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw DomainError.invalid("Request body must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const hostname = normalizeHostname(input.hostname);
  const expectedDnsTarget = normalizeHostname(
    input.expectedDnsTarget ?? "customers.domainops.example",
    "expectedDnsTarget",
  );
  const observedDnsRecord =
    input.observedDnsRecord === undefined
      ? undefined
      : input.observedDnsRecord === null
        ? null
        : normalizeHostname(input.observedDnsRecord, "observedDnsRecord");
  const simulationProfile = input.simulationProfile ?? "pending_ssl";
  if (
    typeof simulationProfile !== "string" ||
    !simulationProfiles.includes(simulationProfile as SimulationProfile)
  ) {
    throw DomainError.invalid("simulationProfile is not supported.", {
      allowed: [...simulationProfiles],
    });
  }

  return {
    hostname,
    expectedDnsTarget,
    observedDnsRecord,
    simulationProfile: simulationProfile as SimulationProfile,
  };
}
