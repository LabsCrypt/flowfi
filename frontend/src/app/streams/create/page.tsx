import type { Metadata } from "next";
import { Suspense } from "react";
import CreateStreamContent from "./create-stream-content";

export const metadata: Metadata = {
  title: "Create Stream | FlowFi",
  description: "Set up a new real-time payment stream.",
};

export default function CreateStreamPage() {
  return (
    <Suspense fallback={null}>
      <CreateStreamContent />
    </Suspense>
  );
}
