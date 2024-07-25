const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { ethers } = require('ethers');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const bs58 = require('bs58');
const Imap = require('imap');
const simpleParser = require('mailparser').simpleParser;
const {
  CHAIN_ID_ETH,
  CHAIN_ID_SOLANA,
  getEmitterAddressEth,
  getEmitterAddressSolana,
  parseSequenceFromLogEth,
  parseSequenceFromLogSolana,
  approveEth,
  transferFromEth,
  postVaaSolana,
  redeemOnSolana,
  getForeignAssetSolana,
  getOriginalAssetEth,
  redeemOnEth
} = require('@certusone/wormhole-sdk');

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// Initialize connections
const solanaConnection = new Connection(config.solanaRpcUrl);
const ethProvider = new ethers.providers.JsonRpcProvider(config.ethRpcUrl);
const ethWallet = new ethers.Wallet(config.ethPrivateKey, ethProvider);

// Handle Solana wallet creation
let solanaWallet;
try {
  const secretKey = bs58.decode(config.solanaPrivateKey);
  solanaWallet = Keypair.fromSecretKey(secretKey);
} catch (error) {
  console.error('Error creating Solana wallet:', error);
  process.exit(1);
}

// Wormhole contracts
const ETH_TOKEN_BRIDGE_ADDRESS = config.ethTokenBridgeAddress;
const SOL_TOKEN_BRIDGE_ADDRESS = new PublicKey(config.solTokenBridgeAddress);
const WORMHOLE_ADDRESS = new PublicKey(config.wormholeAddress);

// Token addresses
const WSOL_ADDRESS = new PublicKey(config.wsolAddress);
const WETH_ADDRESS = config.wethAddress;

async function swapSolToEth(amount) {
  console.log(`Initiating SOL to ETH swap for ${amount} SOL`);

  try {
    // 1. Approve and transfer SOL to Wormhole
    const transferIx = SystemProgram.transfer({
      fromPubkey: solanaWallet.publicKey,
      toPubkey: SOL_TOKEN_BRIDGE_ADDRESS,
      lamports: amount
    });

    const { blockhash } = await solanaConnection.getRecentBlockhash();
    const transaction = new Transaction().add(transferIx);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = solanaWallet.publicKey;

    const signedTx = await solanaWallet.signTransaction(transaction);
    const txId = await solanaConnection.sendRawTransaction(signedTx.serialize());
    console.log(`SOL transfer transaction sent: ${txId}`);

    // 2. Get the sequence number from the Solana log
    const confirmedTx = await solanaConnection.confirmTransaction(txId);
    const sequence = parseSequenceFromLogSolana(confirmedTx);

    // 3. Get the signed VAA from the Wormhole network
    const emitterAddress = await getEmitterAddressSolana(SOL_TOKEN_BRIDGE_ADDRESS);
    const { data: signedVAA } = await axios.get(`${config.wormholeRpcHost}/v1/signed_vaa/${CHAIN_ID_SOLANA}/${emitterAddress}/${sequence}`);

    // 4. Redeem on Ethereum
    const redeemTx = await redeemOnEth(
      ETH_TOKEN_BRIDGE_ADDRESS,
      ethWallet,
      signedVAA
    );

    console.log(`ETH redeem transaction sent: ${redeemTx.hash}`);
    await redeemTx.wait();

    console.log(`SOL to ETH swap completed`);
  } catch (error) {
    console.error(`Error in SOL to ETH swap: ${error.message}`);
  }
}

async function swapEthToSol(amount) {
  console.log(`Initiating ETH to SOL swap for ${amount} ETH`);

  try {
    // 1. Approve ETH for transfer
    const approveTx = await approveEth(
      ETH_TOKEN_BRIDGE_ADDRESS,
      WETH_ADDRESS,
      ethWallet,
      amount
    );
    await approveTx.wait();

    // 2. Transfer ETH to Wormhole
    const transferTx = await transferFromEth(
      ETH_TOKEN_BRIDGE_ADDRESS,
      ethWallet,
      WETH_ADDRESS,
      amount,
      CHAIN_ID_SOLANA,
      solanaWallet.publicKey.toBuffer()
    );
    const receipt = await transferTx.wait();

    // 3. Get the sequence number from the Ethereum log
    const sequence = parseSequenceFromLogEth(receipt, ETH_TOKEN_BRIDGE_ADDRESS);

    // 4. Get the signed VAA from the Wormhole network
    const emitterAddress = getEmitterAddressEth(ETH_TOKEN_BRIDGE_ADDRESS);
    const { data: signedVAA } = await axios.get(`${config.wormholeRpcHost}/v1/signed_vaa/${CHAIN_ID_ETH}/${emitterAddress}/${sequence}`);

    // 5. Post VAA to Solana
    await postVaaSolana(solanaConnection, solanaWallet.publicKey, signedVAA, SOL_TOKEN_BRIDGE_ADDRESS);

    // 6. Redeem on Solana
    const redeemTx = await redeemOnSolana(
      solanaConnection,
      SOL_TOKEN_BRIDGE_ADDRESS,
      WORMHOLE_ADDRESS,
      solanaWallet.publicKey,
      signedVAA
    );

    console.log(`SOL redeem transaction sent: ${redeemTx}`);

    console.log(`ETH to SOL swap completed`);
  } catch (error) {
    console.error(`Error in ETH to SOL swap: ${error.message}`);
  }
}

async function handleAlert(alert) {
  try {
    if (alert.action === 'buy_eth') {
      await swapSolToEth(alert.amount);
    } else if (alert.action === 'buy_sol') {
      await swapEthToSol(alert.amount);
    } else {
      console.error(`Invalid action: ${alert.action}`);
    }
  } catch (error) {
    console.error(`Error handling alert: ${error.message}`);
  }
}

function setupWebhook() {
  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    handleAlert(req.body);
    res.sendStatus(200);
  });

  app.listen(config.serverPort, () => console.log(`Webhook server running on port ${config.serverPort}`));
}

function setupEmailListener() {
  const imapConfig = {
    ...config.email.imap,
    tlsOptions: { rejectUnauthorized: false }
  };

  const imap = new Imap(imapConfig);

  function openInbox(cb) {
    imap.openBox('INBOX', false, cb);
  }

  imap.once('ready', function() {
    console.log('Connected to IMAP server');
    openInbox(function(err, box) {
      if (err) {
        console.error('Error opening inbox:', err);
        return;
      }
      console.log('Inbox opened, waiting for emails...');
      imap.on('mail', function() {
        console.log('New email received');
        const f = imap.seq.fetch('*', {
          bodies: ['HEADER', 'TEXT'],
          markSeen: true
        });
        f.on('message', function(msg) {
          msg.on('body', function(stream, info) {
            simpleParser(stream, (err, parsed) => {
              if (err) {
                console.error('Error parsing email:', err);
                return;
              }
              if (parsed.subject === config.email.triggerSubject) {
                console.log('Received a trigger email');
                try {
                  const alertData = JSON.parse(parsed.text);
                  handleAlert(alertData);
                } catch (error) {
                  console.error('Error parsing email body:', error);
                }
              }
            });
          });
        });
      });
    });
  });

  imap.once('error', function(err) {
    console.error('IMAP error:', err);
  });

  imap.once('end', function() {
    console.log('IMAP connection ended');
  });

  imap.connect();
}

async function getEthBalance() {
  try {
    const balance = await ethProvider.getBalance(ethWallet.address);
    console.log(`ETH balance: ${ethers.utils.formatEther(balance)} ETH`);
  } catch (error) {
    console.error('Error getting ETH balance:', error.message);
  }
}

async function getSolBalance() {
  try {
    const balance = await solanaConnection.getBalance(solanaWallet.publicKey);
    console.log(`SOL balance: ${balance / 1e9} SOL`);
  } catch (error) {
    console.error('Error getting SOL balance:', error.message);
  }
}

async function getForeignAssetInfo() {
  try {
    const foreignAsset = await getForeignAssetSolana(
      solanaConnection,
      new PublicKey(SOL_TOKEN_BRIDGE_ADDRESS),
      CHAIN_ID_ETH,
      Buffer.from(WETH_ADDRESS.slice(2), 'hex')
    );
    console.log(`Foreign asset on Solana for WETH: ${foreignAsset ? foreignAsset.toString() : 'Not found'}`);
  } catch (error) {
    console.error('Error getting foreign asset info:', error.message);
  }
}

async function getOriginalAssetInfo() {
  try {
    const originalAsset = await getOriginalAssetEth(
      ETH_TOKEN_BRIDGE_ADDRESS,
      ethProvider,
      CHAIN_ID_SOLANA,
      WSOL_ADDRESS.toBuffer()
    );
    console.log(`Original asset on Ethereum for WSOL: ${originalAsset ? originalAsset : 'Not found'}`);
  } catch (error) {
    console.error('Error getting original asset info:', error.message);
  }
}

// Main execution
async function main() {
  try {
    await getEthBalance();
    await getSolBalance();
    await getForeignAssetInfo();
    await getOriginalAssetInfo();

    if (config.alertMode === 'webhook') {
      setupWebhook();
    } else if (config.alertMode === 'email') {
      setupEmailListener();
    } else {
      console.error('Invalid alert mode specified in config');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error in main execution:', error);
  }
}

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

main();