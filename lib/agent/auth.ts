import { createPublicKey, verify as verifySignature } from "node:crypto";

type GitHubJwk = JsonWebKey & { kid: string; kty: string; use?: string; alg?: string };
type GitHubClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  repository?: string;
  ref?: string;
  workflow_ref?: string;
  event_name?: string;
};

let jwksCache: { expiresAt: number; keys: GitHubJwk[] } | null = null;

async function getGitHubSigningKeys(): Promise<GitHubJwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;

  const response = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("GitHub OIDC signing keys unavailable");
  const body = await response.json() as { keys?: GitHubJwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("GitHub OIDC signing keys are invalid");
  }
  jwksCache = { keys: body.keys, expiresAt: Date.now() + 5 * 60 * 1000 };
  return body.keys;
}

/**
 * Accept either Vercel Cron's CRON_SECRET bearer or a short-lived GitHub
 * Actions OIDC token issued specifically for this agent. The GitHub token is
 * pinned to this repository, main branch, workflow file, and allowed events.
 */
async function isTrustedGitHubActionsToken(token: string): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as {
      alg?: string;
      kid?: string;
    };
    if (header.alg !== "RS256" || !header.kid) return false;

    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as GitHubClaims;
    const now = Math.floor(Date.now() / 1000);
    const audience = claims.aud;
    if (
      claims.iss !== "https://token.actions.githubusercontent.com" ||
      !(audience === "koki-agent" || (Array.isArray(audience) && audience.includes("koki-agent"))) ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      typeof claims.iat !== "number" ||
      claims.iat > now + 60 ||
      claims.repository !== "joachimnosike371-rgb/Koki" ||
      claims.ref !== "refs/heads/main" ||
      claims.workflow_ref !== "joachimnosike371-rgb/Koki/.github/workflows/agent-loop.yml@refs/heads/main" ||
      !["schedule", "workflow_dispatch"].includes(claims.event_name ?? "")
    ) return false;

    const keys = await getGitHubSigningKeys();
    const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) {
      jwksCache = null;
      return false;
    }

    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    return verifySignature(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart, "base64url"),
    );
  } catch {
    // Fail closed on malformed tokens, network errors, or invalid signatures.
    return false;
  }
}

export async function isAuthorizedAgentRequest(request: Request): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (secret && authorization === `Bearer ${secret}`) return true;

  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  return token ? isTrustedGitHubActionsToken(token) : false;
}
