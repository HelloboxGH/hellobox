import { getAwsBrokerEnv } from "@hellobox/config";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

export interface RoleTarget {
  connectionId: string;
  roleArn: string;
  externalId: string;
}

// The customer's role refused us: deleted stack, changed trust policy or wrong id.
export class RoleAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleAccessError";
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
interface RoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration: Date;
}

const cache = new Map<string, RoleCredentials>();
let sts: STSClient | undefined;

function broker() {
  const env = getAwsBrokerEnv();
  sts ??= new STSClient({
    region: env.AWS_BROKER_REGION,
    credentials: {
      accessKeyId: env.AWS_BROKER_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_BROKER_SECRET_ACCESS_KEY,
    },
  });
  return sts;
}

// Short-lived keys for the customer's role, reused until shortly before they expire.
// Long-lived customer keys never exist on our side.
export async function roleCredentials(target: RoleTarget): Promise<RoleCredentials> {
  const key = `${target.roleArn}|${target.externalId}`;
  const cached = cache.get(key);
  if (cached && cached.expiration.getTime() - Date.now() > REFRESH_MARGIN_MS) return cached;
  try {
    const { Credentials } = await broker().send(
      new AssumeRoleCommand({
        RoleArn: target.roleArn,
        ExternalId: target.externalId,
        RoleSessionName: `hellobox-${target.connectionId}`.slice(0, 64),
        DurationSeconds: 3600,
      }),
    );
    if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.Expiration) {
      throw new Error("AWS returned no credentials for the role");
    }
    const credentials = {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    };
    cache.set(key, credentials);
    return credentials;
  } catch (error) {
    cache.delete(key);
    if ((error as { name?: string }).name === "AccessDenied") {
      throw new RoleAccessError("HelloBox can no longer use the role in your AWS account");
    }
    throw error;
  }
}

export const credentialsFor = (target: RoleTarget) => () => roleCredentials(target);
