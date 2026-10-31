const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const root = __dirname
const port = 3100
const maxRequestBytes = 16 * 1024
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream'
}
const contextRanges = {
  temperatureC: [20, 45],
  nutritionScore: [1, 10],
  bloodPressureSystolic: [30, 300],
  bloodPressureDiastolic: [20, 200],
  bowelMovementCount: [0, 1000]
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(body)
}

function validateAssessmentPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'Request body must be a JSON object.'
  }
  if (typeof payload.childId !== 'string' || payload.childId.trim().length === 0 || payload.childId.trim().length > 100) {
    return 'childId must contain 1 to 100 characters.'
  }
  if (!['calm', 'mild', 'moderate-severe'].includes(payload.painLevel)) {
    return 'painLevel is invalid.'
  }
  if (typeof payload.painScore !== 'number' || !Number.isFinite(payload.painScore) ||
      payload.painScore < 0 || payload.painScore > 100) {
    return 'painScore must be a number from 0 to 100.'
  }
  if (!Number.isInteger(payload.confidence) || payload.confidence < 0 || payload.confidence > 100) {
    return 'confidence must be an integer from 0 to 100.'
  }
  if (!Array.isArray(payload.reasons) || payload.reasons.length > 20 ||
      payload.reasons.some(reason => typeof reason !== 'string' || reason.length > 300)) {
    return 'reasons must be an array of at most 20 short strings.'
  }
  if (typeof payload.guidance !== 'string' || payload.guidance.length > 1000) {
    return 'guidance must be a string of at most 1000 characters.'
  }

  const context = payload.context === undefined ? {} : payload.context
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return 'context must be a JSON object.'
  }
  for (const [name, value] of Object.entries(context)) {
    const range = contextRanges[name]
    if (!range) return `Unknown context field: ${name}`
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
      return `${name} is outside its accepted range.`
    }
    if (name !== 'temperatureC' && !Number.isInteger(value)) {
      return `${name} must be a whole number.`
    }
  }
  if ((context.bloodPressureSystolic === undefined) !== (context.bloodPressureDiastolic === undefined)) {
    return 'Enter both blood pressure values or leave both blank.'
  }
  return undefined
}

function createServer() {
  const assessmentRecords = []

  return http.createServer((request, response) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    } catch (error) {
      response.writeHead(400).end('Bad request')
      return
    }

    if (pathname === '/api/assessments') {
      if (request.method === 'GET') {
        sendJson(response, 200, assessmentRecords)
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' })
        return
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        sendJson(response, 415, { error: 'Content-Type must be application/json.' })
        return
      }

      const chunks = []
      let receivedBytes = 0
      let oversized = false
      request.on('data', chunk => {
        receivedBytes += chunk.length
        if (receivedBytes > maxRequestBytes) {
          oversized = true
          chunks.length = 0
          return
        }
        if (!oversized) chunks.push(chunk)
      })
      request.on('end', () => {
        if (oversized) {
          sendJson(response, 413, { error: 'Assessment request is too large.' })
          return
        }

        let payload
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          sendJson(response, 400, { error: 'Request body must contain valid JSON.' })
          return
        }

        const validationError = validateAssessmentPayload(payload)
        if (validationError) {
          sendJson(response, 400, { error: validationError })
          return
        }

        const record = {
          childId: payload.childId.trim(),
          painLevel: payload.painLevel,
          painScore: payload.painScore,
          confidence: payload.confidence,
          reasons: payload.reasons,
          guidance: payload.guidance,
          createdAt: new Date().toISOString(),
          context: payload.context || {}
        }
        assessmentRecords.push(record)
        sendJson(response, 201, record)
      })
      request.on('error', error => {
        console.error('Assessment request failed:', error)
        if (!response.headersSent) sendJson(response, 400, { error: 'Unable to read assessment request.' })
      })
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end('Method not allowed')
      return
    }

    if (pathname === '/') pathname = '/index.html'

    const filePath = path.resolve(root, `.${pathname}`)
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      response.writeHead(403).end('Forbidden')
      return
    }

    fs.stat(filePath, (statError, stats) => {
      if (statError || !stats.isFile()) {
        response.writeHead(404).end('Not found')
        return
      }

      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'Content-Length': stats.size,
        'X-Content-Type-Options': 'nosniff'
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      fs.createReadStream(filePath).pipe(response)
    })
  })
}

if (require.main === module) {
  const server = createServer()
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`
    console.log(`Experimental facial assessment is ready at ${url}`)
    execFile('cmd.exe', ['/c', 'start', '', url])
  })
}

module.exports = { createServer }
