"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/Button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Edit2, ExternalLink, Pause, X } from "lucide-react";
import { useState } from "react";

// Mock data for outgoing streams
const mockStreams = [
  {
    id: "1",
    recipient: "0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45",
    recipientEns: "alice.eth",
    token: "USDC",
    rate: "100.00",
    ratePeriod: "month",
    remainingBalance: "2500.50",
    status: "active",
    startDate: "2024-01-15",
  },
  {
    id: "2",
    recipient: "0x8ba1f109551bD432803012645Hac136c82C31A01",
    recipientEns: "bob.eth",
    token: "ETH",
    rate: "0.05",
    ratePeriod: "day",
    remainingBalance: "1.25",
    status: "active",
    startDate: "2024-01-10",
  },
  {
    id: "3",
    recipient: "0x9876543210987654321098765432109876543210",
    recipientEns: "charlie.eth",
    token: "DAI",
    rate: "50.00",
    ratePeriod: "month",
    remainingBalance: "1200.00",
    status: "paused",
    startDate: "2024-01-05",
  },
  {
    id: "4",
    recipient: "0x1234567890123456789012345678901234567890",
    recipientEns: "david.eth",
    token: "USDT",
    rate: "75.00",
    ratePeriod: "month",
    remainingBalance: "875.25",
    status: "active",
    startDate: "2024-01-20",
  },
];

export function OutgoingStreams() {
  const [streams, setStreams] = useState(mockStreams);

  const handleCancel = (streamId: string) => {
    setStreams(streams.filter((stream) => stream.id !== streamId));
  };

  const handlePause = (streamId: string) => {
    setStreams(
      streams.map((stream) =>
        stream.id === streamId
          ? {
              ...stream,
              status: stream.status === "active" ? "paused" : "active",
            }
          : stream,
      ),
    );
  };

  const handleModify = (streamId: string) => {
    // TODO: Open modify modal
    console.log("Modify stream:", streamId);
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const getStatusBadge = (status: string) => {
    return (
      <Badge variant={status === "active" ? "default" : "secondary"}>
        {status === "active" ? "Active" : "Paused"}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Outgoing Streams</h1>
          <p className="text-muted-foreground">
            Manage your active payment streams and liabilities
          </p>
        </div>
        <Button>Create Stream</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Streams</CardTitle>
          <CardDescription>
            You have {streams.filter((s) => s.status === "active").length}{" "}
            active streams
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Remaining Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {streams.map((stream) => (
                <TableRow key={stream.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div>
                        <div className="font-medium">{stream.recipientEns}</div>
                        <div className="text-sm text-muted-foreground flex items-center gap-1">
                          {formatAddress(stream.recipient)}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-auto p-0"
                            onClick={() =>
                              navigator.clipboard.writeText(stream.recipient)
                            }
                          >
                            <ExternalLink className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{stream.token}</Badge>
                  </TableCell>
                  <TableCell>
                    <div>
                      <div className="font-medium">
                        {stream.rate} {stream.token}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        per {stream.ratePeriod}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {stream.remainingBalance} {stream.token}
                    </div>
                  </TableCell>
                  <TableCell>{getStatusBadge(stream.status)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePause(stream.id)}
                      >
                        <Pause className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleModify(stream.id)}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCancel(stream.id)}
                        className="text-red-500 border-red-500 hover:bg-red-500 hover:text-white"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
