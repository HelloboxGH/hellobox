import { AsyncLocalStorage } from "node:async_hooks";

export interface AgentIdentity {
  tokenId: string;
  name: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
}

const storage = new AsyncLocalStorage<AgentIdentity>();

// Actions called inside this run as the token's user, in the token's workspace,
// through the same middlewares the app uses.
export const runAsAgent = <T>(agent: AgentIdentity, work: () => Promise<T>) =>
  storage.run(agent, work);

export const currentAgent = () => storage.getStore() ?? null;
