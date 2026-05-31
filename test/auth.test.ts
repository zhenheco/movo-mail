import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
  type KeyLike,
  type JWTVerifyGetKey,
} from "jose";
import { Hono } from "hono";

import { accessAuth, ACCESS_JWT_HEADER } from "../src/middleware/access";
import type { AccessEnv } from "../src/middleware/access";
import type { Env, Mailbox } from "../src/types";

// Mock the data layer so the middleware's `getMailboxByAddress` import resolves
// to a controllable stub. A static named import binds directly to the module
// export, so we mock the module rather than spy on a namespace object.
vi.mock("../src/db", () => ({
  getMailboxByAddress: vi.fn(),
}));
import { getMailboxByAddress } from "../src/db";
const getMailboxByAddressMock = vi.mocked(getMailboxByAddress);

/**
 * Cloudflare Access JWT verification tests.
 *
 * We mint our own RS256 key pair and feed its public half to the middleware as
 * a local JWKS resolver (the `jwksResolver` injection seam). jose resolves the
 * remote JWKS through its own fetch, which a test fetch stub cannot intercept,
 * so a local resolver is the reliable seam. Each case signs a token
 * (valid / expired / wrong-aud / etc.) and asserts the middleware accepts or
 * rejects it, and that the mailbox lookup gates access.
 */

const TEAM_DOMAIN = "https://movo-test.cloudflareaccess.com";
const AUD = "test-aud-tag-1234567890";
const KID = "test-key-1";

let privateKey: KeyLike;
let jwksResolver: JWTVerifyGetKey;

/** Build the minimal Env the middleware reads. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as Env["DB"],
    MAIL_R2: {} as Env["MAIL_R2"],
    MAIL_KV: {} as Env["MAIL_KV"],
    ASSETS: {} as Env["ASSETS"],
    CF_EMAIL_ENDPOINT: "https://cf-email.example.workers.dev",
    CF_EMAIL_API_KEY: "test-key",
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    AI_API_KEY: "test-ai-key",
    FALLBACK_FORWARD: "fallback@movo.com.my",
    ...overrides,
  };
}

/** A fully-populated mailbox row for the happy path. */
function mailbox(address: string): Mailbox {
  return {
    id: "mbx_1",
    address,
    display_name: "Test",
    owner_id: "usr_1",
    created_at: 0,
    updated_at: 0,
  };
}

interface TokenOpts {
  aud?: string | string[];
  iss?: string;
  email?: string;
  sub?: string;
  name?: string;
  expSecondsFromNow?: number;
  kid?: string;
}

/** Sign a token with the test private key. */
async function signToken(opts: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expSecondsFromNow ?? 3600);
  return new SignJWT({
    email: opts.email ?? "alice@movo.com.my",
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
    .setIssuedAt(now)
    .setSubject(opts.sub ?? "sub-alice")
    .setIssuer(opts.iss ?? TEAM_DOMAIN)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(exp)
    .sign(privateKey);
}

/** Build a Hono app guarded by accessAuth, exposing a probe route. */
function buildApp() {
  const app = new Hono<AccessEnv>();
  app.use("*", accessAuth({ jwksResolver }));
  app.get("/probe", (c) => {
    const user = c.get("user");
    return c.json({ ok: true, user });
  });
  return app;
}

/** Fire a request through the app with the given token in the header. */
async function call(token: string | null, env: Env) {
  const headers: Record<string, string> = {};
  if (token !== null) headers[ACCESS_JWT_HEADER] = token;
  return buildApp().fetch(
    new Request("https://mail.movo.com.my/probe", { headers }),
    env,
  );
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256", {
    extractable: true,
  });
  privateKey = priv;
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
  jwksResolver = createLocalJWKSet({ keys: [publicJwk] });
});

beforeEach(() => {
  // Default: a provisioned mailbox exists. Cases that need otherwise override.
  getMailboxByAddressMock.mockResolvedValue(mailbox("alice@movo.com.my"));
});

afterEach(() => {
  getMailboxByAddressMock.mockReset();
});

describe("accessAuth", () => {
  it("accepts a valid token and sets the user + resolves the mailbox", async () => {
    const token = await signToken();
    const res = await call(token, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      user: { sub: string; email: string };
    };
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe("alice@movo.com.my");
    expect(body.user.sub).toBe("sub-alice");
    expect(getMailboxByAddressMock).toHaveBeenCalledWith(
      expect.anything(),
      "alice@movo.com.my",
    );
  });

  it("rejects a missing token with 401 JSON", async () => {
    const res = await call(null, makeEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("rejects an expired token with 401", async () => {
    const token = await signToken({ expSecondsFromNow: -60 });
    const res = await call(token, makeEnv());
    expect(res.status).toBe(401);
  });

  it("rejects a token with the wrong audience with 401", async () => {
    const token = await signToken({ aud: "some-other-aud" });
    const res = await call(token, makeEnv());
    expect(res.status).toBe(401);
  });

  it("rejects a token with the wrong issuer with 401", async () => {
    const token = await signToken({ iss: "https://evil.cloudflareaccess.com" });
    const res = await call(token, makeEnv());
    expect(res.status).toBe(401);
  });

  it("rejects a garbage / unsigned token with 401", async () => {
    const res = await call("not.a.real.jwt", makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the verified email has no mailbox", async () => {
    getMailboxByAddressMock.mockResolvedValue(null);
    const token = await signToken({ email: "stranger@movo.com.my" });
    const res = await call(token, makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns 401 (not 500) when the token has no email claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt(now)
      .setSubject("sub-noemail")
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUD)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    const res = await call(token, makeEnv());
    expect(res.status).toBe(401);
  });
});
