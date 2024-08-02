const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const bs58 = require('bs58');
const Imap = require('imap');
const simpleParser = require('mailparser').simpleParser;
const chalk = require('chalk');
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

// Suppress secp256k1 warning
process.env.SECP256K1_VERIFY_ONLY = 'true';

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// Initialize connections
const solanaConnection = new Connection(config.solanaRpcUrl, 'confirmed');
const ethProvider = new ethers.providers.JsonRpcProvider(config.ethRpcUrl);
const ethWallet = new ethers.Wallet(config.ethPrivateKey, ethProvider);

// Handle Solana wallet creation
let solanaWallet;
try {
  const secretKey = bs58.decode(config.solanaPrivateKey);
  solanaWallet = Keypair.fromSecretKey(secretKey);
} catch (error) {
  console.error(chalk.red('Error creating Solana wallet:', error.message));
  process.exit(1);
}

// Wormhole contracts
const ETH_TOKEN_BRIDGE_ADDRESS = config.ethTokenBridgeAddress;
const SOL_TOKEN_BRIDGE_ADDRESS = new PublicKey(config.solTokenBridgeAddress);
const WORMHOLE_ADDRESS = new PublicKey(config.wormholeAddress);

// Token addresses
const WSOL_ADDRESS = new PublicKey(config.wsolAddress);
const WETH_ADDRESS = config.wethAddress;

// Trade tracking
let trades = [];
const TRADE_LOG_FILE = 'trade_log.json';

if (fs.existsSync(TRADE_LOG_FILE)) {
  try {
    trades = JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8'));
  } catch (error) {
    console.error(chalk.red('Error reading trade log file:', error.message));
  }
}

function logTrade(trade) {
  trades.push(trade);
  fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(trades, null, 2));
}

function getLastBuyTrade() {
  return trades.filter(t => t.type === 'buy').pop();
}

async function swapEthToSol(ethAmount) {
  console.log(chalk.cyan(`[ETH -> SOL] Initiating swap: ${ethAmount} ETH`));

  try {
    console.log(chalk.yellow('[ETH -> SOL] Approving ETH for transfer'));
    const approveTx = await approveEth(
      ETH_TOKEN_BRIDGE_ADDRESS,
      WETH_ADDRESS,
      ethWallet,
      ethers.utils.parseEther(ethAmount),
      { gasLimit: 300000 }
    );
    await approveTx.wait();
    console.log(chalk.green('[ETH -> SOL] ETH approved'));

    console.log(chalk.yellow('[ETH -> SOL] Transferring to Wormhole'));
    const transferTx = await transferFromEth(
      ETH_TOKEN_BRIDGE_ADDRESS,
      ethWallet,
      WETH_ADDRESS,
      ethers.utils.parseEther(ethAmount),
      CHAIN_ID_SOLANA,
      solanaWallet.publicKey.toBuffer(),
      { gasLimit: 500000 }
    );
    const receipt = await transferTx.wait();
    console.log(chalk.green('[ETH -> SOL] Transfer completed'));

    const sequence = parseSequenceFromLogEth(receipt, ETH_TOKEN_BRIDGE_ADDRESS);
    console.log(chalk.blue(`[ETH -> SOL] Wormhole sequence: ${sequence}`));

    const emitterAddress = getEmitterAddressEth(ETH_TOKEN_BRIDGE_ADDRESS);
    console.log(chalk.yellow('[ETH -> SOL] Fetching signed VAA'));
    const { data: signedVAA } = await axios.get(`${config.wormholeRpcHost}/v1/signed_vaa/${CHAIN_ID_ETH}/${emitterAddress}/${sequence}`);

    console.log(chalk.yellow('[ETH -> SOL] Posting VAA to Solana'));
    await postVaaSolana(solanaConnection, solanaWallet.publicKey, signedVAA, SOL_TOKEN_BRIDGE_ADDRESS);

    console.log(chalk.yellow('[ETH -> SOL] Redeeming on Solana'));
    const redeemTx = await redeemOnSolana(
      solanaConnection,
      SOL_TOKEN_BRIDGE_ADDRESS,
      WORMHOLE_ADDRESS,
      solanaWallet.publicKey,
      signedVAA
    );

    console.log(chalk.green(`[ETH -> SOL] Swap completed. Tx: ${redeemTx}`));

    const trade = { type: 'buy', ethAmount, timestamp: Date.now(), txHash: redeemTx };
    logTrade(trade);

    return trade;
  } catch (error) {
    console.error(chalk.red(`[ETH -> SOL] Swap failed: ${error.message}`));
    throw error;
  }
}

async function swapSolToEth(solAmount) {
  console.log(chalk.cyan(`[SOL -> ETH] Initiating swap: ${solAmount} SOL`));

  try {
    console.log(chalk.yellow('[SOL -> ETH] Transferring SOL to Wormhole'));
    const transferIx = SystemProgram.transfer({
      fromPubkey: solanaWallet.publicKey,
      toPubkey: SOL_TOKEN_BRIDGE_ADDRESS,
      lamports: solAmount * 1e9
    });

    const { blockhash } = await solanaConnection.getRecentBlockhash();
    const transaction = new Transaction().add(transferIx);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = solanaWallet.publicKey;

    const signedTx = await solanaWallet.signTransaction(transaction);
    const txId = await solanaConnection.sendRawTransaction(signedTx.serialize());
    console.log(chalk.blue(`[SOL -> ETH] SOL transfer tx: ${txId}`));

    const confirmedTx = await solanaConnection.confirmTransaction(txId);
    const sequence = parseSequenceFromLogSolana(confirmedTx);
    console.log(chalk.blue(`[SOL -> ETH] Wormhole sequence: ${sequence}`));

    const emitterAddress = await getEmitterAddressSolana(SOL_TOKEN_BRIDGE_ADDRESS);
    console.log(chalk.yellow('[SOL -> ETH] Fetching signed VAA'));
    const { data: signedVAA } = await axios.get(`${config.wormholeRpcHost}/v1/signed_vaa/${CHAIN_ID_SOLANA}/${emitterAddress}/${sequence}`);

    console.log(chalk.yellow('[SOL -> ETH] Redeeming on Ethereum'));
    const redeemTx = await redeemOnEth(
      ETH_TOKEN_BRIDGE_ADDRESS,
      ethWallet,
      signedVAA,
      { gasLimit: 500000 }
    );

    const receipt = await redeemTx.wait();
    const ethAmount = ethers.utils.formatEther(receipt.logs[1].data);

    console.log(chalk.green(`[SOL -> ETH] Swap completed. Received ${ethAmount} ETH`));

    const trade = { type: 'sell', solAmount, ethAmount, timestamp: Date.now(), txHash: redeemTx.hash };
    logTrade(trade);

    return trade;
  } catch (error) {
    console.error(chalk.red(`[SOL -> ETH] Swap failed: ${error.message}`));
    throw error;
  }
}

async function getSolBalance() {
  const balance = await solanaConnection.getBalance(solanaWallet.publicKey);
  return balance / 1e9;
}

async function getEthBalance() {
  const balance = await ethProvider.getBalance(ethWallet.address);
  return ethers.utils.formatEther(balance);
}

function handleEmail(email) {
  console.log(chalk.blue(`[Email] Received: ${email.subject}`));
  
  if (email.subject !== config.email.triggerSubject) {
    console.log(chalk.yellow('[Email] Ignoring: Incorrect subject'));
    return;
  }

  let emailContent = email.text || email.html;
  if (!emailContent) {
    console.log(chalk.yellow('[Email] Ignoring: Empty content'));
    return;
  }

  emailContent = emailContent.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  const buyMatch = emailContent.match(/Quanta exoTrader order buy/i);
  const sellMatch = emailContent.match(/Quanta exoTrader order sell/i);

  if (buyMatch) {
    console.log(chalk.green('[Trade Signal] BUY signal detected'));
    handleBuySignal();
  } else if (sellMatch) {
    console.log(chalk.red('[Trade Signal] SELL signal detected'));
    handleSellSignal();
  } else {
    console.log(chalk.yellow('[Email] Ignoring: No trade signal detected'));
  }
}

async function handleBuySignal() {
  const ethBalance = await getEthBalance();
  const ethAmount = config.tradeAmount.eth;

  if (parseFloat(ethBalance) < parseFloat(ethAmount)) {
    console.log(chalk.red(`[Buy] Insufficient ETH balance: ${ethBalance} ETH`));
    return;
  }

  try {
    const trade = await swapEthToSol(ethAmount);
    console.log(chalk.green(`[Buy] Completed: ${ethAmount} ETH -> SOL`));
  } catch (error) {
    console.error(chalk.red('[Buy] Failed:', error.message));
  }
}

async function handleSellSignal() {
  const lastBuy = getLastBuyTrade();
  if (!lastBuy) {
    console.log(chalk.yellow('[Sell] No previous buy trade found'));
    return;
  }

  const solBalance = await getSolBalance();
  
  if (solBalance === 0) {
    console.log(chalk.red(`[Sell] Insufficient SOL balance: ${solBalance} SOL`));
    return;
  }

  try {
    const trade = await swapSolToEth(solBalance.toString());
    console.log(chalk.green(`[Sell] Completed: ${solBalance} SOL -> ${trade.ethAmount} ETH`));
    
    const profit = parseFloat(trade.ethAmount) - parseFloat(lastBuy.ethAmount);
    console.log(chalk.blue(`[Profit] ${profit > 0 ? '+' : ''}${profit.toFixed(6)} ETH`));
  } catch (error) {
    console.error(chalk.red('[Sell] Failed:', error.message));
  }
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
    console.log(chalk.green('[Email] Connected to IMAP server'));
    openInbox(function(err, box) {
      if (err) {
        console.error(chalk.red('[Email] Error opening inbox:', err.message));
        return;
      }
      console.log(chalk.green('[Email] Inbox opened, waiting for alerts...'));
      imap.on('mail', function() {
        const f = imap.seq.fetch('*', {
          bodies: '',
          markSeen: true
        });
        f.on('message', function(msg) {
          msg.on('body', function(stream) {
            simpleParser(stream, (err, parsed) => {
              if (err) {
                console.error(chalk.red('[Email] Parse error:', err.message));
                return;
              }
              handleEmail(parsed);
            });
          });
        });
      });
    });
  });

  imap.once('error', function(err) {
    console.error(chalk.red('[Email] IMAP error:', err.message));
  });

  imap.once('end', function() {
    console.log(chalk.yellow('[Email] IMAP connection ended'));
  });

  imap.connect();
}

async function main() {
  console.log(chalk.green('=== DeFi Trading Bot Started ==='));
  console.log(chalk.blue(`Ethereum Wallet: ${ethWallet.address}`));
  console.log(chalk.blue(`Solana Wallet: ${solanaWallet.publicKey.toString()}`));

  const ethBalance = await getEthBalance();
  const solBalance = await getSolBalance();
  console.log(chalk.cyan(`ETH Balance: ${ethBalance} ETH`));
  console.log(chalk.cyan(`SOL Balance: ${solBalance} SOL`));

  setupEmailListener();
}

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('Unhandled Rejection:', reason.message || reason));
});

process.on('uncaughtException', (error) => {
  console.error(chalk.red('Uncaught Exception:', error.message));
});

main().catch(error => {
  console.error(chalk.red('Fatal error:', error.message));
  process.exit(1);
});