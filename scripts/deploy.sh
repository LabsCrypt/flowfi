#!/bin/bash
set -e

# Default to testnet
NETWORK="testnet"
ADMIN_ALIAS="admin"
TREASURY_ALIAS="treasury"

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --network) NETWORK="$2"; shift ;;
        --admin) ADMIN_ALIAS="$2"; shift ;;
        --treasury) TREASURY_ALIAS="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

echo "Deploying to $NETWORK..."

# Check if admin alias exists
if ! stellar keys ls | grep -q "$ADMIN_ALIAS"; then
  echo "Generating admin key ($ADMIN_ALIAS)..."
  stellar keys generate "$ADMIN_ALIAS" --network "$NETWORK"
fi

# Check if treasury alias exists
if ! stellar keys ls | grep -q "$TREASURY_ALIAS"; then
  echo "Generating treasury key ($TREASURY_ALIAS)..."
  stellar keys generate "$TREASURY_ALIAS" --network "$NETWORK"
fi

ADMIN_ADDRESS=$(stellar keys address "$ADMIN_ALIAS")
TREASURY_ADDRESS=$(stellar keys address "$TREASURY_ALIAS")

cd contracts

# Build the contract
echo "Building contract..."
cargo build --target wasm32-unknown-unknown --release

# Optimize the contract
echo "Optimizing contract..."
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/stream_contract.wasm

# Deploy the contract
echo "Deploying contract..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stream_contract.optimized.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_ALIAS")

echo "Contract deployed with ID: $CONTRACT_ID"

# Initialize the contract
echo "Initializing contract..."
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network "$NETWORK" \
  --source "$ADMIN_ALIAS" \
  -- \
  initialize \
  --admin "$ADMIN_ADDRESS" \
  --treasury "$TREASURY_ADDRESS" \
  --fee_rate_bps 100

cd ..

# Save to deployment-info.json
echo "{\"network\": \"$NETWORK\", \"contract_id\": \"$CONTRACT_ID\"}" > deployment-info.json

echo "Deployment complete! Info saved to deployment-info.json"
