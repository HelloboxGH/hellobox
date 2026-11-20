import "server-only";
import cloud from "@ext/server";
import { assertCloudBuild, getExtensions, install } from "@hellobox/extensions";

// The only web file that imports @ext/server. Import this (or something that does) before
// anything calls getExtensions().
install(cloud);
// Cloud deploys set HELLOBOX_CLOUD=1 and register billing; a deploy that installed the open
// stubs would run with every workspace unlimited.
assertCloudBuild(process.env, Boolean(getExtensions().billing));

export { getExtensions };
