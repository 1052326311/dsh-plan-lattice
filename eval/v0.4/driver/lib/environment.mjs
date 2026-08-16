const DRIVER_CAPABILITY_KEYS = new Set([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'PLAN_LATTICE_DOCKER_MODEL_PROXY_URL',
  'PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN',
  'PLAN_LATTICE_MODEL_PROXY_CONTROL_TOKEN',
  'PLAN_LATTICE_MODEL_PROXY_AUDIT',
  'PLAN_LATTICE_CREDENTIAL_PROXY_ROOT',
  'PLAN_LATTICE_CREDENTIAL_PROXY_PID',
  'PLAN_LATTICE_CREDENTIAL_PROXY',
  'PLAN_LATTICE_UPSTREAM_ENDPOINT_DIGEST',
  'PLAN_LATTICE_RESULT_SIGNING_PRIVATE_KEY_BASE64',
  'PLAN_LATTICE_RESULT_SIGNING_PUBLIC_KEY_BASE64',
  'PLAN_LATTICE_RESULT_SIGNING_LEDGER',
])

/** Remove every evaluation credential or capability before invoking build tools. */
export function withoutEvaluationCapabilities(source = process.env) {
  const result = { ...source }
  for (const key of DRIVER_CAPABILITY_KEYS) delete result[key]
  return result
}

/** Minimal inherited process settings needed by an isolated Harness execution. */
export function inheritedRuntimeEnvironment(source = process.env) {
  return Object.fromEntries([
    'PATH', 'LANG', 'LC_ALL', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ].flatMap(key => source[key] === undefined ? [] : [[key, source[key]]]))
}
