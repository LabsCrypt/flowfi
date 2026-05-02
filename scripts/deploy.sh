#!/bin/bash

# FlowFi Contract Deployment Script
# 
# This script automates the deployment and initialization of FlowFi smart contracts
# to both testnet and mainnet Stellar networks.
# 
# Usage:
#   ./scripts/deploy.sh --network testnet
#   ./scripts/deploy.sh --network mainnet
# 
# Environment Variables Required:
#   - DEPLOYER_SECRET: Secret key for deployment account
#   - ADMIN_ADDRESS: Admin address for contract initialization
#   - TREASURY_ADDRESS: Treasury address for fee collection
#   - FEE_RATE_BPS: Fee rate in basis points (e.g., 25 for 0.25%)

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
NETWORK=""
DEPLOYER_SECRET=""
ADMIN_ADDRESS=""
TREASURY_ADDRESS=""
FEE_RATE_BPS=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --network)
      NETWORK="$2"
      shift 2
      ;;
    * )
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

# Validate network
if [[ -z "$NETWORK" ]]; then
  echo -e "${RED}Error: --network parameter is required${NC}"
  echo "Usage: $0 --network testnet|mainnet"
  exit 1
fi

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo -e "${RED}Error: Invalid network. Must be 'testnet' or 'mainnet'${NC}"
  exit 1
fi

# Validate required environment variables
echo -e "${BLUE}Validating environment variables...${NC}"
MISSING_VARS=()

if [[ -z "$DEPLOYER_SECRET" ]]; then
  MISSING_VARS+=("DEPLOYER_SECRET")
fi

if [[ -z "$ADMIN_ADDRESS" ]]; then
  MISSING_VARS+=("ADMIN_ADDRESS")
fi

if [[ -z "$TREASURY_ADDRESS" ]]; then
  MISSING_VARS+=("TREASURY_ADDRESS")
fi

if [[ -z "$FEE_RATE_BPS" ]]; then
  MISSING_VARS+=("FEE_RATE_BPS")
fi

if [[ ${#MISSING_VARS[@]} -gt 0 ]]; then
  echo -e "${RED}Error: Missing required environment variables:${NC}"
  for var in "${MISSING_VARS[@]}"; do
    echo -e "  ${RED}- $var${NC}"
  done
  echo ""
  echo "Please set the following environment variables:"
  echo "  export DEPLOYER_SECRET=\"your_secret_key_here\""
  echo "  export ADMIN_ADDRESS=\"your_admin_address_here\""
  echo "  export TREASURY_ADDRESS=\"your_treasury_address_here\""
  echo "  export FEE_RATE_BPS=\"25\"  # 0.25% fee rate"
  exit 1
fi

# Validate FEE_RATE_BPS is a number
if ! [[ "$FEE_RATE_BPS" =~ ^[0-9]+$ ]] || [ "$FEE_RATE_BPS" -lt 0 ] || [ "$FEE_RATE_BPS" -gt 10000 ]; then
  echo -e "${RED}Error: FEE_RATE_BPS must be a number between 0 and 10000${NC}"
  exit 1
fi

# Get network configuration
if [[ "$NETWORK" == "testnet" ]]; then
  RPC_URL="https://soroban-testnet.stellar.org"
  HORIZON_URL="https://horizon-testnet.stellar.org"
  NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
else
  RPC_URL="https://soroban-rpc.stellar.org"
  HORIZON_URL="https://horizon.stellar.org"
  NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
fi

# Display configuration
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}FlowFi Contract Deployment${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "${BLUE}Network:${NC} $NETWORK"
echo -e "${BLUE}Admin:${NC} $ADMIN_ADDRESS"
echo -e "${BLUE}Treasury:${NC} $TREASURY_ADDRESS"
echo -e "${BLUE}Fee Rate:${NC} $FEE_RATE_BPS bps ($(echo "scale=2; $FEE_RATE_BPS / 100" | bc)%)"
echo -e "${GREEN}========================================${NC}"
echo ""

# Change to contracts directory
cd "$(dirname "$0")/.." || exit 1
CONTRACTS_DIR="contracts"

# Step 1: Build WASM
echo -e "${BLUE}Step 1: Building WASM...${NC}"
cd "$CONTRACTS_DIR" || exit 1
cargo build --target wasm32-unknown-unknown --release
echo -e "${GREEN}✓ WASM build completed${NC}"
echo ""

# Step 2: Optimize WASM
echo -e "${BLUE}Step 2: Optimizing WASM...${NC}"
WASM_PATH="target/wasm32-unknown-unknown/release/stream_contract.wasm"
if [[ ! -f "$WASM_PATH" ]]; then
  echo -e "${RED}Error: WASM file not found at $WASM_PATH${NC}"
  exit 1
fi

stellar contract optimize --wasm "$WASM_PATH"
OPTIMIZED_WASM_PATH="${WASM_PATH%.wasm}.optimized.wasm"
if [[ ! -f "$OPTIMIZED_WASM_PATH" ]]; then
  echo -e "${RED}Error: Optimized WASM file not found${NC}"
  exit 1
fi
echo -e "${GREEN}✓ WASM optimization completed${NC}"
echo ""

# Step 3: Deploy contract
echo -e "${BLUE}Step 3: Deploying contract to $NETWORK...${NC}"
DEPLOY_OUTPUT=$(stellar contract deploy \
  --wasm "$OPTIMIZED_WASM_PATH" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK" \
  --network-passphrase "$NETWORK_PASSPHRASE" 2>&1)

if [[ $? -ne 0 ]]; then
  echo -e "${RED}Error: Deployment failed${NC}"
  echo "$DEPLOY_OUTPUT"
  exit 1
fi

# Extract contract ID from output
CONTRACT_ID=$(echo "$DEPLOY_OUTPUT" | grep -oP 'Contract ID: \K[A-Z0-9]+' || echo "")
if [[ -z "$CONTRACT_ID" ]]; then
  echo -e "${RED}Error: Could not extract contract ID from deployment output${NC}"
  echo "$DEPLOY_OUTPUT"
  exit 1
fi

echo -e "${GREEN}✓ Contract deployed with ID: $CONTRACT_ID${NC}"
echo ""

# Step 4: Initialize contract
echo -e "${BLUE}Step 4: Initializing contract...${NC}"
INIT_OUTPUT=$(stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$DEPLOYER_SECRET" \
  --network "$NETWORK" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  initialize \
  --admin "$ADMIN_ADDRESS" \
  --treasury "$TREASURY_ADDRESS" \
  --fee_rate_bps "$FEE_RATE_BPS" 2>&1)

if [[ $? -ne 0 ]]; then
  echo -e "${RED}Error: Contract initialization failed${NC}"
  echo "$INIT_OUTPUT"
  exit 1
fi

# Extract transaction hash from output
TX_HASH=$(echo "$INIT_OUTPUT" | grep -oP 'Transaction hash: \K[A-Z0-9]+' || echo "unknown")
echo -e "${GREEN}✓ Contract initialized successfully${NC}"
echo ""

# Step 5: Save deployment info
echo -e "${BLUE}Step 5: Saving deployment information...${NC}"
cd - > /dev/null || exit 1

DEPLOYMENT_INFO_FILE="deployment-info.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

# Create or update deployment-info.json
if [[ -f "$DEPLOYMENT_INFO_FILE" ]]; then
  # Update existing file
  EXISTING_DATA=$(cat "$DEPLOYMENT_INFO_FILE")
  UPDATED_DATA=$(echo "$EXISTING_DATA" | jq --arg network "$NETWORK" --arg contractId "$CONTRACT_ID" --arg deployedAt "$TIMESTAMP" --arg adminAddress "$ADMIN_ADDRESS" --arg treasuryAddress "$TREASURY_ADDRESS" --argjson feeRateBps "$FEE_RATE_BPS" --arg txHash "$TX_HASH" --arg lastUpdated "$TIMESTAMP" '
    .[$network] = {
      network: $network,
      contractId: $contractId,
      deployedAt: $deployedAt,
      adminAddress: $adminAddress,
      treasuryAddress: $treasuryAddress,
      feeRateBps: $feeRateBps,
      transactionHash: $txHash
    } | .lastUpdated = $lastUpdated
  ')
  echo "$UPDATED_DATA" > "$DEPLOYMENT_INFO_FILE"
else
  # Create new file
  cat > "$DEPLOYMENT_INFO_FILE" << EOF
{
  "$NETWORK": {
    "network": "$NETWORK",
    "contractId": "$CONTRACT_ID",
    "deployedAt": "$TIMESTAMP",
    "adminAddress": "$ADMIN_ADDRESS",
    "treasuryAddress": "$TREASURY_ADDRESS",
    "feeRateBps": $FEE_RATE_BPS,
    "transactionHash": "$TX_HASH"
  },
  "lastUpdated": "$TIMESTAMP"
}
EOF
fi

echo -e "${GREEN}✓ Deployment info saved to $DEPLOYMENT_INFO_FILE${NC}"
echo ""

# Step 6: Display summary
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Summary${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "${BLUE}Network:${NC} $NETWORK"
echo -e "${BLUE}Contract ID:${NC} $CONTRACT_ID"
echo -e "${BLUE}Transaction Hash:${NC} $TX_HASH"
echo -e "${BLUE}Admin:${NC} $ADMIN_ADDRESS"
echo -e "${BLUE}Treasury:${NC} $TREASURY_ADDRESS"
echo -e "${BLUE}Fee Rate:${NC} $FEE_RATE_BPS bps"
echo -e "${BLUE}Deployed At:${NC} $TIMESTAMP"
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ Deployment completed successfully!${NC}"
echo ""
