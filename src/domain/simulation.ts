import type {
  DnsRecord,
  DnsStatus,
  HostnameStatus,
  RevalidationOutcome,
  SimulationProfile,
  SslStatus,
  ValidationRecord,
  ValidationState,
} from "./types";

export type SimulationState = {
  expectedDnsRecords: DnsRecord[];
  observedDnsRecords: DnsRecord[];
  requiredValidationRecords: ValidationRecord[];
  dnsStatus: DnsStatus;
  hostnameStatus: HostnameStatus;
  sslStatus: SslStatus;
  validationState: ValidationState;
};

export function expectedDnsRecords(hostname: string, target: string): DnsRecord[] {
  return [{ type: "CNAME", name: hostname, value: target, ttl: 300 }];
}

export function validationRecords(
  hostname: string,
  status: ValidationRecord["status"],
): ValidationRecord[] {
  const token = hostname.replace(/[^a-z0-9]/g, "-");
  return [
    {
      purpose: "hostname_ownership",
      type: "TXT",
      name: `_cf-custom-hostname.${hostname}`,
      value: `cf-custom-hostname=sim-${token}`,
      status,
    },
    {
      purpose: "certificate",
      type: "TXT",
      name: `_acme-challenge.${hostname}`,
      value: `sim-dcv-${token}`,
      status,
    },
  ];
}

export function initialSimulationState(
  hostname: string,
  target: string,
  profile: SimulationProfile,
  observedDnsRecord?: string | null,
): SimulationState {
  const expected = expectedDnsRecords(hostname, target);
  const defaultObserved = profile === "incorrect_dns" ? "legacy-origin.customer.example" : target;
  const observed =
    observedDnsRecord === null
      ? []
      : [{ ...expected[0], value: observedDnsRecord ?? defaultObserved }];
  const dnsMatches = observed.some(
    (record) =>
      record.type === expected[0].type &&
      record.name === expected[0].name &&
      record.value === expected[0].value,
  );
  if (!dnsMatches) {
    return state(
      expected,
      observed,
      "invalid",
      "pending",
      "pending_validation",
      "dns_misconfigured",
      validationRecords(hostname, "pending"),
    );
  }

  switch (profile) {
    case "active":
      return state(
        expected,
        observed,
        "valid",
        "active",
        "active",
        "active",
        validationRecords(hostname, "valid"),
      );
    case "incorrect_dns":
      return state(
        expected,
        observed,
        "invalid",
        "pending",
        "pending_validation",
        "dns_misconfigured",
        validationRecords(hostname, "pending"),
      );
    case "pending_ssl":
      return state(
        expected,
        observed,
        "valid",
        "active",
        "pending_issuance",
        "pending_ssl",
        validationRecords(hostname, "valid"),
      );
    case "validation_failure":
      return state(
        expected,
        observed,
        "valid",
        "blocked",
        "validation_timed_out",
        "failed",
        validationRecords(hostname, "failed"),
      );
  }
}

export function evaluateRevalidation(
  hostname: string,
  profile: SimulationProfile,
  attempt: number,
): RevalidationOutcome {
  if (profile === "pending_ssl" && attempt >= 1) {
    return {
      dnsStatus: "valid",
      hostnameStatus: "active",
      sslStatus: "active",
      validationState: "active",
      requiredValidationRecords: validationRecords(hostname, "valid"),
      diagnosticCode: "DOMAIN_READY",
      message: "Simulated certificate issuance and deployment completed.",
    };
  }

  const current = initialSimulationState(hostname, "customers.domainops.example", profile);
  const diagnostics: Record<SimulationProfile, [string, string]> = {
    active: ["DOMAIN_READY", "Simulated DNS, hostname, and SSL checks remain healthy."],
    incorrect_dns: [
      "DNS_TARGET_MISMATCH",
      "Observed CNAME does not match the expected SaaS target.",
    ],
    pending_ssl: ["SSL_PENDING", "Simulated certificate issuance is still pending."],
    validation_failure: [
      "HOSTNAME_VALIDATION_FAILED",
      "Simulated hostname validation remains blocked.",
    ],
  };
  const [diagnosticCode, message] = diagnostics[profile];
  return {
    dnsStatus: current.dnsStatus,
    hostnameStatus: current.hostnameStatus,
    sslStatus: current.sslStatus,
    validationState: current.validationState,
    requiredValidationRecords: current.requiredValidationRecords,
    diagnosticCode,
    message,
  };
}

export function isDomainReady(
  dnsStatus: DnsStatus,
  hostnameStatus: HostnameStatus,
  sslStatus: SslStatus,
  validationState: ValidationState,
): boolean {
  return (
    dnsStatus === "valid" &&
    hostnameStatus === "active" &&
    sslStatus === "active" &&
    validationState === "active"
  );
}

function state(
  expectedDnsRecords: DnsRecord[],
  observedDnsRecords: DnsRecord[],
  dnsStatus: DnsStatus,
  hostnameStatus: HostnameStatus,
  sslStatus: SslStatus,
  validationState: ValidationState,
  requiredValidationRecords: ValidationRecord[],
): SimulationState {
  return {
    expectedDnsRecords,
    observedDnsRecords,
    dnsStatus,
    hostnameStatus,
    sslStatus,
    validationState,
    requiredValidationRecords,
  };
}
