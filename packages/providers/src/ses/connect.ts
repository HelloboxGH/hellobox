// SES regions that can also receive mail. Connecting is limited to these, so turning
// receiving on later never means starting over in another region.
export const SES_REGIONS = [
  { id: "us-east-1", name: "US East (N. Virginia)" },
  { id: "us-east-2", name: "US East (Ohio)" },
  { id: "us-west-1", name: "US West (N. California)" },
  { id: "us-west-2", name: "US West (Oregon)" },
  { id: "ca-central-1", name: "Canada (Central)" },
  { id: "sa-east-1", name: "South America (São Paulo)" },
  { id: "eu-west-1", name: "Europe (Ireland)" },
  { id: "eu-west-2", name: "Europe (London)" },
  { id: "eu-west-3", name: "Europe (Paris)" },
  { id: "eu-central-1", name: "Europe (Frankfurt)" },
  { id: "eu-south-1", name: "Europe (Milan)" },
  { id: "eu-north-1", name: "Europe (Stockholm)" },
  { id: "il-central-1", name: "Israel (Tel Aviv)" },
  { id: "me-south-1", name: "Middle East (Bahrain)" },
  { id: "af-south-1", name: "Africa (Cape Town)" },
  { id: "ap-south-1", name: "Asia Pacific (Mumbai)" },
  { id: "ap-southeast-1", name: "Asia Pacific (Singapore)" },
  { id: "ap-southeast-2", name: "Asia Pacific (Sydney)" },
  { id: "ap-southeast-3", name: "Asia Pacific (Jakarta)" },
  { id: "ap-northeast-1", name: "Asia Pacific (Tokyo)" },
  { id: "ap-northeast-2", name: "Asia Pacific (Seoul)" },
  { id: "ap-northeast-3", name: "Asia Pacific (Osaka)" },
] as const;

export type SesRegion = (typeof SES_REGIONS)[number]["id"];

export const isSesRegion = (value: string): value is SesRegion =>
  SES_REGIONS.some((region) => region.id === value);

export const CONNECT_TEMPLATE = "connect.yaml";

// Opens CloudFormation's "Quick create stack" page with our template and this
// connection's parameters filled in. The customer only ticks the IAM box and submits.
export function quickCreateUrl(input: {
  region: SesRegion;
  templatesBaseUrl: string;
  connectionId: string;
  externalId: string;
  connectToken: string;
  callbackUrl: string;
  brokerAccountId: string;
  route53: boolean;
}) {
  const params = new URLSearchParams({
    templateURL: `${input.templatesBaseUrl.replace(/\/$/, "")}/${CONNECT_TEMPLATE}`,
    stackName: `HelloBox-${input.connectionId.slice(0, 8)}`,
    param_ConnectionId: input.connectionId,
    param_ExternalId: input.externalId,
    param_ConnectToken: input.connectToken,
    param_CallbackUrl: input.callbackUrl,
    param_HelloboxAccountId: input.brokerAccountId,
    param_ManageRoute53: input.route53 ? "true" : "false",
  });
  return `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}#/stacks/create/review?${params}`;
}

export const stackConsoleUrl = (region: string) =>
  `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks`;

// What the stack's callback function posts to us.
export interface StackCallback {
  requestType: "Create" | "Update" | "Delete";
  connectionId: string;
  connectToken: string;
  roleArn: string;
  accountId: string;
  region: string;
}

export function parseStackCallback(body: unknown): StackCallback | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const strings = ["requestType", "connectionId", "connectToken", "roleArn", "accountId", "region"] as const;
  if (!strings.every((key) => typeof value[key] === "string" && value[key])) return null;
  if (!["Create", "Update", "Delete"].includes(value.requestType as string)) return null;
  if (!/^\d{12}$/.test(value.accountId as string)) return null;
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/hellobox\/[\w+=,.@-]+$/.test(value.roleArn as string)) return null;
  return value as unknown as StackCallback;
}
