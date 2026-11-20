import { getEnv } from "@hellobox/config";
import { realtimeChannel } from "@hellobox/queue";
import Redis from "ioredis";

let publisher: Redis | undefined;

export type RealtimeEvent = {
  type: "thread.updated" | "connection.updated";
  threadId?: string;
};

export function publishEvent(workspaceId: string, event: RealtimeEvent) {
  publisher ??= new Redis(getEnv().REDIS_URL);
  return publisher.publish(realtimeChannel(workspaceId), JSON.stringify(event));
}

export const createSubscriber = () => new Redis(getEnv().REDIS_URL);
