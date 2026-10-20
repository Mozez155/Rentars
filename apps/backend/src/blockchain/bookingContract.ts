/**
 * Service layer for the Booking Soroban contract.
 *
 * Unlike the low-level BookingClient (which only builds XDR operations),
 * these functions prepare, sign, and submit full transactions using the
 * server admin keypair, and poll for on-chain confirmation.
 */

import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE, STELLAR_SOURCE_ACCOUNT } from './config.js';
import {
  getSorobanServer,
  simulateReadOnly,
  submitAndWait,
} from './soroban.js';
import { buildPrepareAndSign, extractReturnValue } from './transactionUtils.js';
import { ContractError } from './errors.js';
import type { BookingStatus, EscrowStatus } from './types.js';
import {
  assertBookingContractReady,
  getBookingContractId,
  getBookingContractMetadata,
  getNetworkPassphrase,
} from './contractRegistry.js';

/**
 * Resolve the booking contract ID from the centralized registry, rejecting
 * calls when the registry has not been validated or the network mismatches.
 */
function requireContractId(): string {
  assertBookingContractReady();
  const contractId = getBookingContractId();
  if (!contractId) {
    throw new ContractError(
      'BOOKING_CONTRACT_ID is not registered for the active network — ' +
        'configure it with a valid Soroban contract address before using booking operations',
    );
  }
  return contractId;
}

/**
 * Assert that the network the client is about to use matches the registry.
 * Prevents signing/submitting against the wrong Stellar network.
 */
function requireNetworkMatch(): void {
  const registryPassphrase = getNetworkPassphrase();
  if (registryPassphrase !== NETWORK_PASSPHRASE) {
    throw new ContractError(
      `Network mismatch: registry expects "${registryPassphrase}" but the ` +
        `client is configured for "${NETWORK_PASSPHRASE}". Refusing to sign or submit.`,
    );
  }
}

/**
 * Validate the configured contract ID and ABI version at startup.
 * Throws a ContractError if the registry is missing, unknown, or incompatible.
 */
export function validateBookingContractConfig(): void {
  assertBookingContractReady();
  const metadata = getBookingContractMetadata();
  if (!metadata) {
    throw new ContractError(
      'Booking contract metadata is not registered for the active network',
    );
  }
  if (!metadata.contractId) {
    throw new ContractError(
      'Booking contract ID is missing from the registry for the active network',
    );
  }
  if (!metadata.abiVersion) {
    throw new ContractError(
      'Booking contract ABI version is missing from the registry',
    );
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Check whether a property is available for the given date range.
 *
 * Dates are passed as Unix timestamps (seconds).
 *
 * @param propertyId - On-chain u64 property ID
 * @param startDate - Check-in as Unix timestamp (seconds)
 * @param endDate - Check-out as Unix timestamp (seconds)
 * @returns true if the property is available, false if already booked
 * @throws ContractError if BOOKING_CONTRACT_ID is not configured or the call fails
 */
export async function checkAvailability(
  propertyId: bigint,
  startDate: bigint,
  endDate: bigint,
): Promise<boolean> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'check_availability',
        nativeToScVal(propertyId, { type: 'u64' }),
        nativeToScVal(startDate, { type: 'u64' }),
        nativeToScVal(endDate, { type: 'u64' }),
      ),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'check_availability');
  return scValToNative(retval) as boolean;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Create an on-chain booking record and return the assigned on-chain booking ID.
 *
 * @param propertyId - On-chain u64 property ID.
 * @param userId - Stellar address of the tenant.
 * @param startDate - Check-in as Unix timestamp (seconds).
 * @param endDate - Check-out as Unix timestamp (seconds).
 * @param totalPrice - Total price in USDC stroops (i128).
 */
export async function createBookingOnChain(
  propertyId: bigint,
  userId: string,
  startDate: bigint,
  endDate: bigint,
  totalPrice: bigint,
): Promise<bigint> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const op = contract.call(
    'create_booking',
    nativeToScVal(userId, { type: 'address' }),
    nativeToScVal(propertyId, { type: 'u64' }),
    nativeToScVal(startDate, { type: 'u64' }),
    nativeToScVal(endDate, { type: 'u64' }),
    nativeToScVal(totalPrice, { type: 'i128' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  const response = await submitAndWait(server, tx);

  const returnedId = extractReturnValue(response);
  if (returnedId === undefined) {
    throw new ContractError(
      'create_booking returned no value',
      'create_booking',
    );
  }

  return BigInt(returnedId as number | string);
}

/**
 * Cancel an existing on-chain booking.
 *
 * @param bookingId - On-chain u64 booking ID.
 * @param callerAddress - Stellar address of the caller (tenant or admin).
 */
export async function cancelBookingOnChain(
  bookingId: bigint,
  callerAddress: string,
): Promise<void> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const op = contract.call(
    'cancel_booking',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Update the status of an on-chain booking.
 *
 * @param bookingId - On-chain u64 booking ID.
 * @param newStatus - Target BookingStatus.
 * @param callerAddress - Stellar address of the caller (admin).
 */
export async function updateBookingStatusOnChain(
  bookingId: bigint,
  newStatus: BookingStatus,
  callerAddress: string,
): Promise<void> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const op = contract.call(
    'update_status',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(newStatus)]),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

// ─── Escrow Operations ─────────────────────────────────────────────────────────

/**
 * Set the USDC token contract address for on-chain escrow.
 *
 * @param tokenAddress - Address of the USDC Soroban token contract.
 * @param callerAddress - Stellar address of the admin caller.
 */
export async function setTokenAddressOnChain(
  tokenAddress: string,
  callerAddress: string,
): Promise<void> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const op = contract.call(
    'set_token_address',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(tokenAddress, { type: 'address' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Fund the escrow for a booking by transferring USDC from the tenant to
 * the contract. The tenant must authorize this transaction.
 *
 * @param tenant - Stellar address of the tenant (must authorize).
 * @param bookingId - On-chain u64 booking ID.
 */
export async function fundEscrowOnChain(
  tenant: string,
  bookingId: bigint,
): Promise<void> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const op = contract.call(
    'fund_escrow',
    nativeToScVal(tenant, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Dispute a funded booking. Only the tenant may start a dispute.
 *
 * @param tenant - Stellar address of the tenant (must authorize).
 * @param bookingId - On-chain u64 booking ID.
 */
export async function disputeBookingOnChain(
  tenant: string,
  bookingId: bigint,
): Promise<void> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const op = contract.call(
    'dispute_booking',
    nativeToScVal(tenant, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Resolve a disputed booking. Admin decides whether to release escrowed
 * funds to the property owner (true) or refund the tenant (false).
 *
 * @param callerAddress - Stellar address of the admin caller.
 * @param bookingId - On-chain u64 booking ID.
 * @param releaseToOwner - true to release to owner, false to refund tenant.
 */
export async function resolveDisputeOnChain(
  callerAddress: string,
  bookingId: bigint,
  releaseToOwner: boolean,
): Promise<void> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const op = contract.call(
    'resolve_dispute',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
    nativeToScVal(releaseToOwner, { type: 'bool' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Get the configured USDC token contract address.
 *
 * @returns The token contract address.
 */
export async function getTokenAddressOnChain(): Promise<string> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('get_token_address'))
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_token_address');
  return scValToNative(retval) as string;
}

/**
 * Read the escrow status for a booking.
 *
 * @param bookingId - On-chain u64 booking ID.
 * @returns The booking (including escrow_status field).
 */
export async function getBookingWithEscrow(bookingId: bigint): Promise<{
  id: bigint;
  status: BookingStatus;
  escrow_status: EscrowStatus;
  property_owner: string;
  tenant: string;
  total_price: bigint;
}> {
  const contractId = requireContractId();
  requireNetworkMatch();

  const server = getSorobanServer();
  const contract = new Contract(contractId);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'get_booking',
        nativeToScVal(bookingId, { type: 'u64' }),
      ),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_booking');
  return scValToNative(retval) as {
    id: bigint;
    status: BookingStatus;
    escrow_status: EscrowStatus;
    property_owner: string;
    tenant: string;
    total_price: bigint;
  };
}
