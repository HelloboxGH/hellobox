import ext from "@ext/client";
import type { ClientExtensions } from "@hellobox/extensions";
import type { Bootstrap } from "./api";

// What the cloud build adds to the app's screens: tabs, banners, menu items, dialogs. Empty
// in the open build. The only client file that imports the entry.
export const clientExtensions: ClientExtensions<Bootstrap> = ext;
