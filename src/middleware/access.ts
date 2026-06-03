/**
 * Cloudflare Access authentication middleware.
 *
 * Verifies the Access JWT presented in the `Cf-Access-Jwt-Assertion` header
 * (Access also sets a cookie, but the header is the canonical source) against
 * the team's JWKS at `${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, checking
 * the `aud` claim equals `CF_ACCESS_AUD`. On success the decoded identity is
 * stored on the context as `c.set('user', AccessUser)`; otherwise responds 401.
 */

import type { MiddlewareHandler } from "hono";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { Env, AccessUser } from "../types";
import { getMailboxesForUser, getUserRole } from "../db";

/** Hono variable map populated by this middleware. */
export interface AccessVariables {
  user: AccessUser;
}

/** Hono environment for routes guarded by Access. */
export interface AccessEnv {
  Bindings: Env;
  Variables: AccessVariables;
}

/** The `Cf-Access-Jwt-Assertion` request header name. */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** Cookie Access sets in browsers as a fallback to the assertion header. */
const ACCESS_COOKIE = "CF_Authorization";

/** Options for {@link accessAuth}; the resolver seam is for tests only. */
export interface AccessAuthOptions {
  /**
   * Key resolver used to verify the JWT signature. Defaults to a cached remote
   * JWKS resolver pointed at the team certs URL. Tests inject a local resolver
   * (e.g. jose's `createLocalJWKSet`) because jose fetches the remote JWKS
   * through its own fetch reference, which test fetch stubs cannot intercept.
   */
  jwksResolver?: JWTVerifyGetKey;
}

/**
 * Module-level cache of remote JWKS resolvers, keyed by certs URL. jose's
 * createRemoteJWKSet keeps its own in-memory cache + cooldown, so reusing the
 * instance per team domain avoids re-fetching the keys on every request.
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

/** Get (or lazily build) the remote JWKS resolver for a team certs URL. */
function getRemoteJwks(certsUrl: string): JWTVerifyGetKey {
  const cached = jwksCache.get(certsUrl);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(certsUrl));
  jwksCache.set(certsUrl, jwks);
  return jwks;
}

/** Extract the raw JWT from the assertion header or the Access cookie. */
function readToken(headers: Headers): string | null {
  const header = headers.get(ACCESS_JWT_HEADER);
  if (header && header.trim().length > 0) return header.trim();

  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (rawName?.trim() === ACCESS_COOKIE) {
      const value = rest.join("=").trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Pull a non-empty string claim, or null if absent / wrong type. */
function stringClaim(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build the Access-verifying middleware.
 *
 * On success: verifies the JWT signature against the team JWKS, checks
 * `aud === env.CF_ACCESS_AUD` and `iss === env.CF_ACCESS_TEAM_DOMAIN`, maps the
 * verified email to a mailbox, then sets `c.set('user', { sub, email, name })`.
 * On any verification failure returns 401; a verified NON-ADMIN without a
 * mailbox returns 403. A verified ADMIN with no mailbox is allowed through so
 * they can bootstrap the first mailbox from the settings panel — this grants no
 * data, as every resource route is still ownership/role-scoped. Errors never
 * leak internal details to the client.
 */
export function accessAuth(
  options: AccessAuthOptions = {},
): MiddlewareHandler<AccessEnv> {
  return async (c, next) => {
    const token = readToken(c.req.raw.headers);
    if (!token) {
      return c.json({ error: "Authentication required." }, 401);
    }

    let payload: JWTPayload;
    try {
      const jwks =
        options.jwksResolver ??
        getRemoteJwks(`${c.env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      const verified = await jwtVerify(token, jwks, {
        audience: c.env.CF_ACCESS_AUD,
        issuer: c.env.CF_ACCESS_TEAM_DOMAIN,
      });
      payload = verified.payload;
    } catch {
      // Covers bad signature, expired, wrong aud/iss, malformed token, and
      // JWKS fetch failures. Never surface the underlying reason.
      return c.json({ error: "Invalid or expired session." }, 401);
    }

    const email = stringClaim(payload, "email");
    const sub = payload.sub;
    if (!email || typeof sub !== "string" || sub.length === 0) {
      return c.json({ error: "Invalid or expired session." }, 401);
    }

    // Authorize on mailbox OWNERSHIP, not on the login email being a mailbox
    // address. A user signs in with their personal identity (e.g. a Gmail
    // address) and is granted access if they own at least one mailbox
    // (mailboxes.owner_id -> users.id). Matching the login email against a
    // mailbox ADDRESS would wrongly reject every legitimate user whose identity
    // differs from the mailbox name.
    let ownsMailbox: boolean;
    try {
      const mailboxes = await getMailboxesForUser(c.env, email);
      ownsMailbox = mailboxes.length > 0;
    } catch {
      return c.json({ error: "Unable to verify your account." }, 401);
    }
    if (!ownsMailbox) {
      // A zero-mailbox ADMIN must still pass so they can create the first
      // mailbox from the settings panel; otherwise the only bootstrap path is a
      // manual D1 write. Non-admins with no mailbox are denied as before.
      let role: string | null;
      try {
        role = await getUserRole(c.env, email);
      } catch {
        return c.json({ error: "Unable to verify your account." }, 401);
      }
      if (role !== "admin") {
        return c.json(
          { error: "No mailbox is provisioned for this account." },
          403,
        );
      }
    }

    const name = stringClaim(payload, "name");
    const user: AccessUser =
      name !== null ? { sub, email, name } : { sub, email };
    c.set("user", user);

    await next();
    return;
  };
}
