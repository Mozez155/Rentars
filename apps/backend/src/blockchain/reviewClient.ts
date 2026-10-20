/**
 * Backend client for the Review Soroban contract.
 *
 * ABI reference: apps/contracts/review_abi.json
 *
 * This module wraps the @stellar/stellar-sdk contract invocation API and
 * provides typed methods that mirror every function in the ABI.
 */

import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { Review, SubmitReviewParams } from './types.js';
import {
  getContractRegistryEntry,
  resolveNetworkConfig,
  type ContractRegistryEntry,
  type NetworkConfig,
} from './contractRegistry.js';

// ─── Client ──────────────────────────────────────────────────────────────────

export class ReviewClient {
  private readonly contract: Contract;
  private readonly server: rpc.Server;
  private readonly network: NetworkConfig;
  private readonly registry: ContractRegistryEntry;

  /**
   * @param contractId  Contract ID to invoke. Must match the registry entry for
   *                    the resolved network, otherwise construction fails.
   * @param rpcUrl      Optional RPC URL override; defaults to the centralized
   *                    network configuration.
   * @param network     Optional network name (e.g. 'testnet', 'mainnet').
   *                    Defaults to the centralized configuration; production
   *                    never silently falls back to testnet.
   */
  constructor(contractId: string, rpcUrl?: string, network?: string) {
    this.network = resolveNetworkConfig(network);
    this.registry = getContractRegistryEntry(this.network.name);

    if (contractId !== this.registry.contractId) {
      throw new Error(
        `Contract ID mismatch for network "${this.network.name}": ` +
          `configured ${contractId}, registry expects ${this.registry.contractId}. ` +
          `Refusing to initialize ReviewClient.`,
      );
    }

    const resolvedRpcUrl = rpcUrl ?? this.network.rpcUrl;
    this.contract = new Contract(contractId);
    this.server = new rpc.Server(resolvedRpcUrl, {
      allowHttp: resolvedRpcUrl.startsWith('http://'),
    });
  }

  /** Network name this client is bound to (e.g. 'testnet'). */
  get networkName(): string {
    return this.network.name;
  }

  /** Network passphrase this client is bound to. */
  get networkPassphrase(): string {
    return this.network.passphrase;
  }

  /** Registry metadata (contract ID, WASM hash, ABI version) for this network. */
  get contractMetadata(): ContractRegistryEntry {
    return this.registry;
  }

  /**
   * Assert that a caller-supplied network matches this client's network.
   * Used before submission and reconciliation to reject cross-network intents.
   */
  assertNetwork(expectedNetwork: string | undefined): void {
    if (!expectedNetwork) {
      throw new Error(
        `Missing network on intent; this client is bound to "${this.network.name}". ` +
          `Refusing to proceed.`,
      );
    }
    if (expectedNetwork !== this.network.name) {
      throw new Error(
        `Network mismatch: intent targets "${expectedNetwork}" but backend is ` +
          `configured for "${this.network.name}". Refusing to sign or submit.`,
      );
    }
  }

  // ── Read-only queries ─────────────────────────────────────────────────────

  /**
   * Retrieve a review by its global ID.
   *
   * ABI: get_review(id: u64) -> Review
   */
  async getReview(id: bigint): Promise<Review> {
    const result = await this.simulateReadOnly('get_review', [
      nativeToScVal(id, { type: 'u64' }),
    ]);
    return scValToNative(result) as Review;
  }

  /**
   * Return all review IDs submitted for a given reviewee.
   *
   * ABI: get_reviews_for_user(reviewee: Address) -> Vec<u64>
   */
  async getReviewsForUser(reviewee: string): Promise<bigint[]> {
    const result = await this.simulateReadOnly('get_reviews_for_user', [
      nativeToScVal(reviewee, { type: 'address' }),
    ]);
    const native = scValToNative(result) as (number | string)[];
    return native.map((v) => BigInt(v));
  }

  /**
   * Return the average rating for a reviewee scaled by 100.
   *
   * ABI: get_reputation(reviewee: Address) -> u32
   *
   * Returns 0 if no reviews exist. Divide by 100 to get the decimal average
   * (e.g. 450 → 4.50 stars).
   */
  async getReputation(reviewee: string): Promise<number> {
    const result = await this.simulateReadOnly('get_reputation', [
      nativeToScVal(reviewee, { type: 'address' }),
    ]);
    return scValToNative(result) as number;
  }

  /**
   * Return the total number of reviews ever submitted.
   *
   * ABI: review_count() -> u64
   */
  async reviewCount(): Promise<bigint> {
    const result = await this.simulateReadOnly('review_count', []);
    return BigInt(scValToNative(result) as number | string);
  }

  // ── State-changing operations ─────────────────────────────────────────────

  /**
   * Build the XDR operation for submit_review.
   *
   * ABI: submit_review(reviewer, reviewee, rating, comment) -> u64
   *
   * The caller is responsible for wrapping in a transaction, signing with
   * the reviewer's keypair, and submitting via the Stellar network.
   *
   * Constraints enforced on-chain:
   *   - rating must be 1–5 inclusive
   *   - reviewer may only review each reviewee once
   */
  buildSubmitReview(params: SubmitReviewParams): xdr.Operation {
    // Reject intents tagged for a different network before building the op.
    this.assertNetwork(params.network);

    if (params.rating < 1 || params.rating > 5) {
      throw new RangeError(
        `Rating must be between 1 and 5 inclusive, got ${params.rating}`,
      );
    }

    return this.contract.call(
      'submit_review',
      nativeToScVal(params.reviewer, { type: 'address' }),
      nativeToScVal(params.reviewee, { type: 'address' }),
      nativeToScVal(params.rating, { type: 'u32' }),
      nativeToScVal(params.comment, { type: 'string' }),
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Simulate a read-only contract call and return the result ScVal.
   */
  private async simulateReadOnly(
    method: string,
    args: xdr.ScVal[],
  ): Promise<xdr.ScVal> {
    const sourceAccount = await this.server.getAccount(
      process.env.STELLAR_SOURCE_ACCOUNT ||
        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: this.network.passphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(
        `Contract simulation failed [${this.registry.contractName}@${this.registry.abiVersion}::${method}]: ${simResult.error}`,
      );
    }

    const successResult = simResult as rpc.Api.SimulateTransactionSuccessResponse;
    if (!successResult.result?.retval) {
      throw new Error(`No return value from ${method}`);
    }

    return successResult.result.retval;
  }
}
