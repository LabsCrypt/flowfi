import type { Metadata } from "next";
import IncomingContent from "./incoming-content";

export const metadata: Metadata = {
  title: "Incoming Streams | FlowFi",
  description: "Review and manage your incoming payment streams.",
};

export default function IncomingPage() {
  return <IncomingContent />;
}
