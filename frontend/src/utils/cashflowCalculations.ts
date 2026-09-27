export type StreamDirection = "incoming" | "outgoing";

export interface ProjectionStream {
  id: string;
  direction: StreamDirection;
  token: string;
  deposited: number;
  withdrawn: number;
  ratePerSecond: number;
  isActive: boolean;
  isPaused?: boolean;
  startTime?: number;
  cliffDates?: number[];
}

export interface CashflowPoint { date: Date; actual: number; projected: number; balance: number; dailyRate: number; }

export function projectCashflow(streams: ProjectionStream[], horizonDays: number, now = new Date()): CashflowPoint[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let balance = streams.filter((stream) => stream.direction === "outgoing").reduce((sum, stream) => sum + Math.max(0, stream.deposited - stream.withdrawn), 0);
  let cumulative = streams.filter((stream) => stream.direction === "incoming").reduce((sum, stream) => sum + stream.withdrawn, 0);
  return Array.from({ length: horizonDays + 1 }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index);
    const day = streams.reduce((total, stream) => {
      if (!stream.isActive || stream.isPaused || (stream.startTime && stream.startTime * 1000 > date.getTime())) return total;
      const amount = stream.ratePerSecond * 86400;
      return total + (stream.direction === "incoming" ? amount : -amount);
    }, 0);
    cumulative += Math.max(0, day);
    balance = Math.max(0, balance + Math.min(0, day));
    return { date, actual: index === 0 ? cumulative : 0, projected: cumulative, balance, dailyRate: day };
  });
}

export function estimateRunwayDate(streams: ProjectionStream[], now = new Date()): Date | null {
  const outgoing = streams.filter((stream) => stream.direction === "outgoing" && stream.isActive && !stream.isPaused);
  const balance = outgoing.reduce((sum, stream) => sum + Math.max(0, stream.deposited - stream.withdrawn), 0);
  const rate = outgoing.reduce((sum, stream) => sum + stream.ratePerSecond * 86400, 0);
  if (balance <= 0 || rate <= 0) return null;
  return new Date(now.getTime() + (balance / rate) * 86400000);
}

export function getCliffDates(streams: ProjectionStream[]): Date[] {
  return streams.flatMap((stream) => (stream.cliffDates ?? []).map((timestamp) => new Date(timestamp * 1000))).sort((a, b) => a.getTime() - b.getTime());
}