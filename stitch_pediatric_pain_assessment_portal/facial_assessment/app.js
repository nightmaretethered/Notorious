const params = new URLSearchParams(location.search)
const profileId = params.get('profileId')
const assessmentId = params.get('assessmentId')
const video = document.getElementById('video')
const canvas = document.getElementById('overlay')
const startButton = document.getElementById('start-button')
const startButtonLabel = document.getElementById('start-button-label')
const cancelButton = document.getElementById('cancel-button')
const status = document.getElementById('status')
const timeRemaining = document.getElementById('time-remaining')
const durationMs = 60_000
const sampleIntervalMs = 200
const captureStorageKey = `littlecare_face_capture:${assessmentId}`
let modelsReady = false
let activeRun = null

function setStartButtonText(text) {
  if (startButtonLabel) startButtonLabel.textContent = text
  else startButton.textContent = text
}

function stopCamera(run = activeRun) {
  const stream = run?.stream || video.srcObject
  if (stream && (!run || !run.streamStopped)) {
    if (run) run.streamStopped = true
    stream.getTracks().forEach((track) => {
      if (track.readyState !== 'ended') track.stop()
    })
  }
  if (!run || video.srcObject === stream) video.srcObject = null
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
  setStartButtonText('Start one-minute assessment')
  status.textContent = 'Models ready. Start when the child’s face is visible in the camera.'
}

async function startAssessment() {
  if (!modelsReady || activeRun) return
  let resolveCancellation
  const run = {
    cancelled: false,
    stream: null,
    streamStopped: false,
    cancellation: new Promise((resolve) => {
      resolveCancellation = resolve
    })
  }
  run.cancel = () => {
    if (run.cancelled) return
    run.cancelled = true
    resolveCancellation()
  }
  activeRun = run
  startButton.disabled = true
  cancelButton.hidden = false
  status.textContent = 'Requesting camera access. The one-minute assessment starts when the camera is ready.'

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support camera access.')
    }
    const cameraRequest = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    })
    const stream = await Promise.race([
      cameraRequest,
      run.cancellation.then(() => null)
    ])
    if (!stream) {
      cameraRequest.then((lateStream) => {
        lateStream.getTracks().forEach((track) => track.stop())
      }).catch((error) => {
        if (!run.cancelled) console.error('Camera access failed after cancellation:', error)
      })
      return
    }

    run.stream = stream
    video.srcObject = stream
    await Promise.race([video.play(), run.cancellation])
    if (run.cancelled) return
    const samples = []
    let processedFrames = 0
    const startedAt = performance.now()
    status.textContent = 'Assessment in progress. This experimental result is not a medical assessment.'

    while (!run.cancelled && performance.now() - startedAt < durationMs) {
      const loopStartedAt = performance.now()
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        processedFrames += 1
        const detection = faceapi
          .detectSingleFace(
            video,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 })
          )
          .withFaceLandmarks()
          .withFaceExpressions()
        const result = await Promise.race([
          detection,
          run.cancellation.then(() => null)
        ])
        if (run.cancelled) break
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
      await Promise.race([
        new Promise((resolve) => setTimeout(
          resolve,
          Math.max(0, sampleIntervalMs - (performance.now() - loopStartedAt))
        )),
        run.cancellation
      ])
    }

    stopCamera(run)
    if (run.cancelled) return

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
    if (!run.cancelled) {
      status.textContent = `Assessment could not be completed: ${error.message}`
      console.error('Facial assessment failed:', error)
    }
  } finally {
    stopCamera(run)
    if (activeRun === run) {
      activeRun = null
      cancelButton.hidden = true
      startButton.disabled = !modelsReady
      setStartButtonText('Start one-minute assessment')
      if (run.cancelled) {
        timeRemaining.textContent = '01:00'
        status.textContent = 'Assessment stopped. No report was created. You can start again when ready.'
      }
    }
  }
}

cancelButton.addEventListener('click', () => {
  if (!activeRun) return
  activeRun.cancel()
  stopCamera(activeRun)
  sessionStorage.removeItem(captureStorageKey)
  cancelButton.hidden = true
  status.textContent = 'Assessment stopped. No report was created. You can start again when ready.'
})

startButton.addEventListener('click', startAssessment)
window.addEventListener('beforeunload', () => {
  if (activeRun) activeRun.cancel()
  stopCamera()
})
loadModelsAndAssessment().catch((error) => {
  status.textContent = `Unable to prepare assessment: ${error.message}`
  console.error('Facial assessment setup failed:', error)
})
