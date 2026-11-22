import { setting } from "@hellobox/config";

export const SITE_NAME = "HelloBox";
// Where this instance lives. Only used to resolve relative URLs in page metadata.
export const siteUrl = () => {
  const url = setting("APP_URL");
  return url ? new URL(url) : undefined;
};
