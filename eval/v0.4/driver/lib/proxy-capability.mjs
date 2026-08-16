const AGENT_CAPABILITY = /^plan-lattice-[0-9a-f]{64}$/
const ORACLE_CAPABILITY = /^plan-lattice-oracle-[0-9a-f]{64}$/

function exactEndpoint(raw, hostname) {
  let endpoint
  try {
    endpoint = new URL(raw)
  } catch {
    throw new Error('credential-isolated model proxy endpoint is invalid')
  }
  if (endpoint.protocol !== 'http:'
    || endpoint.hostname !== hostname
    || endpoint.username !== ''
    || endpoint.password !== ''
    || endpoint.pathname !== '/'
    || endpoint.search !== ''
    || endpoint.hash !== ''
    || !/^\d+$/.test(endpoint.port)) {
    throw new Error(`credential-isolated model proxy must be an exact HTTP ${hostname} endpoint`)
  }
  return endpoint
}

/**
 * Prove that the driver received only one-time proxy capabilities, never an
 * upstream provider key. The secure host launcher owns the upstream secret.
 */
export function requireProxyCapabilities(source = process.env, options = {}) {
  if (source.PLAN_LATTICE_CREDENTIAL_PROXY !== '1') {
    throw new Error('paid execution requires the credential-isolated host proxy launcher')
  }
  if (!AGENT_CAPABILITY.test(source.DEEPSEEK_API_KEY ?? '')) {
    throw new Error('DEEPSEEK_API_KEY must contain a one-time agent proxy capability, not an upstream key')
  }
  const hostEndpoint = exactEndpoint(source.DEEPSEEK_BASE_URL, '127.0.0.1')
  const result = {
    agentCapability: source.DEEPSEEK_API_KEY,
    hostBaseURL: hostEndpoint.href.replace(/\/$/, ''),
  }
  if (options.oracle) {
    if (!ORACLE_CAPABILITY.test(source.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN ?? '')) {
      throw new Error('ICAE execution requires a one-time Oracle proxy capability')
    }
    result.oracleCapability = source.PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN
  }
  if (options.docker) {
    const dockerEndpoint = exactEndpoint(source.PLAN_LATTICE_DOCKER_MODEL_PROXY_URL, 'host.docker.internal')
    if (dockerEndpoint.port !== hostEndpoint.port) {
      throw new Error('host and Docker model proxy endpoints must bind the same port')
    }
    result.dockerBaseURL = dockerEndpoint.href.replace(/\/$/, '')
  }
  return result
}

export const proxyCapabilityPatterns = {
  agent: AGENT_CAPABILITY,
  oracle: ORACLE_CAPABILITY,
}
