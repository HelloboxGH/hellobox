import { action } from "nezt";
import "@/core/extensions";
import { requirePlatformAdmin } from "./admin/middleware";
import { requireAdmin, requireUser, requireWorkspace } from "./middlewares";

const base = (path: string) => action().path(path).method("POST");

export const userAction = (path: string) => base(path).use(requireUser);
export const workspaceAction = (path: string) => base(path).use(requireWorkspace);
export const adminAction = (path: string) => base(path).use(requireAdmin);
// The people who run HelloBox, through the admin tool. Not a workspace admin.
export const platformAdminAction = (path: string) => base(path).use(requirePlatformAdmin);
export const publicAction = (path: string) => base(path);
