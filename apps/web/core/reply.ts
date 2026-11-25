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
