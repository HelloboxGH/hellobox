import { toastManager } from "@/components/ui/toast";
import { RECONNECT_REQUIRED, reconnectPath } from "@/core/reconnect";
import { ApiError } from "./api";
import { clientExtensions } from "./extensions";

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

export const notify = (title: string, description?: string) =>
  toastManager.add({ title, description, type: "success" });

export const notifyInfo = (title: string) => toastManager.add({ title, type: "info" });

// What the cloud build does with this error's code, when it knows it (billing errors).
export const errorAction = (error: unknown) =>
  error instanceof ApiError && error.type ? clientExtensions.errorActions?.[error.type] : undefined;

// Every error in the app comes through here, so billing and expired-access errors get
// handled wherever they happen. Expired access offers to reconnect. Cloud's error actions
// open its upgrade dialog or add a button to the toast.
export const notifyError = (error: unknown) => {
  const handled = errorAction(error);
  if (handled?.run && !handled.label) {
    handled.run((error as ApiError).details, errorMessage(error));
    return;
  }
  if (error instanceof ApiError && error.type === RECONNECT_REQUIRED) {
    const provider = (error.details as { provider?: unknown } | undefined)?.provider;
    toastManager.add({
      title: errorMessage(error),
      type: "error",
      actionProps: {
        children: "Reconnect",
        onClick: () => {
          window.location.href = reconnectPath(provider);
        },
      },
    });
    return;
  }
  const { run, label } = handled ?? {};
  toastManager.add({
    title: errorMessage(error),
    type: "error",
    ...(run && label
      ? { actionProps: { children: label, onClick: () => run((error as ApiError).details, errorMessage(error)) } }
      : {}),
  });
};
