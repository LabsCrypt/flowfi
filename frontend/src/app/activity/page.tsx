import type { Metadata } from "next";
import ActivityContent from "./activity-content";

export const metadata: Metadata = {
  title: "Activity | FlowFi",
  description: "View your stream activity and event history.",
};

export default function ActivityPage() {
  return <ActivityContent />;
}
