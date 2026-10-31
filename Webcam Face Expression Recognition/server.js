const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const root = __dirname
const port = 3100
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream'
}

http.createServer((request, response) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  } catch (error) {
    response.writeHead(400).end('Bad request')
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
    fs.createReadStream(filePath).pipe(response)
  })
}).listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`
  console.log(`Webcam Face Expression Recognition is ready at ${url}`)
  execFile('cmd.exe', ['/c', 'start', '', url])
})
