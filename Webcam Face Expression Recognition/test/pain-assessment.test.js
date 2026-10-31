const test = require('node:test')
const assert = require('node:assert/strict')
const { calculateAssessment, validateContext } = require('../pain-assessment.js')

function sample({
  neutral = 0.1,
  happy = 0.1,
  sad = 0.7,
  angry = 0,
  fearful = 0,
  disgusted = 0,
  surprised = 0,
  headX = 0.5,
  headY = 0.5,
  yaw = 0,
  tilt = 0,
  jawRatio = 0.1
} = {}) {
  return {
    expressions: { neutral, happy, sad, angry, fearful, disgusted, surprised },
    detectionScore: 0.8,
    landmarks: { headX, headY, yaw, tilt, jawRatio }
  }
}

function assess(samples, extra = {}) {
  return calculateAssessment({
    childId: 'demo-child',
    samples,
    processedFrames: samples.length,
    ...extra
  })
}

test('happy expression lowers the visual index and cannot create a high score by itself', () => {
  const result = assess(Array.from({ length: 10 }, () => sample({
    neutral: 0.02,
    happy: 0.95,
    sad: 0.02,
    angry: 0.003,
    fearful: 0.003,
    disgusted: 0.002,
    surprised: 0.003
  })))

  assert.ok(result.painScore < 10)
  assert.equal(result.painLevel, 'calm')
  assert.equal(result.confidence, 80)
})

test('expression thresholds map to calm, mild, and moderate-severe bands', () => {
  const calm = assess(Array.from({ length: 10 }, () => sample({
    neutral: 0.51,
    happy: 0,
    sad: 0.49
  })))
  const mild = assess(Array.from({ length: 10 }, () => sample({
    neutral: 0.5,
    happy: 0,
    sad: 0.5
  })))
  const upperMild = assess(Array.from({ length: 10 }, () => sample({
    neutral: 0.25,
    happy: 0,
    sad: 0.75
  })))
  const severe = assess(Array.from({ length: 10 }, () => sample({
    neutral: 0.249,
    happy: 0,
    sad: 0.751
  })))

  assert.equal(calm.painLevel, 'calm')
  assert.equal(mild.painLevel, 'mild')
  assert.equal(upperMild.painScore, 75)
  assert.equal(upperMild.painLevel, 'mild')
  assert.equal(severe.painLevel, 'moderate-severe')
})

test('head and jaw landmark changes add a capped exploratory adjustment', () => {
  const still = Array.from({ length: 10 }, () => sample({ sad: 0.4 }))
  const moving = Array.from({ length: 10 }, (_, index) => sample({
    neutral: 0.1,
    happy: 0.1,
    sad: 0.4,
    headX: index % 2 ? 0.9 : 0.1,
    yaw: index % 2 ? 1 : -1,
    jawRatio: index % 2 ? 0.8 : 0
  }))

  const stillResult = assess(still)
  const movingResult = assess(moving)
  assert.equal(stillResult.painScore, 40)
  assert.equal(movingResult.painScore, 52)
  assert.match(movingResult.reasons.join(' '), /head\/jaw landmark changes added 12 exploratory points/i)
})

test('parent confirmations adjust the experimental score and capture quality', () => {
  const samples = Array.from({ length: 10 }, () => sample({ sad: 0.4 }))
  const baseline = assess(samples)
  const confirmedDistress = assess(samples, {
    caregiverAnswers: {
      distressObserved: true,
      calmPeriodsObserved: false,
      clearView: true
    }
  })
  const observedCalm = assess(samples, {
    caregiverAnswers: {
      distressObserved: false,
      calmPeriodsObserved: true,
      clearView: false
    }
  })

  assert.equal(confirmedDistress.painScore, baseline.painScore + 8)
  assert.equal(observedCalm.painScore, baseline.painScore - 8)
  assert.equal(observedCalm.confidence, baseline.confidence - 20)
  assert.match(confirmedDistress.reasons.join(' '), /yes \(\+8\)/)
  assert.throws(() => assess(samples, { caregiverAnswers: { distressObserved: 'yes' } }), /Answer each caregiver/)
})

test('optional context is retained but validates ranges and paired blood pressure', () => {
  assert.deepEqual(validateContext({
    temperatureC: 37.5,
    nutritionScore: 8,
    bloodPressureSystolic: 100,
    bloodPressureDiastolic: 65,
    bowelMovementCount: 2
  }), {
    temperatureC: 37.5,
    nutritionScore: 8,
    bloodPressureSystolic: 100,
    bloodPressureDiastolic: 65,
    bowelMovementCount: 2
  })
  assert.throws(() => validateContext({ bloodPressureSystolic: 100 }), /both blood pressure values/)
  assert.throws(() => validateContext({ nutritionScore: 11 }), /between 1 and 10/)
})

test('report creation rejects missing samples and malformed expression probabilities', () => {
  assert.throws(() => assess([]), /At least 10 usable face samples/)
  assert.throws(() => assess(Array.from({ length: 10 }, () => sample({ sad: 1.1 }))), /invalid sad probability/)
})
