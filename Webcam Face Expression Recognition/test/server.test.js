const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('../server.js')

test('assessment API assigns a server timestamp and exposes session reports', async t => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  const response = await fetch(`${baseUrl}/api/assessments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      childId: 'demo-child',
      painLevel: 'mild',
      painScore: 60,
      confidence: 80,
      reasons: ['Example visual reason.'],
      guidance: 'Demo only.',
      context: { temperatureC: 37.2 }
    })
  })

  assert.equal(response.status, 201)
  const saved = await response.json()
  assert.equal(saved.childId, 'demo-child')
  assert.equal(saved.createdAt, new Date(saved.createdAt).toISOString())
  assert.deepEqual(saved.context, { temperatureC: 37.2 })

  const reportsResponse = await fetch(`${baseUrl}/api/assessments`)
  assert.deepEqual(await reportsResponse.json(), [saved])
})

test('assessment API rejects invalid payloads without storing them', async t => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const response = await fetch(`${baseUrl}/api/assessments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      childId: 'demo-child',
      painLevel: 'severe',
      painScore: 110,
      confidence: 101,
      reasons: [],
      guidance: 'Demo only.',
      context: {}
    })
  })

  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /painLevel is invalid/)
  assert.deepEqual(await (await fetch(`${baseUrl}/api/assessments`)).json(), [])
})

test('server exposes the copied full FaceLandmark68 model assets', async t => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const manifestResponse = await fetch(`${baseUrl}/models/face_landmark_68_model-weights_manifest.json`)
  assert.equal(manifestResponse.status, 200)
  const manifest = await manifestResponse.json()
  assert.deepEqual(manifest[0].paths, ['face_landmark_68_model-shard1'])

  const shardResponse = await fetch(`${baseUrl}/models/face_landmark_68_model-shard1`)
  assert.equal(shardResponse.status, 200)
  assert.ok(Number(shardResponse.headers.get('content-length')) > 300_000)
})
