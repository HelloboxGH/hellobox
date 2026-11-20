import type { ServerExtensions } from "@hellobox/extensions";

// The open build: nothing registered. No billing (so no limits, no plan gates, no upgrade
// prompts), no event listeners, no extra actions, no extra sign-in methods.
export default {} satisfies ServerExtensions;
export type CloudActions = object;
export type CloudBootstrap = object;
