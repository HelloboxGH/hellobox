import cloud from "@ext/worker";
import { setting } from "@hellobox/config";
import { assertCloudBuild, getExtensions, install } from "@hellobox/extensions";

// The only worker file that imports @ext/worker. src/index.ts imports this first.
install(cloud);
// Cloud deploys set HELLOBOX_CLOUD=1 and register billing; a deploy that installed the open
// stubs would run with every workspace unlimited.
assertCloudBuild({ HELLOBOX_CLOUD: setting("HELLOBOX_CLOUD") }, Boolean(getExtensions().billing));

export { getExtensions };
