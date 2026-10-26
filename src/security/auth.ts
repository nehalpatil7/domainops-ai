import { createRemoteJWKSet, jwtVerify } from "jose";
import { DomainError } from "../domain/errors";

export type AuthenticatedUser = { id: string; email: string | null };
type AuthEnv = Env & { AUTH_MODE?: string; CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string };
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateRequest(
  request: Request,
  env: AuthEnv,
): Promise<AuthenticatedUser> {
  const url = new URL(request.url);
  if (env.AUTH_MODE === "development" || isLocalDevelopmentHost(url.hostname))
    return { id: "development-user", email: "local@domainops.invalid" };
  if (env.AUTH_MODE !== "cloudflare_access")
    throw new DomainError(
      "AUTH_NOT_CONFIGURED",
      "Authentication is not configured. Set AUTH_MODE=cloudflare_access before deployment.",
      503,
    );
  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !audience)
    throw new DomainError(
      "AUTH_NOT_CONFIGURED",
      "Cloudflare Access requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.",
      503,
    );
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? accessCookie(request);
  if (!token)
    throw new DomainError("AUTHENTICATION_REQUIRED", "Sign in with Cloudflare Access.", 401);
  try {
    let keySet = keySets.get(teamDomain);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
      keySets.set(teamDomain, keySet);
    }
    const { payload } = await jwtVerify(token, keySet, {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
    });
    if (!payload.sub) throw new Error("Access token has no subject.");
    return { id: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
  } catch {
    throw new DomainError("INVALID_ACCESS_TOKEN", "Cloudflare Access authentication failed.", 401);
  }
}

function normalizeTeamDomain(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.startsWith("https://") ? value : `https://${value}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
function accessCookie(request: Request): string | null {
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}
function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "domainops.test";
}
