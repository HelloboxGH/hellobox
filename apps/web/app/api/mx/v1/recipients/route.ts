import "@/core/extensions";
import { checkRecipient } from "@/core/server/mx/handlers";

// The mail server asks here before accepting RCPT TO.
export const POST = (request: Request) => checkRecipient(request);
