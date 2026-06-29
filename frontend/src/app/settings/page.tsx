import type { Metadata } from "next";
import SettingsContent from "./settings-content";

export const metadata: Metadata = {
  title: "Settings | FlowFi",
  description: "Manage your FlowFi preferences.",
};

export default function SettingsPage() {
  return <SettingsContent />;
}
