export type NetworkId = "testnet" | "futurenet" | "mainnet" | "sandbox";

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  passphrase: string;
  horizonUrl: string;
  rpcUrl: string;
  contractId: string;
  explorerUrl: string;
}

const fallbackContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

export const NETWORK_CONFIGS: Record<NetworkId, NetworkConfig> = {
  testnet: { id: "testnet", name: "Testnet", passphrase: "Test SDF Network ; September 2015", horizonUrl: "https://horizon-testnet.stellar.org", rpcUrl: "https://soroban-testnet.stellar.org", contractId: process.env.NEXT_PUBLIC_STREAM_CONTRACT_ID ?? fallbackContract, explorerUrl: "https://stellar.expert/explorer/testnet" },
  futurenet: { id: "futurenet", name: "Futurenet", passphrase: "Test SDF Future Network ; October 2022", horizonUrl: "https://horizon-futurenet.stellar.org", rpcUrl: "https://rpc-futurenet.stellar.org", contractId: process.env.NEXT_PUBLIC_FUTURENET_STREAM_CONTRACT_ID ?? fallbackContract, explorerUrl: "https://stellar.expert/explorer/futurenet" },
  mainnet: { id: "mainnet", name: "Mainnet", passphrase: "Public Global Stellar Network ; September 2015", horizonUrl: "https://horizon.stellar.org", rpcUrl: "https://soroban-rpc.mainnet.stellar.gateway.fm", contractId: process.env.NEXT_PUBLIC_MAINNET_STREAM_CONTRACT_ID ?? fallbackContract, explorerUrl: "https://stellar.expert/explorer/public" },
  sandbox: { id: "sandbox", name: "Local Sandbox", passphrase: "Standalone Network ; February 2017", horizonUrl: process.env.NEXT_PUBLIC_SANDBOX_HORIZON_URL ?? "http://localhost:8000", rpcUrl: process.env.NEXT_PUBLIC_SANDBOX_RPC_URL ?? "http://localhost:8000/soroban/rpc", contractId: process.env.NEXT_PUBLIC_SANDBOX_STREAM_CONTRACT_ID ?? fallbackContract, explorerUrl: "http://localhost:8000" },
};

export function getNetworkConfig(id: NetworkId): NetworkConfig { return NETWORK_CONFIGS[id]; }