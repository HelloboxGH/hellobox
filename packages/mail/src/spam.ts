import { getEnv } from "@hellobox/config";
import { domainOf } from "./threading";

export interface SpamVerdict {
  score: number | null;
  symbols: string[];
  reasons: string[];
  isSpam: boolean;
  unscanned: boolean;
}

export const SPAM_SCORE = 6;
const RISKY_ATTACHMENT =
  /\.(exe|scr|bat|cmd|com|pif|js|jse|vbs|vbe|wsf|hta|msi|ps1|jar|docm|xlsm|pptm|iso|img)$/i;

export const isRiskyAttachment = (filename: string) =>
  RISKY_ATTACHMENT.test(filename);

async function scanWithRspamd(raw: Uint8Array, signal?: AbortSignal) {
  const res = await fetch(`${getEnv().RSPAMD_URL}/checkv2`, {
    method: "POST",
    body: new Blob([Buffer.from(raw)]),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Rspamd returned ${res.status}`);
  return (await res.json()) as {
    score: number;
    symbols?: Record<string, unknown>;
  };
}

export interface SenderPolicy {
  blocked: boolean;
  allowed: boolean;
}

export const SPAM_REASONS = {
  unknownRecipient: "Sent to an address that has no mailbox",
  flood: "Part of a flood of mail from this sender",
  reported: "Many HelloBox users reported this sender as spam",
  exempt: "Never-spam rule",
} as const;

export function senderPolicy(
  fromAddress: string,
  entries: { kind: string; value: string }[],
): SenderPolicy {
  const domain = domainOf(fromAddress);
  const has = (kind: string) =>
    entries.some(
      (entry) =>
        entry.kind === kind &&
        (entry.value === fromAddress || entry.value === domain),
    );
  return { blocked: has("blocked"), allowed: has("allowed") };
}

// Never rejects mail: the worst outcome is the Spam folder.
//
// In order: mail to an address with no mailbox, or in a flood, is always spam. A sender the workspace
// allowed never is, and one it blocked always is. A reader's never-spam rule beats every
// other signal, then a sender many HelloBox users reported is spam, then the scanner.
export async function classifySpam(input: {
  raw: Uint8Array | null;
  policy: SenderPolicy;
  authentication?: { dmarc?: string } | null;
  attachmentNames: string[];
  // No mailbox has this address. The mail is kept in Spam and never delivered.
  unknownRecipient?: boolean;
  // Arrived in a flood from a sender the workspace doesn't know (see flood.ts).
  flood?: boolean;
  // Someone who reads the mailbox said this domain never goes to Spam.
  exempt?: boolean;
  // Enough people across HelloBox reported the sender's domain (see reputation.ts).
  reported?: boolean;
}): Promise<SpamVerdict> {
  const reasons: string[] = [];
  let score: number | null = null;
  let symbols: string[] = [];
  let unscanned = input.raw === null;

  if (input.raw) {
    try {
      const result = await scanWithRspamd(input.raw);
      score = result.score;
      symbols = Object.keys(result.symbols ?? {});
    } catch {
      // A scanner outage must not delay mail. It is delivered and marked unscanned.
      unscanned = true;
    }
  }

  if (input.unknownRecipient) {
    return { score, symbols, reasons: [SPAM_REASONS.unknownRecipient], isSpam: true, unscanned };
  }
  if (input.flood) {
    return { score, symbols, reasons: [SPAM_REASONS.flood], isSpam: true, unscanned };
  }
  if (input.policy.allowed) {
    return { score, symbols, reasons: ["Sender allowed"], isSpam: false, unscanned };
  }
  if (input.policy.blocked) {
    return { score, symbols, reasons: ["Sender blocked"], isSpam: true, unscanned };
  }
  if (input.exempt) {
    return { score, symbols, reasons: [SPAM_REASONS.exempt], isSpam: false, unscanned };
  }
  if (input.reported) reasons.push(SPAM_REASONS.reported);
  if (input.authentication?.dmarc === "fail") reasons.push("Failed DMARC");
  if (score !== null && score >= SPAM_SCORE) reasons.push("High spam score");
  if (input.attachmentNames.some(isRiskyAttachment)) {
    reasons.push("Risky attachment type");
  }

  const isSpam =
    Boolean(input.reported) ||
    (score !== null && score >= SPAM_SCORE) ||
    (input.authentication?.dmarc === "fail" && (score ?? 0) >= SPAM_SCORE / 2);
  return { score, symbols, reasons, isSpam, unscanned };
}
