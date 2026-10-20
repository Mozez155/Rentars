import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { supabase } from '@/config/supabase.js';
import { getJwtSecret } from '@/config/jwtSecret.js';
import { getNetworkConfig, type StellarNetwork } from '@/config/network.js';
import type { ServiceResponse } from './index.js';

export interface ChallengeResponse {
  challenge: string;
  network: StellarNetwork;
}

export interface VerifyResponse {
  token: string;
  address: string;
  network: StellarNetwork;
}

export interface WalletOperationContext {
  /** Address the operation was started with (the operation owner). */
  ownerAddress: string;
  /** Network the operation was started on. */
  network: string;
}

export interface ActiveWalletState {
  address: string;
  network: string;
}

const CHALLENGE_EXPIRY = 5 * 60 * 1000; // 5 minutes

export class WalletAuthService {
  async generateChallenge(
    address: string,
    network?: string,
  ): Promise<ServiceResponse<ChallengeResponse>> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return { success: false, error: 'Invalid Stellar address' };
    }

    const networkCheck = this.resolveNetwork(network);
    if (!networkCheck.success) {
      return networkCheck;
    }
    const activeNetwork = networkCheck.data;

    try {
      // 256 bits of randomness, single use (consumed in verifySignature).
      const challenge = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY);

      // Store challenge in database, tagged with the network it was issued for
      // so a signature produced on another network cannot be replayed.
      const { error } = await supabase.from('wallet_challenges').insert({
        address,
        challenge,
        network: activeNetwork,
        expires_at: expiresAt.toISOString(),
      });

      if (error) {
        return { success: false, error: 'Failed to generate challenge' };
      }

      return { success: true, data: { challenge, network: activeNetwork } };
    } catch (err) {
      return { success: false, error: 'Challenge generation failed' };
    }
  }

  async verifySignature(
    address: string,
    challenge: string,
    signature: string,
    network?: string,
  ): Promise<ServiceResponse<VerifyResponse>> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return { success: false, error: 'Invalid Stellar address' };
    }

    const networkCheck = this.resolveNetwork(network);
    if (!networkCheck.success) {
      return networkCheck;
    }
    const activeNetwork = networkCheck.data;

    try {
      // Consume the challenge atomically before checking the signature. A
      // delete that returns no row means another request already used it, so
      // concurrent replays cannot both succeed. The network is part of the
      // match so a challenge issued for another network is rejected.
      const { data: consumed, error: consumeError } = await supabase
        .from('wallet_challenges')
        .delete()
        .eq('address', address)
        .eq('challenge', challenge)
        .eq('network', activeNetwork)
        .gt('expires_at', new Date().toISOString())
        .select('id');

      if (consumeError || !consumed || consumed.length === 0) {
        return {
          success: false,
          error: 'Challenge not found, expired, or issued for a different network',
        };
      }

      // Verify signature over the challenge bytes
      try {
        const keypair = Keypair.fromPublicKey(address);
        const signatureBuffer = Buffer.from(signature, 'base64');
        const challengeBuffer = Buffer.from(challenge);

        if (!keypair.verify(challengeBuffer, signatureBuffer)) {
          return { success: false, error: 'Invalid signature' };
        }
      } catch (err) {
        return { success: false, error: 'Invalid signature' };
      }

      const token = jwt.sign({ address, type: 'wallet' }, getJwtSecret(), { expiresIn: '24h' });

      // Create or update user profile
      const { error: upsertError } = await supabase.from('profiles').upsert({
        stellar_address: address,
        updated_at: new Date().toISOString(),
      });

      if (upsertError) {
        return { success: false, error: 'Failed to create user profile' };
      }

      return { success: true, data: { token, address, network: activeNetwork } };
    } catch (err) {
      return { success: false, error: 'Verification failed' };
    }
  }

  /**
   * Ensure the wallet's active address and network still match the operation
   * owner and the configured network. Used before signing, submission and
   * reconciliation so a stale signature or a network switch cannot silently
   * continue a pending operation.
   */
  assertOperationContext(
    operation: WalletOperationContext,
    active: ActiveWalletState,
  ): ServiceResponse<{ address: string; network: StellarNetwork }> {
    if (!StrKey.isValidEd25519PublicKey(active.address)) {
      return { success: false, error: 'Invalid active wallet address' };
    }

    if (active.address !== operation.ownerAddress) {
      return {
        success: false,
        error:
          'Active wallet account does not match the account that started this operation. ' +
          'Reconnect the original account or restart the flow.',
      };
    }

    const networkCheck = this.resolveNetwork(active.network);
    if (!networkCheck.success) {
      return networkCheck;
    }
    const activeNetwork = networkCheck.data;

    const operationNetwork = this.resolveNetwork(operation.network);
    if (!operationNetwork.success) {
      return operationNetwork;
    }

    if (operationNetwork.data !== activeNetwork) {
      return {
        success: false,
        error:
          `Network mismatch: this operation was started on ${operationNetwork.data} ` +
          `but the wallet is now on ${activeNetwork}. Switch the wallet back to ` +
          `${operationNetwork.data} and retry.`,
      };
    }

    return { success: true, data: { address: active.address, network: activeNetwork } };
  }

  /**
   * Clear only wallet-scoped state for the given address. Unrelated account
   * data (profiles, bookings, etc.) is left untouched.
   */
  async disconnectWallet(address: string): Promise<ServiceResponse<{ cleared: boolean }>> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return { success: false, error: 'Invalid Stellar address' };
    }

    try {
      const { error } = await supabase
        .from('wallet_challenges')
        .delete()
        .eq('address', address);

      if (error) {
        return { success: false, error: 'Failed to clear wallet state' };
      }

      return { success: true, data: { cleared: true } };
    } catch (err) {
      return { success: false, error: 'Failed to clear wallet state' };
    }
  }

  /**
   * Resolve and validate a network identifier against the centralized
   * configuration. Production must never silently fall back to testnet.
   */
  private resolveNetwork(network?: string): ServiceResponse<StellarNetwork> {
    let config: ReturnType<typeof getNetworkConfig>;
    try {
      config = getNetworkConfig();
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Invalid network configuration',
      };
    }

    const requested = (network ?? config.network).toLowerCase();
    if (requested !== config.network) {
      return {
        success: false,
        error:
          `Network mismatch: expected ${config.network} but received ${requested}. ` +
          'Ensure the wallet and backend are configured for the same Stellar network.',
      };
    }

    return { success: true, data: config.network };
  }
}
