/**
 * Backend client for the Booking Soroban contract.
 *
 * ABI reference: apps/contracts/booking_abi.json
 *
 * This module wraps the @stellar/stellar-sdk contract invocation API and
 * provides typed methods that mirror every function in the ABI. All i128/u64
 * values are represented as bigint in TypeScript.
 */

import {
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type {
  Booking,
  BookingStatus,
  CreateBookingParams,
  DisputeBookingParams,
  EscrowStatus,
  FundEscrowParams,
  ResolveDisputeParams,
} from './types.js';
import {
  assertNetworkMatch,
  getNetworkConfig,
  type StellarNetwork,
} from './network.js';
import {
  pollTransaction,
  type PollOutcome,
  type TransactionRecord,
} from './transactionTracker.js';

// ─── ABI metadata (sourced from booking_abi.json) ────────────────────────────
const ABI_VERSION = '0.1.0';
const CONTRACT_NAME = 'booking';

// ─── Client ──────────────────────────────────────────────────────────────────

export class BookingClient {
  private readonly contract: Contract;
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly network: StellarNetwork;

  constructor(
    contractId: string,
    rpcUrl: string,
    networkPassphrase: string = Networks.TESTNET,
  ) {
    // Resolve the canonical network config and reject any mismatch between the
    // supplied passphrase, the configured network, and the RPC/contract IDs.
    const config = getNetworkConfig();
    assertNetworkMatch(config.network, networkPassphrase, 'BookingClient');

    this.network = config.network;
    this.contract = new Contract(contractId);
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.networkPassphrase = networkPassphrase;
  }

  /** The Stellar network this client is bound to. */
  getNetwork(): StellarNetwork {
    return this.network;
  }

  /** The network passphrase this client signs and simulates with. */
  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /**
   * Validate that a wallet-reported network matches this client's network.
   * Throws an actionable error on mismatch so callers can block signing.
   */
  assertWalletNetwork(walletNetwork: StellarNetwork | string): void {
    assertNetworkMatch(this.network, walletNetwork, 'BookingClient wallet');
  }

  /**
   * Submit a signed transaction envelope, persist its hash + network, and
   * track confirmation with bounded polling.
   *
   * On polling timeout the outcome is reported as `unresolved` (never a final
   * failure) so the caller can hand it to reconciliation.
   */
  async submitAndTrack(
    signedXdr: string,
    record: TransactionRecord,
  ): Promise<PollOutcome> {
    assertNetworkMatch(this.network, record.network, 'BookingClient submit');

    const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const sendResponse = await this.server.sendTransaction(tx);

    if (sendResponse.status === 'ERROR') {
      return {
        status: 'failed',
        hash: record.hash,
        network: this.network,
        error: `Submission rejected: ${JSON.stringify(sendResponse.errorResult ?? sendResponse)}`,
      };
    }

    return pollTransaction(this.server, {
      ...record,
      hash: sendResponse.hash,
      network: this.network,
    });
  }

  /**
   * Reconcile a previously submitted transaction by hash. Used when polling
   * timed out or the process restarted before confirmation.
   */
  async reconcile(hash: string, network: StellarNetwork | string): Promise<PollOutcome> {
    assertNetworkMatch(this.network, network, 'BookingClient reconcile');
    return pollTransaction(this.server, {
      hash,
      network: this.network,
      submittedAt: Date.now(),
    });
  }

  // ── Read-only queries ─────────────────────────────────────────────────────

  /**
   * Retrieve a booking by ID.
   *
   * ABI: get_booking(id: u64) -> Booking
   */
  async getBooking(id: bigint): Promise<Booking> {
    const result = await this.simulateReadOnly('get_booking', [
      nativeToScVal(id, { type: 'u64' }),
    ]);
    return scValToNative(result) as Booking;
  }

  /**
   * Return all booking IDs for a given property.
   *
   * ABI: get_property_bookings(property_id: u64) -> Vec<u64>
   */
  async getPropertyBookings(propertyId: bigint): Promise<bigint[]> {
    const result = await this.simulateReadOnly('get_property_bookings', [
      nativeToScVal(propertyId, { type: 'u64' }),
    ]);
    const native = scValToNative(result) as (number | string)[];
    return native.map((v) => BigInt(v));
  }

  /**
   * Check whether a date range is available for a property.
   *
   * ABI: check_availability(property_id, check_in, check_out) -> bool
   */
  async checkAvailability(
    propertyId: bigint,
    checkIn: bigint,
    checkOut: bigint,
  ): Promise<boolean> {
    const result = await this.simulateReadOnly('check_availability', [
      nativeToScVal(propertyId, { type: 'u64' }),
      nativeToScVal(checkIn, { type: 'u64' }),
      nativeToScVal(checkOut, { type: 'u64' }),
    ]);
    return scValToNative(result) as boolean;
  }

  /**
   * Return the total number of bookings ever created.
   *
   * ABI: booking_count() -> u64
   */
  async bookingCount(): Promise<bigint> {
    const result = await this.simulateReadOnly('booking_count', []);
    return BigInt(scValToNative(result) as number | string);
  }

  // ── State-changing operations ─────────────────────────────────────────────

  /**
   * Build the XDR operation for initialize.
   *
   * ABI: initialize(admin: Address)
   *
   * Must be called exactly once after deployment. The caller is responsible
   * for wrapping in a transaction, signing with the admin keypair, and
   * submitting via the Stellar network.
   */
  buildInitialize(admin: string): xdr.Operation {
    return this.contract.call(
      'initialize',
      nativeToScVal(admin, { type: 'address' }),
    );
  }

  /**
   * Build the XDR operation for create_booking.
   *
   * ABI: create_booking(tenant, property_id, check_in, check_out, total_price) -> u64
   */
  buildCreateBooking(params: CreateBookingParams): xdr.Operation {
    return this.contract.call(
      'create_booking',
      nativeToScVal(params.tenant, { type: 'address' }),
      nativeToScVal(params.property_id, { type: 'u64' }),
      nativeToScVal(params.check_in, { type: 'u64' }),
      nativeToScVal(params.check_out, { type: 'u64' }),
      nativeToScVal(params.total_price, { type: 'i128' }),
    );
  }

  /**
   * Build the XDR operation for cancel_booking.
   *
   * ABI: cancel_booking(caller: Address, booking_id: u64)
   */
  buildCancelBooking(caller: string, bookingId: bigint): xdr.Operation {
    return this.contract.call(
      'cancel_booking',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(bookingId, { type: 'u64' }),
    );
  }

  /**
   * Build the XDR operation for update_status.
   *
   * ABI: update_status(caller, booking_id, new_status)
   * Only the admin may call this.
   */
  buildUpdateStatus(
    caller: string,
    bookingId: bigint,
    newStatus: BookingStatus,
  ): xdr.Operation {
    return this.contract.call(
      'update_status',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(bookingId, { type: 'u64' }),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(newStatus)]),
    );
  }

  /**
   * Build the XDR operation for set_escrow_id.
   *
   * ABI: set_escrow_id(caller, booking_id, escrow_id)
   * Only the admin may call this.
   */
  buildSetEscrowId(
    caller: string,
    bookingId: bigint,
    escrowId: string,
  ): xdr.Operation {
    return this.contract.call(
      'set_escrow_id',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(bookingId, { type: 'u64' }),
      nativeToScVal(escrowId, { type: 'string' }),
    );
  }

  /**
   * Build the XDR operation for set_token_address.
   *
   * ABI: set_token_address(caller, token_address)
   * Only the admin may call this.
   */
  buildSetTokenAddress(
    caller: string,
    tokenAddress: string,
  ): xdr.Operation {
    return this.contract.call(
      'set_token_address',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(tokenAddress, { type: 'address' }),
    );
  }

  /**
   * Build the XDR operation for fund_escrow.
   *
   * ABI: fund_escrow(tenant, booking_id)
   * The tenant must authorize and have sufficient USDC balance.
   */
  buildFundEscrow(params: FundEscrowParams): xdr.Operation {
    return this.contract.call(
      'fund_escrow',
      nativeToScVal(params.tenant, { type: 'address' }),
      nativeToScVal(params.booking_id, { type: 'u64' }),
    );
  }

  /**
   * Build the XDR operation for dispute_booking.
   *
   * ABI: dispute_booking(tenant, booking_id)
   * Only the tenant may dispute a funded booking.
   */
  buildDisputeBooking(params: DisputeBookingParams): xdr.Operation {
    return this.contract.call(
      'dispute_booking',
      nativeToScVal(params.tenant, { type: 'address' }),
      nativeToScVal(params.booking_id, { type: 'u64' }),
    );
  }

  /**
   * Build the XDR operation for resolve_dispute.
   *
   * ABI: resolve_dispute(caller, booking_id, release_to_owner)
   * Only the admin may resolve disputes.
   */
  buildResolveDispute(params: ResolveDisputeParams): xdr.Operation {
    return this.contract.call(
      'resolve_dispute',
      nativeToScVal(params.caller, { type: 'address' }),
      nativeToScVal(params.booking_id, { type: 'u64' }),
      nativeToScVal(params.release_to_owner, { type: 'bool' }),
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
    // Re-assert the network before every quote/simulation so a misconfigured
    // environment cannot silently query the wrong chain.
    assertNetworkMatch(this.network, getNetworkConfig().network, 'BookingClient quote');

    const sourceAccount = await this.server.getAccount(
      process.env.STELLAR_SOURCE_ACCOUNT ||
        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(
        `Contract simulation failed [${CONTRACT_NAME}@${ABI_VERSION}::${method}]: ${simResult.error}`,
      );
    }

    const successResult = simResult as rpc.Api.SimulateTransactionSuccessResponse;
    if (!successResult.result?.retval) {
      throw new Error(`No return value from ${method}`);
    }

    return successResult.result.retval;
  }
}
