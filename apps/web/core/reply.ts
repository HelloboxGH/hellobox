interface Answered {
  direction: string;
  fromAddress: string;
  replyTo: string[];
  toRecipients: { address: string }[];
  // The customer wrote it, in a support conversation.
  fromCustomer?: boolean;
}

/** Who a reply to this message goes to. A verified customer's newest address, wherever they wrote from. */
export function replyAddresses(message: Answered, support?: { verified: boolean; email: string } | null) {
  if (message.direction === "outbound") return message.toRecipients.map((recipient) => recipient.address);
  if (message.fromCustomer && support?.verified) return [support.email];
  return message.replyTo.length ? message.replyTo : [message.fromAddress];
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Plain text as quote HTML. Lines starting with ">" were quoted by an earlier reply, so
 * each level becomes a blockquote inside the last, not literal ">" characters.
 */
export function quotedTextHtml(text: string) {
  let html = "";
  let depth = 0;
  let lineOpen = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = raw.match(/^(?:\s*>)+ ?/)?.[0] ?? "";
    const level = (marker.match(/>/g) ?? []).length;
    const line = raw.slice(marker.length);
    if (level !== depth) {
      html += level > depth ? "<blockquote>".repeat(level - depth) : "</blockquote>".repeat(depth - level);
      depth = level;
      lineOpen = false;
    }
    if (lineOpen) html += "<br>";
    html += escapeHtml(line);
    lineOpen = true;
  }
  return html.replace(/(<br>)+(?=<\/blockquote>|$)/g, "") + "</blockquote>".repeat(depth);
}
