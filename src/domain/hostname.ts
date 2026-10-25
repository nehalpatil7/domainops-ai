export function normalizeHostname(input: string): string {
  const hostname = input.trim().toLowerCase().replace(/\.$/, "");

  if (!hostname) {
    throw new Error("Enter a hostname.");
  }

  if (hostname.includes("://") || hostname.includes("/") || hostname.includes(":")) {
    throw new Error("Enter a hostname without a protocol, path, or port.");
  }

  if (hostname.length > 253) {
    throw new Error("Hostname must be 253 characters or fewer.");
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    throw new Error("Enter a fully qualified hostname such as app.example.com.");
  }

  const validLabel = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  if (!labels.every((label) => validLabel.test(label))) {
    throw new Error("Hostname contains an invalid DNS label.");
  }

  return hostname;
}
