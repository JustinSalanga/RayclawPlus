import { create, type StateCreator } from "zustand";

export interface Notification {
  id: string;
  message: string;
  variant?: "info" | "error";
}

interface NotificationState {
  notifications: Notification[];
  push: (message: string, variant?: Notification["variant"]) => void;
  dismiss: (id: string) => void;
}

export const useNotificationStore = create<NotificationState>(
  ((set: (fn: (state: NotificationState) => NotificationState) => void) => ({
    notifications: [],
    push: (message: string, variant: Notification["variant"] = "info") =>
      set((state: NotificationState) => ({
        ...state,
        notifications: [
          ...state.notifications,
          { id: crypto.randomUUID(), message, variant },
        ],
      })),
    dismiss: (id: string) =>
      set((state: NotificationState) => ({
        ...state,
        notifications: state.notifications.filter(
          (n: Notification) => n.id !== id,
        ),
      })),
  })) as StateCreator<NotificationState>,
);

