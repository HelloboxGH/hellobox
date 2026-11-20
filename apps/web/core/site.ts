export const SITE_NAME = "HelloBox";
// Where this instance lives. Only used to resolve relative URLs in page metadata.
export const siteUrl = () => (process.env.APP_URL ? new URL(process.env.APP_URL) : undefined);
