(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.PainAssessment = api
  }
})(globalThis, function () {
  const expressionNames = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised']
  const distressNames = ['sad', 'angry', 'fearful', 'disgusted']
  const contextRanges = {
    temperatureC: [20, 45],
    nutritionScore: [1, 10],
    bloodPressureSystolic: [30, 300],
    bloodPressureDiastolic: [20, 200],
    bowelMovementCount: [0, 1000]
  }
  const guidance = 'Experimental visual-only estimate. It is not validated for child pain and must not be used to diagnose, treat, or delay care. Consult a qualified clinician about health concerns.'

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  function validateContext(context) {
    if (context === undefined) return {}
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new TypeError('Optional health context must be an object.')
    }

    const result = {}
    for (const [name, value] of Object.entries(context)) {
      const range = contextRanges[name]
      if (!range) throw new TypeError(`Unknown context field: ${name}`)
      if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
        throw new RangeError(`${name} must be between ${range[0]} and ${range[1]}.`)
      }
      if (name !== 'temperatureC' && !Number.isInteger(value)) {
        throw new TypeError(`${name} must be a whole number.`)
      }
      result[name] = value
    }

    if ((result.bloodPressureSystolic === undefined) !== (result.bloodPressureDiastolic === undefined)) {
      throw new TypeError('Enter both blood pressure values or leave both blank.')
    }
    return result
  }

  function getExpressions(sample, index) {
    if (!sample || !sample.expressions || typeof sample.expressions !== 'object') {
      throw new TypeError(`Sample ${index + 1} is missing expression probabilities.`)
    }

    const values = {}
    for (const name of expressionNames) {
      const value = sample.expressions[name]
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(`Sample ${index + 1} has an invalid ${name} probability.`)
      }
      values[name] = value
    }
    return values
  }

  function getMovementPoints(samples) {
    const movements = []
    let previous

    for (const sample of samples) {
      const current = sample.landmarks
      if (!current || !['headX', 'headY', 'yaw', 'tilt', 'jawRatio'].every(
        name => Number.isFinite(current[name])
      )) {
        previous = undefined
        continue
      }

      if (previous) {
        const translation = Math.hypot(current.headX - previous.headX, current.headY - previous.headY)
        const poseChange = Math.abs(current.yaw - previous.yaw) + Math.abs(current.tilt - previous.tilt)
        const jawChange = Math.abs(current.jawRatio - previous.jawRatio)
        movements.push(translation * 120 + poseChange * 8 + jawChange * 35)
      }
      previous = current
    }

    if (movements.length === 0) return 0
    const mean = movements.reduce((total, value) => total + value, 0) / movements.length
    return Math.round(clamp(mean, 0, 12) * 10) / 10
  }

  function calculateAssessment({
    childId,
    samples,
    processedFrames,
    context,
    caregiverAnswers
  } = {}) {
    if (typeof childId !== 'string' || childId.trim().length === 0 || childId.trim().length > 100) {
      throw new TypeError('Enter a child ID of 1 to 100 characters.')
    }
    if (!Array.isArray(samples) || samples.length < 10) {
      throw new RangeError('At least 10 usable face samples are required to create a report.')
    }
    if (!Number.isInteger(processedFrames) || processedFrames < samples.length) {
      throw new RangeError('Processed-frame count is invalid.')
    }

    const optionalContext = validateContext(context)
    if (caregiverAnswers !== undefined && (
      !caregiverAnswers ||
      typeof caregiverAnswers !== 'object' ||
      typeof caregiverAnswers.distressObserved !== 'boolean' ||
      typeof caregiverAnswers.calmPeriodsObserved !== 'boolean' ||
      typeof caregiverAnswers.clearView !== 'boolean'
    )) {
      throw new TypeError('Answer each caregiver confirmation question with yes or no.')
    }

    const expressionTotals = Object.fromEntries(expressionNames.map(name => [name, 0]))
    let distressTotal = 0
    let detectionTotal = 0

    samples.forEach((sample, index) => {
      const expressions = getExpressions(sample, index)
      for (const name of expressionNames) expressionTotals[name] += expressions[name]

      const distress = Math.max(...distressNames.map(name => expressions[name]))
      let adjustedDistress = distress
      if (expressions.happy >= 0.5 && expressions.happy >= distress) {
        adjustedDistress *= 1 - expressions.happy
      } else if (expressions.neutral >= 0.5 && expressions.neutral > distress) {
        adjustedDistress *= 0.75
      }
      distressTotal += adjustedDistress
      detectionTotal += Number.isFinite(sample.detectionScore)
        ? clamp(sample.detectionScore, 0, 1)
        : 0
    })

    const averageExpressions = Object.fromEntries(
      expressionNames.map(name => [name, expressionTotals[name] / samples.length])
    )
    const prominentExpression = expressionNames.reduce((highest, name) =>
      averageExpressions[name] > averageExpressions[highest] ? name : highest
    , expressionNames[0])
    const averageDistress = distressTotal / samples.length
    const movementPoints = getMovementPoints(samples)
    const caregiverAdjustment = caregiverAnswers
      ? Number(caregiverAnswers.distressObserved) * 8 -
        Number(caregiverAnswers.calmPeriodsObserved) * 8
      : 0
    const painScore = Math.round(clamp(
      averageDistress * 100 + movementPoints + caregiverAdjustment,
      0,
      100
    ) * 10) / 10
    const painLevel = painScore < 50 ? 'calm' : painScore <= 75 ? 'mild' : 'moderate-severe'
    const averageDetectionScore = detectionTotal / samples.length
    const detectionConfidence = Math.round(
      clamp(samples.length / processedFrames, 0, 1) * averageDetectionScore * 100
    )
    const confidence = Math.max(
      0,
      detectionConfidence - (caregiverAnswers && !caregiverAnswers.clearView ? 20 : 0)
    )

    const reasons = [
      `The most prominent average expression was ${prominentExpression} (${Math.round(averageExpressions[prominentExpression] * 100)}%).`,
      `The strongest distress-expression probability averaged ${Math.round(averageDistress * 100)}% before landmark adjustment.`,
      `Head/jaw landmark changes added ${movementPoints} exploratory points; ordinary movement and camera variation can affect this proxy.`,
      `Capture quality was ${confidence}%; this is face-detection coverage, not confidence that the pain estimate is correct.`
    ]

    if (caregiverAnswers) {
      reasons.push(
        `Parent confirmation: distress visible for much of the recording was ${caregiverAnswers.distressObserved ? 'yes (+8)' : 'no (+0)'}.`
      )
      reasons.push(
        `Parent confirmation: calm or happy periods were observed was ${caregiverAnswers.calmPeriodsObserved ? 'yes (-8)' : 'no (-0)'}.`
      )
      reasons.push(
        `Parent confirmation: face was clear for most of the recording was ${caregiverAnswers.clearView ? 'yes' : 'no'}; this changes capture quality only.`
      )
    }

    if (averageExpressions.happy >= Math.max(...distressNames.map(name => averageExpressions[name]))) {
      reasons.push('A happy expression was at least as prominent as the distress expressions and reduced the visual index.')
    }

    return {
      childId: childId.trim(),
      painLevel,
      painScore,
      confidence,
      reasons,
      guidance,
      context: optionalContext
    }
  }

  return { calculateAssessment, validateContext }
})
