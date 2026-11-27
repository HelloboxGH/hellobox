import type { CloudActions } from "@ext/server";
import { ActionRegistry } from "nezt";
import { getExtensions } from "@/core/extensions";
import { accountActions } from "./actions/account";
import { agentActions } from "./actions/agents";
import { aiActions } from "./actions/ai";
import { campaignActions } from "./actions/campaigns";
import { domainClaimActions } from "./actions/domain-claims";
import { mailgunActions } from "./actions/mailgun";
import { notificationActions } from "./actions/notifications";
import { onboardingActions } from "./actions/onboarding";
import { platformAdminActions } from "./actions/platform-admin";
import { postmarkActions } from "./actions/postmark";
import { receivingActions } from "./actions/receiving";
import { workspacesActions } from "./actions/workspaces";
import { composeActions } from "./actions/compose";
import { health } from "./actions/health";
import { importActions } from "./actions/imports";
import { sesActions } from "./actions/ses";
import { sendgridActions } from "./actions/sendgrid";
import { brevoActions } from "./actions/brevo";
import { mailersendActions } from "./actions/mailersend";
import { mailjetActions } from "./actions/mailjet";
import { birdActions } from "./actions/bird";
import { smtpActions } from "./actions/smtp";
import { customActions } from "./actions/custom";
import { supportActions } from "./actions/support";
import { threadActions } from "./actions/threads";
import { vaultActions } from "./actions/vault";
import { workspaceActions } from "./actions/workspace";

export const allActions = {
  ...accountActions,
  ...agentActions,
  ...aiActions,
  ...campaignActions,
  ...domainClaimActions,
  ...importActions,
  ...mailgunActions,
  ...notificationActions,
  ...onboardingActions,
  ...platformAdminActions,
  ...postmarkActions,
  ...receivingActions,
  ...workspacesActions,
  ...composeActions,
  ...sesActions,
  ...sendgridActions,
  ...brevoActions,
  ...mailersendActions,
  ...mailjetActions,
  ...birdActions,
  ...smtpActions,
  ...customActions,
  ...supportActions,
  ...threadActions,
  ...vaultActions,
  ...workspaceActions,
};

// The client's typed `call()` knows the actions cloud adds too; the open build adds none.
export type ActionMap = typeof allActions & CloudActions;

// Owned by this module so that it's rebuilt along with the actions on hot reload.
export const actionRegistry = new ActionRegistry();

actionRegistry.register(health);
for (const action of [...Object.values(allActions), ...Object.values(getExtensions().actions)]) {
  actionRegistry.register(action as never);
}
