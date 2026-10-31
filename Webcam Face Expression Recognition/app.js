const form = document.getElementById('assessmentForm')
const video = document.getElementById('video')
const canvas = document.getElementById('overlay')
const status = document.getElementById('status')
const startButton = document.getElementById('startButton')
const cancelButton = document.getElementById('cancelButton')
const retrySaveButton = document.getElementById('retrySaveButton')
const timeRemaining = document.getElementById('timeRemaining')
const report = document.getElementById('report')
const saveStatus = document.getElementById('saveStatus')
const reportSummary = document.getElementById('reportSummary')
const reportQuality = document.getElementById('reportQuality')
const reasons = document.getElementById('reasons')
const reportJson = document.getElementById('reportJson')
const systolicInput = document.getElementById('systolic')
const diastolicInput = document.getElementById('diastolic')

const assessmentDurationMs = 60_000
const sampleIntervalMs = 200
let modelsReady = false
let starting = false
let running = false
let cancelRequested = false
let pendingPayload

function stopCamera() {
  const stream = video.srcObject
  if (stream) stream.getTracks().forEach(track => track.stop())
  video.srcObject = null
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
}

function optionalNumber(id) {
  const input = document.getElementById(id)
  return input.value.trim() === '' ? undefined : input.valueAsNumber
}

function readContext() {
  systolicInput.setCustomValidity('')
  diastolicInput.setCustomValidity('')
  if (systolicInput.value.trim() !== '' && diastolicInput.value.trim() === '') {
    diastolicInput.setCustomValidity('Enter both blood pressure values or leave both blank.')
  } else if (systolicInput.value.trim() === '' && diastolicInput.value.trim() !== '') {
    systolicInput.setCustomValidity('Enter both blood pressure values or leave both blank.')
  }

  if (!form.reportValidity()) return undefined

  const context = {}
  const values = {
    temperatureC: optionalNumber('temperature'),
    nutritionScore: optionalNumber('nutrition'),
    bloodPressureSystolic: optionalNumber('systolic'),
    bloodPressureDiastolic: optionalNumber('diastolic'),
    bowelMovementCount: optionalNumber('bowelMovements')
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) context[key] = value
  }
  return context
}

function getLandmarkFeatures(positions) {
  if (!Array.isArray(positions) || positions.length < 68) {
    throw new Error('The landmark model returned fewer than 68 points.')
  }

  const leftEye = positions[36]
  const rightEye = positions[45]
  const nose = positions[30]
  const upperLip = positions[62]
  const lowerLip = positions[66]
  const eyeDistance = Math.max(Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y), 1)

  return {
    headX: nose.x / video.videoWidth,
    headY: nose.y / video.videoHeight,
    yaw: (nose.x - (leftEye.x + rightEye.x) / 2) / eyeDistance,
    tilt: Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x),
    jawRatio: Math.hypot(lowerLip.x - upperLip.x, lowerLip.y - upperLip.y) / eyeDistance
  }
}

function renderReport(record, saved) {
  report.hidden = false
  saveStatus.textContent = saved
    ? 'Saved by the local demo server. Records remain in server memory only and are cleared when it restarts.'
    : 'Not saved. This is a draft; the server will assign createdAt when saving succeeds.'
  reportSummary.textContent = `Experimental visual index: ${record.painScore}/100 — ${record.painLevel}`
  reportQuality.textContent = `Capture quality (face-detection coverage, not pain confidence): ${record.confidence}%`
  reasons.replaceChildren(...record.reasons.map(reason => {
    const item = document.createElement('li')
    item.textContent = reason
    return item
  }))
  reportJson.textContent = JSON.stringify(record, null, 2)
  retrySaveButton.hidden = saved || !pendingPayload
}

async function savePayload(payload) {
  const response = await fetch('/api/assessments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Report save failed (${response.status}).`)

  pendingPayload = undefined
  window.latestPainAssessment = result
  renderReport(result, true)
}

function updateOverlay(result) {
  const dimensions = faceapi.matchDimensions(canvas, video, true)
  const resized = faceapi.resizeResults(result, dimensions)
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
  faceapi.draw.drawDetections(canvas, resized)
  faceapi.draw.drawFaceLandmarks(canvas, resized)
  faceapi.draw.drawFaceExpressions(canvas, resized, 0.05)
}

async function startAssessment(event) {
  event.preventDefault()
  if (!modelsReady || starting) return

  const context = readContext()
  if (!context) return

  starting = true
  running = true
  cancelRequested = false
  startButton.disabled = true
  cancelButton.hidden = false
  report.hidden = true
  status.textContent = 'Requesting camera access. The one-minute assessment starts when the camera is ready.'

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support camera access.')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 320 },
        height: { ideal: 240 }
      }
    })

    if (cancelRequested) {
      stream.getTracks().forEach(track => track.stop())
      return
    }

    video.srcObject = stream
    await video.play()
    const samples = []
    let processedFrames = 0
    const startedAt = Date.now()
    status.textContent = 'Assessment in progress. This experimental result is not a medical assessment.'

    while (running && Date.now() - startedAt < assessmentDurationMs) {
      const loopStartedAt = performance.now()
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        processedFrames += 1
        const result = await faceapi
          .detectSingleFace(
            video,
            new faceapi.TinyFaceDetectorOptions({
              inputSize: Number(document.getElementById('inputSize').value),
              scoreThreshold: 0.5
            })
          )
          .withFaceLandmarks()
          .withFaceExpressions()

        if (result) {
          samples.push({
            expressions: result.expressions,
            detectionScore: result.detection.score,
            landmarks: getLandmarkFeatures(result.landmarks.positions)
          })
          updateOverlay(result)
        } else {
          const drawingContext = canvas.getContext('2d')
          drawingContext.clearRect(0, 0, canvas.width, canvas.height)
        }
      }

      const elapsedMs = Date.now() - startedAt
      const secondsLeft = Math.max(0, Math.ceil((assessmentDurationMs - elapsedMs) / 1000))
      timeRemaining.textContent = `00:${String(secondsLeft).padStart(2, '0')}`
      status.textContent = samples.length
        ? `Assessment in progress: ${samples.length} face samples captured.`
        : 'Assessment in progress: looking for a face in the camera.'
      await new Promise(resolve => setTimeout(
        resolve,
        Math.max(0, sampleIntervalMs - (performance.now() - loopStartedAt))
      ))
    }

    stopCamera()
    cancelButton.hidden = true
    if (cancelRequested) {
      status.textContent = 'Assessment cancelled. No report was created.'
      return
    }

    timeRemaining.textContent = '00:00'
    const payload = PainAssessment.calculateAssessment({
      childId: document.getElementById('childId').value,
      samples,
      processedFrames,
      context
    })
    pendingPayload = payload
    renderReport(payload, false)

    try {
      await savePayload(payload)
      status.textContent = 'One-minute capture complete. The report was saved for this server session.'
    } catch (error) {
      console.error('Unable to save the assessment report:', error)
      status.textContent = `Capture complete, but report saving failed: ${error.message}`
      saveStatus.textContent = `Not saved: ${error.message}. Retry while this page and local server remain open.`
      retrySaveButton.hidden = false
    }
  } catch (error) {
    stopCamera()
    status.textContent = `Assessment could not be completed: ${error.message}`
    console.error('Facial assessment failed:', error)
  } finally {
    running = false
    starting = false
    cancelButton.hidden = true
    startButton.disabled = !modelsReady
    startButton.textContent = 'Start another one-minute assessment'
  }
}

cancelButton.addEventListener('click', () => {
  cancelRequested = true
  running = false
  stopCamera()
  status.textContent = 'Stopping assessment without creating a report…'
})

retrySaveButton.addEventListener('click', async () => {
  if (!pendingPayload) return
  retrySaveButton.disabled = true
  try {
    await savePayload(pendingPayload)
    status.textContent = 'The report was saved for this server session.'
  } catch (error) {
    console.error('Unable to save the assessment report:', error)
    saveStatus.textContent = `Not saved: ${error.message}. Retry while this page and local server remain open.`
  } finally {
    retrySaveButton.disabled = false
    retrySaveButton.hidden = !pendingPayload
  }
})

form.addEventListener('submit', startAssessment)

async function loadModels() {
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceExpressionNet.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models')
    ])
    modelsReady = true
    startButton.disabled = false
    startButton.textContent = 'Start one-minute assessment'
    status.textContent = 'Models ready. Enter a synthetic demo ID and start when ready.'
  } catch (error) {
    status.textContent = `Unable to load models: ${error.message}`
    console.error('Unable to load face assessment models:', error)
  }
}

loadModels()
