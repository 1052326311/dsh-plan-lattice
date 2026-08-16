export function scoreRouterRows(rows, gates) {
  const routes = ['bypass', 'contract', 'lattice', 'probe']
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('V12 scoring requires non-empty rows')
  for (const [index, row] of rows.entries()) {
    if (!routes.includes(row.expected) || !routes.includes(row.actual)) {
      throw new Error(`V12 row ${index + 1} has an invalid route`)
    }
    if (typeof row.outcomeCritical !== 'boolean') {
      throw new Error(`V12 row ${index + 1} outcomeCritical must be boolean`)
    }
  }
  const simple = rows.filter(row => row.expected === 'bypass')
  const complex = rows.filter(row => row.expected !== 'bypass')
  const critical = rows.filter(row => row.outcomeCritical)
  const lattice = rows.filter(row => row.expected === 'lattice')
  const probe = rows.filter(row => row.expected === 'probe')
  const nonProbe = rows.filter(row => row.expected !== 'probe')
  for (const [name, values] of Object.entries({ simple, complex, critical, lattice, probe, nonProbe })) {
    if (values.length === 0) throw new Error(`V12 scoring requires at least one ${name} row`)
  }
  const exactAccuracy = rows.filter(row => row.actual === row.expected).length / rows.length
  const simpleFalseActivationRate = simple.filter(row => row.actual !== 'bypass').length / simple.length
  const complexCriticalRecall = complex.filter(row => row.actual !== 'bypass').length / complex.length
  const outcomeCriticalBypass = critical.filter(row => row.actual === 'bypass').length
  const latticeRecall = lattice.filter(row => row.actual === 'lattice').length / lattice.length
  const probeRecall = probe.filter(row => row.actual === 'probe').length / probe.length
  const probeFalsePositiveRate = nonProbe.filter(row => row.actual === 'probe').length / nonProbe.length
  const f1 = routes.map(route => {
    const tp = rows.filter(row => row.expected === route && row.actual === route).length
    const fp = rows.filter(row => row.expected !== route && row.actual === route).length
    const fn = rows.filter(row => row.expected === route && row.actual !== route).length
    return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn)
  })
  const macroF1 = f1.reduce((sum, value) => sum + value, 0) / f1.length
  const metrics = {
    exactAccuracy,
    macroF1,
    simpleFalseActivationRate,
    complexCriticalRecall,
    outcomeCriticalBypass,
    latticeRecall,
    probeRecall,
    probeFalsePositiveRate,
  }
  const checks = {
    simpleFalseActivationRate: simpleFalseActivationRate <= gates.simpleFalseActivationRateMax,
    complexCriticalRecall: complexCriticalRecall >= gates.complexCriticalRecallMin,
    outcomeCriticalBypass: outcomeCriticalBypass <= gates.outcomeCriticalBypassMax,
    exactAccuracy: exactAccuracy >= gates.exactAccuracyMin,
    macroF1: macroF1 >= gates.macroF1Min,
    latticeRecall: latticeRecall >= gates.latticeRecallMin,
    probeRecall: probeRecall >= gates.probeRecallMin,
    probeFalsePositiveRate: probeFalsePositiveRate <= gates.probeFalsePositiveRateMax,
  }
  return {
    metrics,
    checks,
    releaseGatePassed: Object.values(checks).every(Boolean),
    confusion: Object.fromEntries(routes.flatMap(expected => routes.map(actual => [
      `${expected}->${actual}`,
      rows.filter(row => row.expected === expected && row.actual === actual).length,
    ]))),
    failures: rows.filter(row => row.actual !== row.expected),
  }
}
