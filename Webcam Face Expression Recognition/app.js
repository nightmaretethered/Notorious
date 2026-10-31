const video = document.getElementById('video')
const canvas = document.getElementById('overlay')
const status = document.getElementById('status')
const inputSize = document.getElementById('inputSize')
const hideBoxes = document.getElementById('hideBoxes')
const startButton = document.getElementById('startButton')
const recentTimes = []
let running = false
let starting = false

function updateStats(timeMs) {
  recentTimes.push(timeMs)
  if (recentTimes.length > 20) recentTimes.shift()

  const average = recentTimes.reduce((sum, time) => sum + time, 0) / recentTimes.length
  document.getElementById('time').textContent = `${Math.round(average)} ms`
  document.getElementById('fps').textContent = (1000 / average).toFixed(1)
}

async function detectFrame() {
  if (!running) return

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    setTimeout(detectFrame, 100)
    return
  }

  try {
    const startedAt = performance.now()
    const result = await faceapi
      .detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({
          inputSize: Number(inputSize.value),
          scoreThreshold: 0.5
        })
      )
      .withFaceExpressions()

    updateStats(performance.now() - startedAt)
    const dimensions = faceapi.matchDimensions(canvas, video, true)
    const context = canvas.getContext('2d')
    context.clearRect(0, 0, canvas.width, canvas.height)

    if (result) {
      const resized = faceapi.resizeResults(result, dimensions)
      if (!hideBoxes.checked) faceapi.draw.drawDetections(canvas, resized)
      faceapi.draw.drawFaceExpressions(canvas, resized, 0.05)
      status.textContent = 'Face detected. Expression estimates are shown above it.'
    } else {
      status.textContent = 'Looking for a face. Face the camera in good lighting.'
    }

    setTimeout(detectFrame, 100)
  } catch (error) {
    running = false
    video.srcObject?.getTracks().forEach(track => track.stop())
    video.srcObject = null
    startButton.disabled = false
    startButton.textContent = 'Retry camera'
    status.textContent = `Recognition stopped: ${error.message}`
    console.error('Face expression recognition failed:', error)
  }
}

async function start() {
  if (starting || running) return

  starting = true
  startButton.disabled = true
  startButton.textContent = 'Starting...'
  status.textContent = 'Loading models and requesting camera access...'

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceExpressionNet.loadFromUri('/models')
    ])

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 320 },
        height: { ideal: 240 }
      }
    })

    video.srcObject = stream
    await video.play()
    running = true
    startButton.textContent = 'Camera active'
    status.textContent = 'Camera ready. Looking for a face...'
    detectFrame()
  } catch (error) {
    video.srcObject?.getTracks().forEach(track => track.stop())
    video.srcObject = null
    startButton.disabled = false
    startButton.textContent = 'Retry camera'
    const message = error.name === 'NotReadableError'
      ? 'The camera is already in use. Close other apps or tabs using it, then retry.'
      : error.name === 'NotAllowedError'
        ? 'Camera access was denied. Allow camera access in your browser, then retry.'
        : error.message
    status.textContent = `Unable to start: ${message}`
    console.error('Unable to start webcam expression recognition:', error)
  } finally {
    starting = false
  }
}

startButton.addEventListener('click', start)
start()
