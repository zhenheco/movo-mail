/**
 * Worker inbound SPLIT (catch-all → worker).
 *
 * The CF Email Routing catch-all is repointed at this Worker's email() handler,
 * so EVERY address now arrives here. email() must decide per message:
 *   - recipient IS a managed mailbox (D1) → store it (handleInbound via waitUntil)
 *   - recipient is NOT managed            → forward to FALLBACK_FORWARD so the
 *     prior catch-all→acejou27 behavior is preserved. A non-managed message must
 *     NEVER be dropped.
 *
 * These tests pin that branching contract by mocking the two collaborators
 * (isManagedAddress + handleInbound) and asserting which path runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

// Mock the DB classifier and the storage handler so we observe ONLY the routing
// decision made by email() — not D1/R2 side effects.
// Spread the real module so only isManagedAddress is stubbed. This keeps the
// mocked `../src/db` registry complete — every other export (getMailboxesForUser,
// meRoutes' deps, etc.) stays real — so if vitest's module registry is shared
// with a sibling suite, the partial mock can never leave those exports undefined.
vi.mock("../src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db")>();
  return {
    ...actual,
    isManagedAddress: vi.fn(),
  };
});
vi.mock("../src/email/inbound", () => ({
  handleInbound: vi.fn().mockResolvedValue(undefined),
}));

import worker from "../src/index";
import { isManagedAddress } from "../src/db";
import { handleInbound } from "../src/email/inbound";

const FALLBACK = "acejou27@example.com";

/** A fake ForwardableEmailMessage with the surface email() touches. */
function fakeMessage(to: string, forward = vi.fn().mockResolvedValue(undefined)) {
  return {
    to,
    from: "sender@example.com",
    raw: new ReadableStream<Uint8Array>(),
    rawSize: 0,
    headers: new Headers(),
    forward,
    setReject: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

/** A fake ExecutionContext capturing waitUntil promises so we can await them. */
function fakeCtx() {
  const promises: Promise<unknown>[] = [];
  const waitUntil = vi.fn((p: Promise<unknown>) => {
    promises.push(Promise.resolve(p));
  });
  const ctx = {
    waitUntil,
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waitUntil, settle: () => Promise.allSettled(promises) };
}

const env = { FALLBACK_FORWARD: FALLBACK } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("email() inbound split", () => {
  it("stores managed mail via waitUntil(handleInbound) and does NOT forward", async () => {
    vi.mocked(isManagedAddress).mockResolvedValue(true);
    const forward = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("priss@movo.com.my", forward);
    const { ctx, waitUntil, settle } = fakeCtx();

    await worker.email!(message, env, ctx);
    await settle();

    // Managed → handleInbound runs, exactly one waitUntil, no forward.
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInbound).toHaveBeenCalledWith(message, env);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards non-managed mail to FALLBACK_FORWARD exactly once and does NOT store", async () => {
    vi.mocked(isManagedAddress).mockResolvedValue(false);
    const forward = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("stranger@movo.com.my", forward);
    const { ctx, settle } = fakeCtx();

    await worker.email!(message, env, ctx);
    await settle();

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(FALLBACK);
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it("treats an isManagedAddress failure as non-managed and forwards (never drops)", async () => {
    vi.mocked(isManagedAddress).mockRejectedValue(new Error("D1 down"));
    const forward = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("oops@movo.com.my", forward);
    const { ctx, settle } = fakeCtx();

    await worker.email!(message, env, ctx);
    await settle();

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(FALLBACK);
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it("does not let a forward rejection escape email(), and does NOT also store", async () => {
    vi.mocked(isManagedAddress).mockResolvedValue(false);
    const forward = vi.fn().mockRejectedValue(new Error("forward failed"));
    const message = fakeMessage("stranger@movo.com.my", forward);
    const { ctx, settle } = fakeCtx();

    // The forward path rejected — email() must catch it (no unhandled throw).
    await expect(worker.email!(message, env, ctx)).resolves.toBeUndefined();
    await settle();

    expect(forward).toHaveBeenCalledTimes(1);
    // A forward rejection must NOT fall through into the storage path.
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
