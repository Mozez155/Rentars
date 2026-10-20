import type { Request, Response } from 'express';
import { Transaction } from '@stellar/stellar-sdk';
import { WalletAuthService } from '@/services/wallet.service.js';
import { getSorobanServer, simulateTransaction } from '@/blockchain/soroban.js';
import { getActiveNetwork, getNetworkPassphrase } from '@/config/network.js';

const walletAuthService = new WalletAuthService();

/**
 * Returns the active network and (optionally) the connected wallet account so
 * the client can display the network before authorizing any operation.
 */
export async function walletStatus(req: Request, res: Response): Promise<void> {
  const network = getActiveNetwork();
  const address = typeof req.query.address === 'string' ? req.query.address : undefined;

  res.json({
    network: network.name,
    networkPassphrase: network.passphrase,
    horizonUrl: network.horizonUrl,
    sorobanRpcUrl: network.sorobanRpcUrl,
    address: address ?? null,
  });
}

/**
 * Clears wallet-scoped state for the given address. Only wallet session data is
 * removed; unrelated account data is left untouched.
 */
export async function walletDisconnect(req: Request, res: Response): Promise<void> {
  const { address } = req.body as { address?: string };

  if (!address || typeof address !== 'string') {
    res.status(400).json({ error: 'address is required' });
    return;
  }

  walletAuthService.clearWalletState(address);
  res.json({ success: true, address });
}

export async function walletChallenge(req: Request, res: Response): Promise<void> {
  const { address } = req.body;

  const result = await walletAuthService.generateChallenge(address);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function walletVerify(req: Request, res: Response): Promise<void> {
  const { address, challenge, signature } = req.body;

  const result = await walletAuthService.verifySignature(address, challenge, signature);

  if (!result.success) {
    res.status(401).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * Preflight simulation endpoint. Accepts an unsigned transaction XDR (base64)
 * and returns a fee estimate and diagnostics without signing or submitting.
 */
export async function walletSimulate(req: Request, res: Response): Promise<void> {
  const { transactionXDr, network, address } = req.body as {
    transactionXDr?: string;
    network?: string;
    address?: string;
  };

  if (!transactionXDr || typeof transactionXDr !== 'string') {
    res.status(400).json({ error: 'transactionXDr is required' });
    return;
  }

  const activeNetwork = getActiveNetwork();

  // Reject any operation tagged with a network other than the active one.
  if (network && network !== activeNetwork.name) {
    res.status(400).json({
      error: `Network mismatch: request targets "${network}" but the backend is configured for "${activeNetwork.name}". Switch your wallet to ${activeNetwork.name} and retry.`,
      code: 'NETWORK_MISMATCH',
      expectedNetwork: activeNetwork.name,
      receivedNetwork: network,
    });
    return;
  }

  let tx: Transaction;
  try {
    tx = new Transaction(transactionXDr, getNetworkPassphrase());
  } catch {
    res.status(400).json({ error: 'Invalid transaction XDR' });
    return;
  }

  // The transaction must be built for the active network passphrase.
  if (tx.networkPassphrase !== getNetworkPassphrase()) {
    res.status(400).json({
      error: `Transaction was built for "${tx.networkPassphrase}" but the backend is configured for "${activeNetwork.name}". Rebuild the transaction on ${activeNetwork.name}.`,
      code: 'NETWORK_MISMATCH',
      expectedNetwork: activeNetwork.name,
    });
    return;
  }

  // If an owner address is supplied, it must match the transaction source.
  if (address && tx.source !== address) {
    res.status(400).json({
      error: 'Account mismatch: the transaction source does not match the connected wallet account. Reconnect your wallet and retry.',
      code: 'ACCOUNT_MISMATCH',
      expectedAddress: tx.source,
      receivedAddress: address,
    });
    return;
  }

  try {
    const result = await simulateTransaction(getSorobanServer(), tx);
    res.json({
      success: result.success,
      network: activeNetwork.name,
      estimatedFeeStroops: result.estimatedFee,
      minResourceFeeStroops: result.minResourceFee,
      events: result.events,
      error: result.error,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
