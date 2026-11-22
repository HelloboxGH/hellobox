import { getExtensions } from "@/core/extensions";
import { setting } from "@hellobox/config";

// Who to write to about a suspended account or workspace: SUPPORT_EMAIL, else what a hosted
// build registers, else the people who run this instance.
export function suspendedMessage(what: "account" | "workspace") {
  const email = setting("SUPPORT_EMAIL") || getExtensions().supportEmail;
  return `This ${what} is suspended. ${email ? `Contact ${email}` : "Ask whoever runs this instance"}`;
}
