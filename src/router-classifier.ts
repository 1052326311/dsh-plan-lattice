import { extractRouterFeatures } from './router-features.js'
import { ROUTER_MODEL } from './router-model.js'

export type RouterModelClass = typeof ROUTER_MODEL.classes[number]

export interface RouterModelPrediction {
  label: RouterModelClass
  confidence: number
  margin: number
  probabilities: Record<RouterModelClass, number>
}

function softmax(scores: readonly number[]): number[] {
  const maximum = Math.max(...scores)
  const exponentials = scores.map(score => Math.exp(score - maximum))
  const total = exponentials.reduce((sum, value) => sum + value, 0)
  return exponentials.map(value => value / total)
}

export function classifyRouteText(text: string): RouterModelPrediction {
  const features = extractRouterFeatures(text, ROUTER_MODEL.dimensions)
  const scores = ROUTER_MODEL.classes.map((_, classIndex) => {
    let score = ROUTER_MODEL.biases[classIndex]
    const weights = ROUTER_MODEL.weights[classIndex]
    for (let index = 0; index < features.indices.length; index += 1) {
      score += weights[features.indices[index]] * features.values[index]
    }
    return score
  })
  const values = softmax(scores)
  const ranked = values
    .map((probability, classIndex) => ({ classIndex, probability }))
    .sort((left, right) => right.probability - left.probability || left.classIndex - right.classIndex)
  const winner = ranked[0]
  const runnerUp = ranked[1]
  const label = ROUTER_MODEL.classes[winner.classIndex]
  return {
    label,
    confidence: winner.probability,
    margin: winner.probability - runnerUp.probability,
    probabilities: Object.fromEntries(ROUTER_MODEL.classes.map((name, classIndex) => [
      name, values[classIndex],
    ])) as Record<RouterModelClass, number>,
  }
}
