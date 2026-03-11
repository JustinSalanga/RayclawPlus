import { useNotificationStore, type Notification } from "../store/notificationStore";

export function NotificationCenter() {
  const { notifications, dismiss } = useNotificationStore();

  if (notifications.length === 0) return null;

  return (
    <div className="notification-center">
      {notifications.map((n: Notification) => (
        <div
          key={n.id}
          className={`notification ${
            n.variant === "error" ? "notification-error" : "notification-info"
          }`}
        >
          <span className="notification-message">{n.message}</span>
          <button
            className="notification-close"
            onClick={() => dismiss(n.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default NotificationCenter;

