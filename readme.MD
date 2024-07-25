# DeFi Trading Bot: Cross-Chain Swaps between Ethereum and Solana

## Table of Contents
1. [Introduction](#introduction)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [How It Works](#how-it-works)
6. [Swap Mechanism and Wormhole Integration](#swap-mechanism-and-wormhole-integration)
7. [Usage](#usage)
8. [Troubleshooting](#troubleshooting)
9. [Security Considerations](#security-considerations)
10. [Contributing](#contributing)

## Introduction

This DeFi trading bot facilitates cross-chain swaps between Ethereum (ETH) and Solana (SOL) using the Wormhole bridge for Dave's exo strat. It can be triggered via email alerts or webhooks, allowing for automated trading based on exo's TV alerts. The bot leverages the Wormhole protocol to enable seamless and secure transfer of assets between these two distinct blockchain ecosystems.

## Prerequisites

Before setting up the bot, ensure you have the following:

- Node.js (v14 or later)
- npm (v6 or later)
- A Solana wallet with SOL
- An Ethereum wallet with ETH
- Infura account for Ethereum RPC access
- Gmail account (for email alerts)
- Basic understanding of blockchain concepts, DeFi, and cross-chain bridges

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/SnypeAI/DeFiExo.git
   cd DeFiExo
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the example configuration file:
   ```bash
   cp config.example.json config.json
   ```

4. Edit `config.json` with your specific details (see [Configuration](#configuration) section).

## Configuration

Edit the `config.json` file with your specific details:

```json
{
  "solanaRpcUrl": "https://api.mainnet-beta.solana.com",
  "ethRpcUrl": "https://mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID",
  "ethPrivateKey": "YOUR_ETHEREUM_PRIVATE_KEY",
  "solanaPrivateKey": "YOUR_SOLANA_PRIVATE_KEY",
  "ethTokenBridgeAddress": "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
  "solTokenBridgeAddress": "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
  "wormholeAddress": "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  "wsolAddress": "So11111111111111111111111111111111111111112",
  "wethAddress": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "wormholeRpcHost": "https://wormhole-v2-mainnet-api.certus.one",
  "alertMode": "email",
  "serverPort": 3000,
  "email": {
    "imap": {
      "host": "imap.gmail.com",
      "port": 993,
      "user": "YOUR_GMAIL_ADDRESS@gmail.com",
      "password": "YOUR_GMAIL_APP_PASSWORD",
      "tls": true
    },
    "triggerSubject": "TradingView Alert"
  }
}
```

### Configuration Details:
- `solanaRpcUrl`: Solana RPC endpoint (use mainnet for live trading)
- `ethRpcUrl`: Ethereum RPC endpoint (use your Infura project URL)
- `ethPrivateKey`: Your Ethereum wallet's private key
- `solanaPrivateKey`: Your Solana wallet's private key
- `ethTokenBridgeAddress`: Wormhole Token Bridge address on Ethereum
- `solTokenBridgeAddress`: Wormhole Token Bridge address on Solana
- `wormholeAddress`: Wormhole core contract address on Solana
- `wsolAddress`: Wrapped SOL token address
- `wethAddress`: Wrapped ETH token address
- `wormholeRpcHost`: Wormhole RPC endpoint
- `alertMode`: Set to "email" for email alerts or "webhook" for webhook triggers
- `serverPort`: Port for the webhook server (if using webhook mode)
- `email`: Configuration for email alerts (if using email mode)

### Setting up Gmail App Password:
1. Go to your Google Account settings (https://myaccount.google.com/)
2. Navigate to Security > 2-Step Verification > App passwords
3. Select "Other (Custom name)" from the dropdown, name it "DeFi Trading Bot"
4. Click "Generate" and use the generated 16-character password in your config

## How It Works

The bot operates in two main modes:

1. **Email Alert Mode**: It monitors a specified Gmail inbox for emails with a specific subject. When a matching email is received, it parses the content and triggers a swap.

2. **Webhook Mode**: It sets up a local server that listens for incoming POST requests. When a request is received, it triggers a swap based on the request payload.

The core functionality is implemented in `exo.js`, which handles:
- Initializing connections to Ethereum and Solana networks
- Setting up email listener or webhook server
- Executing cross-chain swaps using the Wormhole bridge
- Error handling and logging

## Swap Mechanism and Wormhole Integration

The bot facilitates cross-chain swaps using the Wormhole Token Bridge, a key component of the Wormhole protocol. Wormhole acts as a message passing system between blockchains, allowing for the transfer of tokens and arbitrary data between supported chains.

### Wormhole Protocol Overview:
Wormhole consists of several key components:
1. **Core Bridge**: The main contract that handles message passing between chains.
2. **Token Bridge**: Specialized contracts for handling token transfers.
3. **Guardians**: A network of nodes that observe and validate cross-chain messages.
4. **VAAs (Verified Action Approvals)**: Signed messages that represent validated cross-chain actions.

### Detailed Swap Process:

#### ETH to SOL Swap:
1. **Initiation**: 
   - The bot calls `swapEthToSol` function with the amount of ETH to swap.
   - It uses the `approveEth` function from the Wormhole SDK to approve the ETH amount for transfer.

2. **Locking ETH**:
   - The bot calls `transferFromEth` to transfer ETH to the Wormhole Token Bridge on Ethereum.
   - This function interacts with the Ethereum Token Bridge contract, locking the ETH and emitting an event.

3. **VAA Generation**:
   - Wormhole Guardians observe the event on Ethereum.
   - They reach consensus and generate a VAA (Verified Action Approval).

4. **Retrieving VAA**:
   - The bot queries the Wormhole RPC (`config.wormholeRpcHost`) to get the signed VAA.
   - It uses `getEmitterAddressEth` and `parseSequenceFromLogEth` to construct the query.

5. **Redeeming on Solana**:
   - The bot calls `postVaaSolana` to submit the VAA to Solana.
   - It then calls `redeemOnSolana` to finalize the transfer.
   - This interacts with the Solana Token Bridge, which mints the equivalent amount of wrapped ETH (WETH) on Solana.

6. **Completion**:
   - The user receives WETH in their Solana wallet, representing their transferred ETH.

#### SOL to ETH Swap:
1. **Initiation**:
   - The bot calls `swapSolToEth` function with the amount of SOL to swap.

2. **Locking SOL**:
   - The bot creates a Solana transaction to transfer SOL to the Wormhole Token Bridge on Solana.
   - This locks the SOL and emits an event on Solana.

3. **VAA Generation**:
   - Similar to the ETH to SOL process, Guardians observe the Solana event and generate a VAA.

4. **Retrieving VAA**:
   - The bot queries the Wormhole RPC to get the signed VAA, using `getEmitterAddressSolana` and `parseSequenceFromLogSolana`.

5. **Redeeming on Ethereum**:
   - The bot calls `redeemOnEth` to submit the VAA and finalize the transfer on Ethereum.
   - This interacts with the Ethereum Token Bridge, which releases the equivalent amount of ETH.

6. **Completion**:
   - The user receives native ETH in their Ethereum wallet.

### Key Aspects of the Swap Process:
- **Atomicity**: The swap is atomic, meaning it either completes entirely or fails entirely, preventing partial transfers.
- **Security**: Wormhole's Guardian network ensures that only valid, consensus-approved transfers are processed.
- **Wrapped Tokens**: On Solana, users receive wrapped ETH (WETH), while on Ethereum, they receive native ETH. This is due to the different token standards on each chain.
- **Gas Fees**: Users need to pay gas fees on both chains - for locking tokens on the source chain and for redeeming on the destination chain.

### Wormhole's Role:
- **Cross-Chain Communication**: Wormhole enables the secure passage of information between Ethereum and Solana.
- **Token Locking and Minting**: It ensures that tokens are properly locked on one chain before being minted or released on the other.
- **Consensus and Validation**: The Guardian network provides a layer of security, validating cross-chain messages.
- **Standardized Interface**: Wormhole provides a consistent interface for interacting with different blockchains, simplifying cross-chain operations.

## Usage

1. Start the bot:
   ```bash
   npm start
   ```

2. The bot will initialize, display balance information, and start listening for triggers based on the configured alert mode.

3. For email mode, send an email to your configured Gmail address with the subject specified in `config.json`. The email body should be a JSON string like:
   ```json
   {"action": "buy_eth", "amount": 1000000000}
   ```
   or
   ```json
   {"action": "buy_sol", "amount": "1000000000000000000"}
   ```

4. For webhook mode, send a POST request to `http://localhost:YOUR_PORT/webhook` with a JSON body as shown above.

## Troubleshooting

- **IMAP connection issues**: Ensure your Gmail App Password is correct and that IMAP is enabled in your Gmail settings.
- **RPC errors**: Check your Infura project ID and ensure you have sufficient credits.
- **Insufficient balance errors**: Ensure your wallets have enough ETH/SOL for the swap and gas fees.
- **Wormhole-related errors**: 
  - Check the Wormhole status page (https://wormholenetwork.com/network-status/) for any ongoing issues.
  - Ensure you're using the latest contract addresses from the Wormhole documentation.
  - Verify that the Wormhole RPC endpoint is responsive and correctly configured.

## Security Considerations

- **Private Key Management**: Never share your `config.json` file or commit it to version control. Consider using a hardware wallet or more secure key management system for production use.
- **Environmental Variables**: Use environment variables for sensitive information in production environments.
- **Regular Updates**: Keep all dependencies updated to patch potential vulnerabilities. This includes the Wormhole SDK and other blockchain-related libraries.
- **Transaction Monitoring**: Implement additional monitoring to track the status of cross-chain transactions and handle any failures or unexpected behaviors.
- **Rate Limiting**: Consider implementing rate limiting to prevent excessive swaps that could deplete funds or trigger suspicious activity flags.
- **Error Handling**: Ensure comprehensive error handling to prevent the bot from entering an undefined state or exposing sensitive information in logs.
- **Audit**: Before using significant amounts of funds, consider having the bot's code audited by a blockchain security firm.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your proposed changes.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a pull request

---

