import type { Metadata } from "next";
import StreamDetailsContent from "./stream-details-content";

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Stream #${id} | FlowFi`,
    description: `View details and manage stream #${id}.`,
  };
}

export default async function StreamDetailsPage(
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return <StreamDetailsContent streamId={id} />;
}