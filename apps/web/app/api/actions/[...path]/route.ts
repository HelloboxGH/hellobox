import { createActionDispatcher } from "nezt";
import { actionRegistry } from "@/core/server/actions-manifest";

const dispatcher = createActionDispatcher(actionRegistry);

export const GET = dispatcher;
export const POST = dispatcher;
export const PUT = dispatcher;
export const PATCH = dispatcher;
export const DELETE = dispatcher;
