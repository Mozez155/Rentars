# ─────────────────────────────────────────────────────────────────────────────
# Rentars — Production Terraform variable values
#
# Non-secret configuration only.  Secret ARNs are injected via
# TF_VAR_secret_arn_* environment variables in CI (never stored here).
# ─────────────────────────────────────────────────────────────────────────────

environment = "production"
aws_region  = "us-east-1"

# ── Networking ────────────────────────────────────────────────────────────────
vpc_cidr             = "10.20.0.0/16"
availability_zones   = ["us-east-1a", "us-east-1b", "us-east-1c"]
public_subnet_cidrs  = ["10.20.1.0/24", "10.20.2.0/24", "10.20.3.0/24"]
private_subnet_cidrs = ["10.20.11.0/24", "10.20.12.0/24", "10.20.13.0/24"]

# ── DNS / TLS ─────────────────────────────────────────────────────────────────
domain_name         = "rentars.app"
acm_certificate_arn = "arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/PROD_CERT_ID"

# ── Redis ─────────────────────────────────────────────────────────────────────
redis_node_type      = "cache.t4g.small"
redis_engine_version = "7.1"

# ── Compute ───────────────────────────────────────────────────────────────────
backend_image          = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/rentars-backend:latest"
backend_cpu            = 1024
backend_memory         = 2048
backend_desired_count  = 3

frontend_image         = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/rentars-web:latest"
frontend_cpu           = 512
frontend_memory        = 1024
frontend_desired_count = 2

# ── Stellar network configuration ─────────────────────────────────────────────
# Production must be pinned to the public network.  There is deliberately no
# default: a missing value fails the plan instead of silently using testnet.
stellar_network             = "public"
stellar_network_passphrase  = "Public Global Stellar Network ; September 2015"
stellar_horizon_url         = "https://horizon.stellar.org"
stellar_rpc_url             = "https://soroban-rpc.stellar.org"
stellar_network_mismatch_policy = "reject"

# ── Contract version registry ─────────────────────────────────────────────────
# Each entry pins the deployed contract ID, WASM hash and ABI version for the
# public network.  Startup validation rejects unknown or mismatched values.
contract_registry = {
  rentars_escrow = {
    network          = "public"
    contract_id      = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPROD"
    wasm_hash        = "0000000000000000000000000000000000000000000000000000000000000000"
    abi_version      = "1.0.0"
    init_dependencies = []
    compatible_app_releases = ["1.0.0"]
  }
  rentars_payments = {
    network          = "public"
    contract_id      = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBPROD"
    wasm_hash        = "0000000000000000000000000000000000000000000000000000000000000000"
    abi_version      = "1.0.0"
    init_dependencies = ["rentars_escrow"]
    compatible_app_releases = ["1.0.0"]
  }
}

# ── WAF ───────────────────────────────────────────────────────────────────────
waf_rate_limit_per_5m = 2000

# ── Monitoring ────────────────────────────────────────────────────────────────
alert_email = "oncall@rentars.app"
