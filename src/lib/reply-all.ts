import type { BccProvenance, EmailAddress } from "../types";

/** The only confirmation accepted for a Reply All with unavailable Bcc data. */
export const REPLY_ALL_BCC_CONFIRMATION = "confirmed-missing-original-bcc";

export interface ReplyAllInput {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  bccProvenance: BccProvenance;
}

export interface ReplyAllOptions {
  bccConfirmation?: string;
  typedBcc?: EmailAddress[];
}

export type ReplyAllResult =
  | { ok: true; to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] }
  | {
      ok: false;
      code:
        | "invalid_recipient"
        | "reply_all_bcc_confirmation_required"
        | "reply_all_no_recipients";
    };

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function addressValue(value: EmailAddress): string {
  return value.address.trim();
}

function isValidAddress(value: EmailAddress): boolean {
  if (!value || typeof value !== "object" || typeof value.address !== "string") {
    return false;
  }
  if (Object.keys(value).some((key) => key !== "address" && key !== "name")) {
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.address.trim())) {
    return false;
  }
  return value.name === undefined ||
    (typeof value.name === "string" && value.name.trim().length > 0);
}

function ownAddressSet(values: readonly (EmailAddress | string)[]): Set<string> {
  return new Set(
    values
      .map((value) =>
        typeof value === "string" ? value : value.address,
      )
      .map(normalized)
      .filter(Boolean),
  );
}

/**
 * Build Reply All's three delivery buckets. The source order is deliberate:
 * sender, visible To, visible Cc, then Bcc. That makes a visible occurrence
 * win over a later hidden duplicate without ever moving Bcc into a visible
 * bucket.
 */
export function buildReplyAllRecipients(
  input: ReplyAllInput,
  ownAddresses: readonly (EmailAddress | string)[],
  options: ReplyAllOptions = {},
): ReplyAllResult {
  const own = ownAddressSet(ownAddresses);
  const seen = new Set<string>();
  const to: EmailAddress[] = [];
  const cc: EmailAddress[] = [];
  const bcc: EmailAddress[] = [];

  const typedBcc = options.typedBcc ?? [];
  if (
    ![
      input.from,
      ...input.to,
      ...input.cc,
      ...input.bcc,
      ...typedBcc,
    ].every(isValidAddress)
  ) {
    return { ok: false, code: "invalid_recipient" };
  }

  const bccValues =
    input.bccProvenance === "unavailable"
      ? options.bccConfirmation === REPLY_ALL_BCC_CONFIRMATION &&
        typedBcc.length > 0
        ? typedBcc
        : null
      : input.bccProvenance === "known-nonempty"
        ? input.bcc
        : [];

  if (bccValues === null) {
    return { ok: false, code: "reply_all_bcc_confirmation_required" };
  }

  const add = (bucket: EmailAddress[], value: EmailAddress): void => {
    const address = addressValue(value);
    const folded = normalized(address);
    if (!folded || own.has(folded) || seen.has(folded)) return;
    seen.add(folded);
    bucket.push(address === value.address ? { ...value } : { ...value, address });
  };

  add(to, input.from);
  for (const value of input.to) add(to, value);
  for (const value of input.cc) add(cc, value);
  for (const value of bccValues) add(bcc, value);

  if (to.length === 0) {
    const promoted = cc.shift() ?? bcc.shift();
    if (promoted) to.push(promoted);
  }

  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    return { ok: false, code: "reply_all_no_recipients" };
  }

  return { ok: true, to, cc, bcc };
}

/** Build the sender-only Reply recipient bucket. */
export function buildReplyRecipients(
  from: EmailAddress,
  ownAddresses: readonly (EmailAddress | string)[] = [],
): ReplyAllResult {
  const own = ownAddressSet(ownAddresses);
  const address = addressValue(from);
  if (!address || own.has(normalized(address))) {
    return { ok: false, code: "reply_all_no_recipients" };
  }
  return { ok: true, to: [{ ...from, address }], cc: [], bcc: [] };
}
