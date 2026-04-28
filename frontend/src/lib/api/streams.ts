const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function getClaimableAmount(streamId: string) {
  const response = await fetch(`${baseUrl}/v1/streams/${streamId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch stream details");
  }
  const data = await response.json();
  
  const deposited = parseFloat(data.depositedAmount) / 1e7;
  const withdrawn = parseFloat(data.withdrawnAmount) / 1e7;
  const claimable = deposited - withdrawn;
  
  return {
    claimable,
    ratePerSecond: parseFloat(data.ratePerSecond) / 1e7,
    lastUpdateTime: data.lastUpdateTime,
  };
}
