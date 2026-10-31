# Experimental facial assessment demo

Run `Start Webcam Face Expression Recognition.bat` or start the local server with `node server.js`. Open `http://localhost:3100` if it does not open automatically. Camera access requires a supported browser.

The app loads the existing face-api.js detector and expression model plus the full 68-point landmark model. Only `face_landmark_68_model-weights_manifest.json` and `face_landmark_68_model-shard1` were copied from FaceAI; the browser bundle already contains the corresponding FaceLandmark68 implementation.

An assessment captures for one minute after the user starts it. It derives an experimental visual index from sad, angry, fearful, and disgusted expression probabilities, reduces the index when happy or neutral expressions dominate, and adds up to 12 exploratory points for changes in head position/orientation and mouth opening measured from landmarks. Bands are `calm` below 50, `mild` from 50 through 75, and `moderate-severe` above 75. Head/jaw movement can reflect ordinary movement, camera motion, or tracking noise.

The optional temperature, nutrition, blood pressure, and bowel-movement fields are stored as context only; they do not affect the index and are not medically interpreted. The report follows the requested `childId`, `painLevel`, `painScore`, `confidence`, `reasons`, `guidance`, and server-generated `createdAt` fields, with optional `context`. `confidence` means face-detection capture quality only, not confidence that pain is present. `GET /api/assessments` returns reports from the current server process; they are held in memory and disappear when the server restarts.

This is not a pain-scale translator validated for children and cannot guarantee an accurate or consistent pain measurement. Following `DOC-20261031-WA0007`, use consenting adults acting out expressions and synthetic IDs for demos only. Do not record real children or use a result to diagnose, treat, or delay care. The local demo server binds only to `127.0.0.1`; it is not a secure, persistent medical-record service.

Run the dependency-free checks with:

```powershell
node --test test\*.test.js
```
