import { type Request, type Response, Router } from 'express';
import { getContractRegistryHealth } from '../services/contract-registry.service';
import { getNetworkConfig } from '../config/network.config';

const router = Router();

/**
 * GET /api/v1/readiness
 *
 * Lightweight readiness probe used by post-deploy smoke tests to confirm the
 * API process is serving requests and the version matches expectations.
 *
 * Unlike /health, this endpoint does NOT probe downstream dependencies — it is
 * intentionally fast so smoke tests can poll it immediately after a cold deploy
 * without waiting for database warmup.
 *
 * The response also surfaces the active Stellar network and contract registry
 * validation status so smoke tests can detect incompatible or testnet
 * configuration in production.
 *
 * @openapi
 * /api/v1/readiness:
 *   get:
 *     tags: [Health]
 *     summary: API process readiness probe
 *     responses:
 *       200:
 *         description: Process is ready to serve requests
 *       503:
 *         description: Contract registry configuration is invalid or incompatible
 */
router.get('/readiness', (_req: Request, res: Response) => {
  const network = getNetworkConfig();
  const registryHealth = getContractRegistryHealth();

  const base = {
    status: registryHealth.valid ? 'ready' : 'not_ready',
    service: 'rentars-api',
    network: {
      name: network.network,
      passphrase: network.networkPassphrase,
      rpcUrl: network.rpcUrl,
      isProduction: network.isProduction,
    },
    contracts: {
      valid: registryHealth.valid,
      abiVersion: registryHealth.abiVersion,
      wasmHash: registryHealth.wasmHash,
      contractId: registryHealth.contractId,
      errors: registryHealth.errors,
    },
    timestamp: new Date().toISOString(),
  };

  if (!registryHealth.valid) {
    res.status(503).json(base);
    return;
  }

  res.status(200).json(base);
});

export default router;