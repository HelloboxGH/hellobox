import cloud from "@ext/worker";
import { assertCloudBuild, getExtensions, install } from "@hellobox/extensions";

// The only worker file that imports @ext/worker. src/index.ts imports this first.
install(cloud);
// Cloud deploys set HELLOBOX_CLOUD=1 and register billing; a deploy that installed the open
// stubs would run with every workspace unlimited.
assertCloudBuild(process.env, Boolean(getExtensions().billing));

export { getExtensions };
