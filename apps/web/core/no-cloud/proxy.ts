import type { ProxyHooks } from "@hellobox/extensions";

// The open build: nothing to do besides the app's own proxy rules.
const hooks: ProxyHooks = { before: async () => undefined, cookies: () => [] };
export default hooks;
