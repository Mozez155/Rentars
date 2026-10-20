# ─────────────────────────────────────────────────────────────────────────────
# Rentars — Staging Terraform variable values
#
# Non-secret configuration only.  Secret ARNs are injected via
# TF_VAR_secret_arn_* environment variables in CI (never stored here).
#
# Apply:
#   terraform -chdir=infra/terraform apply \
#     -var-file=staging.tfvars \
#     -var="backend_image=<registry>/rentars-backend:staging" \
#     -var="frontend_image=<registry>/rentars-web:staging"
# ─────────────────────────────────────────────────────────────────────────────

environment = "staging"
aws_region  = "us-east-1"

# ── Networking ────────────────────────────────────────────────────────────────
vpc_cidr             = "10.10.0.0/16"
availability_zones   = ["us-east-1a", "us-east-1b"]
public_subnet_cidrs  = ["10.10.1.0/24", "10.10.2.0/24"]
private_subnet_cidrs = ["10.10.11.0/24", "10.10.12.0/24"]

# ── DNS / TLS ─────────────────────────────────────────────────────────────────
domain_name         = "staging.rentars.app"
acm_certificate_arn = "arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/STAGING_CERT_ID"

# ── Redis ─────────────────────────────────────────────────────────────────────
redis_node_type      = "cache.t4g.micro"
redis_engine_version = "7.1"

# ── Compute ───────────────────────────────────────────────────────────────────
# Images are overridden at apply time with the specific build tag.
backend_image          = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/rentars-backend:staging"
backend_cpu            = 512
backend_memory         = 1024
backend_desired_count  = 1   # single replica in staging to save cost

frontend_image         = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/rentars-web:staging"
frontend_cpu           = 256
frontend_memory        = 512
frontend_desired_count = 1

# ── Stellar network / contract version registry ───────────────────────────────
# Explicit network selection: staging must never silently fall back to testnet
# or mainnet.  The backend validates these values at startup and rejects any
# wallet/RPC/contract combination that does not match.
stellar_network         = "testnet"
stellar_network_passphrase = "Test SDF Network ; September 2015"
stellar_rpc_url         = "https://soroban-testnet.stellar.org"
stellar_horizon_url     = "https://horizon-testnet.stellar.org"

# Contract version registry (see docs/contract-versioning.md).
# A staging upgrade must be proven here before the same hashes/ABI are
# promoted to production.
contract_id             = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASTG"
contract_wasm_hash      = "0000000000000000000000000000000000000000000000000000000000000000"
contract_abi_version    = "1.0.0"
contract_init_dependencies = ["token:CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATKN"]
app_release             = "staging"

# ── WAF ───────────────────────────────────────────────────────────────────────
waf_rate_limit_per_5m = 500

# ── Monitoring ────────────────────────────────────────────────────────────────
alert_email = "engineering@rentars.app"
