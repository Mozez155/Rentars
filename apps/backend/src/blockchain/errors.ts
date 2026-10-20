export class BlockchainError extends Error {
  readonly code: string;

  constructor(message: string, code = 'BLOCKCHAIN_ERROR') {
    super(message);
    this.name = 'BlockchainError';
    this.code = code;
  }
}

export class ContractError extends BlockchainError {
  constructor(
    message: string,
    public readonly contractMethod?: string,
  ) {
    super(message, 'CONTRACT_ERROR');
    this.name = 'ContractError';
  }
}

export class TransactionError extends BlockchainError {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message, 'TRANSACTION_ERROR');
    this.name = 'TransactionError';
  }
}

export class AvailabilityError extends BlockchainError {
  constructor(message: string) {
    super(message, 'AVAILABILITY_ERROR');
    this.name = 'AvailabilityError';
  }
}

export class EscrowError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'EscrowError';
  }
}

export interface SimulationDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly contractMethod?: string;
  readonly recoverable: boolean;
}

export interface FeeEstimation {
  readonly baseFee: string;
  readonly resourceFee: string;
  readonly totalFee: string;
  readonly minResourceFee?: string;
  readonly maxResourceFee?: string;
  readonly currency: string;
}

export interface SimulationResult {
  readonly success: boolean;
  readonly fee: FeeEstimation;
  readonly diagnostics: readonly SimulationDiagnostic[];
  readonly ledger: number;
  readonly expiresAt: number;
}

export class SimulationError extends BlockchainError {
  constructor(
    message: string,
    public readonly diagnostics: readonly SimulationDiagnostic[] = [],
  ) {
    super(message, 'SIMULATION_ERROR');
    this.name = 'SimulationError';
  }
}

export class QuoteInvalidatedError extends BlockchainError {
  constructor(message = 'Quote changed; previous simulation is no longer valid') {
    super(message, 'QUOTE_INVALIDATED');
    this.name = 'QuoteInvalidatedError';
  }
}

export interface NetworkMismatchDetails {
  readonly expectedNetwork: string;
  readonly actualNetwork: string;
  readonly source: 'wallet' | 'backend' | 'contract' | 'rpc' | 'intent';
  readonly remediation: string;
}

export class NetworkMismatchError extends BlockchainError {
  readonly expectedNetwork: string;
  readonly actualNetwork: string;
  readonly source: NetworkMismatchDetails['source'];
  readonly remediation: string;

  constructor(details: NetworkMismatchDetails) {
    const message =
      `Network mismatch detected (${details.source}): expected "${details.expectedNetwork}" ` +
      `but received "${details.actualNetwork}". ${details.remediation}`;
    super(message, 'NETWORK_MISMATCH');
    this.name = 'NetworkMismatchError';
    this.expectedNetwork = details.expectedNetwork;
    this.actualNetwork = details.actualNetwork;
    this.source = details.source;
    this.remediation = details.remediation;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      expectedNetwork: this.expectedNetwork,
      actualNetwork: this.actualNetwork,
      source: this.source,
      remediation: this.remediation,
    };
  }
}

export interface ContractConfigErrorDetails {
  readonly contractId?: string;
  readonly network?: string;
  readonly reason: string;
  readonly remediation: string;
}

export class ContractConfigError extends BlockchainError {
  readonly contractId?: string;
  readonly network?: string;
  readonly reason: string;
  readonly remediation: string;

  constructor(details: ContractConfigErrorDetails) {
    const context = [
      details.contractId ? `contract "${details.contractId}"` : 'contract configuration',
      details.network ? `on network "${details.network}"` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    super(
      `Invalid ${context}: ${details.reason}. ${details.remediation}`,
      'CONTRACT_CONFIG_ERROR',
    );
    this.name = 'ContractConfigError';
    this.contractId = details.contractId;
    this.network = details.network;
    this.reason = details.reason;
    this.remediation = details.remediation;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      contractId: this.contractId,
      network: this.network,
      reason: this.reason,
      remediation: this.remediation,
    };
  }
}
