const params = new URLSearchParams(location.search)
const profileId = params.get('profileId')
const assessmentId = params.get('assessmentId')
const video = document.getElementById('video')
const canvas = document.getElementById('overlay')
const startButton = document.getElementById('start-button')
const cancelButton = document.getElementById('cancel-button')
const status = document.getElementById('status')
const timeRemaining = document.getElementById('time-remaining')
const durationMs = 60_000
const sampleIntervalMs = 200
const captureStorageKey = `littlecare_face_capture:${assessmentId}`
let modelsReady = false
let starting = false
let running = false

function stopCamera() {
  const stream = video.srcObject
  if (stream) stream.getTracks().forEach((track) => track.stop())
  video.srcObject = null
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
}

function getLandmarkFeatures(positions) {
  if (!Array.isArray(positions) || positions.length < 68 || !video.videoWidth || !video.videoHeight) {
    throw new Error('The face landmark model did not return a usable 68-point face.')
  }

  const leftEye = positions[36]
  const rightEye = positions[45]
  const nose = positions[30]
  const upperLip = positions[62]
  const lowerLip = positions[66]
  const eyeDistance = Math.max(
    Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y),
    1
  )

  return {
    headX: nose.x / video.videoWidth,
    headY: nose.y / video.videoHeight,
    yaw: (nose.x - (leftEye.x + rightEye.x) / 2) / eyeDistance,
    tilt: Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x),
    jawRatio: Math.hypot(lowerLip.x - upperLip.x, lowerLip.y - upperLip.y) / eyeDistance
  }
}

function drawOverlay(result) {
  const dimensions = faceapi.matchDimensions(canvas, video, true)
  const resized = faceapi.resizeResults(result, dimensions)
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, canvas.width, canvas.height)
  faceapi.draw.drawDetections(canvas, resized)
  faceapi.draw.drawFaceLandmarks(canvas, resized)
  faceapi.draw.drawFaceExpressions(canvas, resized, 0.1)
}

function getObservationSummary(assessment) {
  const context = assessment.context || {}
  const items = []
  if (Number.isFinite(context.temperatureC)) items.push(`Temperature: ${context.temperatureC} °C`)
  if (Number.isInteger(context.nutritionScore)) items.push(`Nutrition: ${context.nutritionScore}/10`)
  if (Number.isInteger(context.bloodPressureSystolic) &&
      Number.isInteger(context.bloodPressureDiastolic)) {
    items.push(`Blood pressure: ${context.bloodPressureSystolic}/${context.bloodPressureDiastolic} mmHg`)
  }
  if (Number.isInteger(context.bowelMovementCount)) {
    items.push(`Bowel movements: ${context.bowelMovementCount}`)
  }
  return items.length ? items.join(' · ') : 'No optional observations were entered.'
}

async function loadModelsAndAssessment() {
  if (!profileId || !/^[1-9]\d{0,17}$/.test(profileId) ||
      !assessmentId || !/^[1-9]\d{0,17}$/.test(assessmentId)) {
    throw new Error('Select a child and save the optional observations before starting.')
  }

  const [profilesResponse, assessmentResponse] = await Promise.all([
    fetch('/api/child-profiles'),
    fetch(`/api/child-profiles/${encodeURIComponent(profileId)}/assessments/latest`)
  ])
  const [profiles, latest] = await Promise.all([
    profilesResponse.json(),
    assessmentResponse.json()
  ])
  if (!profilesResponse.ok) throw new Error(profiles.error || 'Could not load child profiles.')
  if (!assessmentResponse.ok) throw new Error(latest.error || 'Could not load the saved observations.')
  const profile = profiles.profiles.find((item) => item.id === profileId)
  if (!profile) throw new Error('The selected child profile was not found.')
  if (!latest.assessment || latest.assessment.id !== assessmentId) {
    throw new Error('This assessment is no longer the latest saved assessment. Return and start again.')
  }
  document.getElementById('child-name').textContent = `Selected child: ${profile.displayName}`
  document.getElementById('observation-summary').textContent = getObservationSummary(latest.assessment)

  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri('/webcam-assets/models'),
    faceapi.nets.faceExpressionNet.loadFromUri('/webcam-assets/models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('/webcam-assets/models')
  ])
  modelsReady = true
  startButton.disabled = false
  startButton.textContent = 'Start one-minute assessment'
  status.textContent = 'Models ready. Start when the child’s face is visible in the camera.'
}

async function startAssessment() {
  if (!modelsReady || starting) return
  starting = true
  running = true
  startButton.disabled = true
  cancelButton.hidden = false
  status.textContent = 'Requesting camera access. The one-minute assessment starts when the camera is ready.'

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support camera access.')
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    })
    if (!running) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    video.srcObject = stream
    await video.play()
    const samples = []
    let processedFrames = 0
    const startedAt = performance.now()
    status.textContent = 'Assessment in progress. This experimental result is not a medical assessment.'

    while (running && performance.now() - startedAt < durationMs) {
      const loopStartedAt = performance.now()
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        processedFrames += 1
        const result = await faceapi
          .detectSingleFace(
            video,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 })
          )
          .withFaceLandmarks()
          .withFaceExpressions()
        if (result) {
          samples.push({
            expressions: result.expressions,
            detectionScore: result.detection.score,
            landmarks: getLandmarkFeatures(result.landmarks.positions)
          })
          drawOverlay(result)
        } else {
          canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
        }
      }

      const elapsedMs = performance.now() - startedAt
      const secondsLeft = Math.max(0, Math.ceil((durationMs - elapsedMs) / 1000))
      timeRemaining.textContent = `00:${String(secondsLeft).padStart(2, '0')}`
      status.textContent = samples.length
        ? `Assessment in progress: ${samples.length} face samples captured.`
        : 'Assessment in progress: looking for a face in the camera.'
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.max(0, sampleIntervalMs - (performance.now() - loopStartedAt))
      ))
    }

    stopCamera()
    cancelButton.hidden = true
    if (!running) {
      status.textContent = 'Assessment cancelled. No report was created.'
      return
    }

    timeRemaining.textContent = '00:00'
    if (samples.length < 10) {
      throw new Error('Fewer than 10 face samples were captured. Improve the camera view and try again.')
    }
    try {
      sessionStorage.setItem(captureStorageKey, JSON.stringify({ samples, processedFrames }))
    } catch (error) {
      throw new Error(`Facial samples could not be held for the confirmation step: ${error.message}`)
    }
    status.textContent = 'Capture complete. Continue to the parent confirmation questions before calculating the report.'
    location.assign(
      `/ai-disambiguation?profileId=${encodeURIComponent(profileId)}&assessmentId=${encodeURIComponent(assessmentId)}`
    )
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
  running = false
  stopCamera()
  status.textContent = 'Stopping assessment without creating a report…'
})

startButton.addEventListener('click', startAssessment)
window.addEventListener('beforeunload', stopCamera)
loadModelsAndAssessment().catch((error) => {
  status.textContent = `Unable to prepare assessment: ${error.message}`
  console.error('Facial assessment setup failed:', error)
})
