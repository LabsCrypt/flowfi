import { EmptyState } from "./dashboard-view";
import { ActivityIcon } from "./dashboard-view";
import { Button } from "@/components/ui/Button";
import type { ActivityItem } from "@/lib/dashboard";

interface DashboardActivityProps {
  recentActivity: ActivityItem[];
  onCreateStream: () => void;
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function DashboardActivity({
  recentActivity,
  onCreateStream,
}: DashboardActivityProps) {
  if (recentActivity.length === 0) {
    return (
      <EmptyState
        icon={<ActivityIcon />}
        title="No stream activity yet"
        description="Transactions will appear here once you start creating or receiving payment streams."
        action={
          <Button onClick={onCreateStream} variant="ghost">
            Create a Stream
          </Button>
        }
      />
    );
  }

  return (
    <section className="dashboard-panel">
      <div className="dashboard-panel__header">
        <h3>Recent Activity</h3>
        <span>{recentActivity.length} items</span>
      </div>
      <ul className="activity-list">
        {recentActivity.map((activity) => {
          const amountPrefix = activity.direction === "received" ? "+" : "-";
          const amountClass = activity.direction === "received" ? "is-positive" : "is-negative";
          return (
            <li key={activity.id} className="activity-item">
              <div>
                <strong>{activity.title}</strong>
                <p>{activity.description}</p>
                <small>{formatActivityTime(activity.timestamp)}</small>
              </div>
              <span className={amountClass}>
                {amountPrefix}
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(activity.amount)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}