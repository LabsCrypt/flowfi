export interface BackendUser {
    id: string;
    publicKey: string;
    createdAt: string;
    updatedAt: string;
}

export type StreamEventType = "CREATED" | "TOPPED_UP" | "WITHDRAWN" | "CANCELLED" | "COMPLETED";

export interface BackendStreamEvent {
    id: string;
    streamId: number;
    eventType: StreamEventType;
    amount: string | null;
    transactionHash: string;
    ledgerSequence: number;
    timestamp: number;
    metadata: string | null;
    createdAt: string;
}

export interface BackendStream {
    id: string;
    streamId: number;
    sender: string;
    recipient: string;
    tokenAddress: string;
    ratePerSecond: string;
    depositedAmount: string;
    withdrawnAmount: string;
    startTime: number;
    lastUpdateTime: number;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    senderUser?: BackendUser;
    recipientUser?: BackendUser;
    events?: BackendStreamEvent[];
}
