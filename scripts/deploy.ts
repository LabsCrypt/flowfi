#!/usr/bin/env tsx

/**
 * FlowFi Contract Deployment Script
 * 
 * This script automates the deployment and initialization of FlowFi smart contracts
 * to both testnet and mainnet Stellar networks.
 * 
 * Usage:
 *   npx tsx scripts/deploy.ts --network testnet
 *   npx tsx scripts/deploy.ts --network mainnet
 * 
 * Environment Variables Required:
 *   - STELLAR_SECRET_KEY: Secret key for deployment account
 *   - ADMIN_ADDRESS: Admin address for contract initialization
 *   - TREASURY_ADDRESS: Treasury address for fee collection
 *   - FEE_RATE_BPS: Fee rate in basis points (e.g., 25 for 0.25%)
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface DeploymentInfo {
  network: string;
  contractId: string;
  deployedAt: string;
  adminAddress: string;
  treasuryAddress: string;
  feeRateBps: number;
  transactionHash: string;
}

interface Config {
  network: 'testnet' | 'mainnet';
  adminAddress: string;
  treasuryAddress: string;
  feeRateBps: number;
  secretKey: string;
}

// Parse command line arguments
function parseArgs(): Config {
  const args = process.argv.slice(2);
  const networkArg = args.find(arg => arg.startsWith('--network='))?.split('=')[1];
  
  if (!networkArg || !['testnet', 'mainnet'].includes(networkArg)) {
    console.error('❌ Invalid or missing network. Use --network=testnet or --network=mainnet');
    process.exit(1);
  }

  // Validate required environment variables
  const requiredEnvVars = ['STELLAR_SECRET_KEY', 'ADMIN_ADDRESS', 'TREASURY_ADDRESS', 'FEE_RATE_BPS'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingVars.forEach(varName => console.error(`   - ${varName}`));
    console.error('\nPlease set these environment variables before running the script.');
    process.exit(1);
  }

  const feeRateBps = parseInt(process.env.FEE_RATE_BPS!);
  if (isNaN(feeRateBps) || feeRateBps < 0 || feeRateBps > 10000) {
    console.error('❌ FEE_RATE_BPS must be a number between 0 and 10000 (0% to 100%)');
    process.exit(1);
  }

  return {
    network: networkArg as 'testnet' | 'mainnet',
    adminAddress: process.env.ADMIN_ADDRESS!,
    treasuryAddress: process.env.TREASURY_ADDRESS!,
    feeRateBps,
    secretKey: process.env.STELLAR_SECRET_KEY!
  };
}

// Execute command and handle errors
function runCommand(command: string, description: string): void {
  console.log(`🔧 ${description}...`);
  try {
    execSync(command, { stdio: 'inherit', cwd: join(process.cwd(), 'contracts') });
    console.log(`✅ ${description} completed`);
  } catch (error) {
    console.error(`❌ ${description} failed:`, error);
    process.exit(1);
  }
}

// Get network-specific configuration
function getNetworkConfig(network: string) {
  const configs = {
    testnet: {
      rpcUrl: 'https://soroban-testnet.stellar.org',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      friendbotUrl: 'https://friendbot.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015'
    },
    mainnet: {
      rpcUrl: 'https://soroban-rpc.stellar.org',
      horizonUrl: 'https://horizon.stellar.org',
      friendbotUrl: '',
      networkPassphrase: 'Public Global Stellar Network ; September 2015'
    }
  };
  
  return configs[network as keyof typeof configs];
}

// Save deployment information
function saveDeploymentInfo(info: DeploymentInfo): void {
  const filePath = join(process.cwd(), 'deployment-info.json');
  const existingData = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : {};
  
  // Update or add deployment info for this network
  existingData[info.network] = info;
  existingData.lastUpdated = new Date().toISOString();
  
  writeFileSync(filePath, JSON.stringify(existingData, null, 2));
  console.log(`💾 Deployment info saved to ${filePath}`);
}

// Main deployment function
async function deploy(): Promise<void> {
  console.log('🚀 Starting FlowFi Contract Deployment...\n');
  
  const config = parseArgs();
  const networkConfig = getNetworkConfig(config.network);
  
  console.log(`📋 Configuration:`);
  console.log(`   Network: ${config.network}`);
  console.log(`   Admin: ${config.adminAddress}`);
  console.log(`   Treasury: ${config.treasuryAddress}`);
  console.log(`   Fee Rate: ${config.feeRateBps} bps (${config.feeRateBps / 100}%)`);
  console.log('');

  // Step 1: Build WASM
  console.log('📦 Step 1: Building WASM...');
  runCommand('cargo build --target wasm32-unknown-unknown --release', 'Building WASM');

  // Step 2: Optimize WASM
  console.log('\n⚡ Step 2: Optimizing WASM...');
  const wasmPath = join('contracts', 'target', 'wasm32-unknown-unknown', 'release', 'stream_contract.wasm');
  runCommand(`stellar contract optimize --wasm ${wasmPath}`, 'Optimizing WASM');

  // Step 3: Deploy contract
  console.log('\n🚀 Step 3: Deploying contract...');
  const optimizedWasmPath = wasmPath.replace('.wasm', '.optimized.wasm');
  
  try {
    const deployCommand = [
      'stellar contract deploy',
      `--wasm ${optimizedWasmPath}`,
      `--source ${config.secretKey}`,
      `--network ${networkConfig.rpcUrl}`,
      '--network-passphrase "' + networkConfig.networkPassphrase + '"'
    ].join(' ');
    
    console.log(`🔧 Deploying contract...`);
    const deployOutput = execSync(deployCommand, { 
      encoding: 'utf8', 
      cwd: join(process.cwd(), 'contracts') 
    });
    
    // Extract contract ID from output
    const contractIdMatch = deployOutput.match(/Contract ID: ([A-Z0-9]+)/);
    if (!contractIdMatch) {
      throw new Error('Could not extract contract ID from deployment output');
    }
    
    const contractId = contractIdMatch[1];
    console.log(`✅ Contract deployed with ID: ${contractId}`);

    // Step 4: Initialize contract
    console.log('\n⚙️ Step 4: Initializing contract...');
    const initCommand = [
      'stellar contract invoke',
      `--id ${contractId}`,
      `--source ${config.secretKey}`,
      `--network ${networkConfig.rpcUrl}`,
      '--network-passphrase "' + networkConfig.networkPassphrase + '"',
      'initialize',
      `--admin ${config.adminAddress}`,
      `--treasury ${config.treasuryAddress}`,
      `--fee_rate_bps ${config.feeRateBps}`
    ].join(' ');
    
    console.log(`🔧 Initializing contract...`);
    const initOutput = execSync(initCommand, { 
      encoding: 'utf8', 
      cwd: join(process.cwd(), 'contracts') 
    });
    
    // Extract transaction hash from output
    const txHashMatch = initOutput.match(/Transaction hash: ([A-Z0-9]+)/);
    const txHash = txHashMatch ? txHashMatch[1] : 'unknown';
    
    console.log(`✅ Contract initialized successfully`);

    // Step 5: Save deployment info
    const deploymentInfo: DeploymentInfo = {
      network: config.network,
      contractId,
      deployedAt: new Date().toISOString(),
      adminAddress: config.adminAddress,
      treasuryAddress: config.treasuryAddress,
      feeRateBps: config.feeRateBps,
      transactionHash: txHash
    };
    
    saveDeploymentInfo(deploymentInfo);

    // Step 6: Display summary
    console.log('\n🎉 Deployment Summary:');
    console.log(`   Network: ${config.network}`);
    console.log(`   Contract ID: ${contractId}`);
    console.log(`   Transaction Hash: ${txHash}`);
    console.log(`   Admin: ${config.adminAddress}`);
    console.log(`   Treasury: ${config.treasuryAddress}`);
    console.log(`   Fee Rate: ${config.feeRateBps} bps`);
    console.log(`   Deployed At: ${deploymentInfo.deployedAt}`);
    console.log('\n✅ Deployment completed successfully!');

  } catch (error) {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Handle errors gracefully
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run deployment
if (require.main === module) {
  deploy().catch(error => {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
  });
}
