# Pardon

Pardon is a static browser app that records audio, shows raw speech-to-text output, and generates three selectable rewrite variants from the transcript.

## Features

- Browser audio recording with `MediaRecorder`
- Live speech recognition in supported browsers using `SpeechRecognition` / `webkitSpeechRecognition`
- Raw transcript display with manual editing fallback
- Three context-aware rewrite variants
- No backend required for the core demo
- Lightweight pure-logic tests with Node's built-in test runner

## Project structure

- `index.html` — app shell
- `styles.css` — visual design
- `src/app.js` — browser UI and recording logic
- `src/rewrite.js` — pure rewrite helpers used by the app and tests
- `tests/rewrite.test.js` — Node test coverage for the pure logic
- `server.js` — tiny static server for local preview

## Requirements

- Node.js 20+ recommended
- A browser that supports `MediaRecorder`
- `SpeechRecognition` support for live STT, or manual transcript entry if unsupported

## Setup

```bash
cd /Users/milkeon/workspace/pardon
npm test
npm start
```

Then open the local URL shown in the terminal, typically `http://localhost:4173`.

## Usage

1. Click **Start recording**.
2. Speak into your microphone.
3. Review the raw transcript in the **Raw STT** field.
4. Add a context hint if you want the rewrites to sound like a specific medium or tone.
5. Click one of the three rewrite cards to select it.
6. Use **Copy selected rewrite** to place the chosen version on your clipboard.

If your browser does not support live speech recognition, paste a transcript into the text area manually. The rewrite cards still work.

## Local verification

Run the pure-logic tests:

```bash
npm test
```

Start the static server:

```bash
npm start
```

## GitHub Pages deployment

This project is plain static HTML/CSS/JS, so GitHub Pages can serve it directly from the repository root.

1. Create a GitHub repository named `pardon`.
2. Push this project to the `main` branch.
3. In GitHub, open **Settings → Pages**.
4. Set **Build and deployment** to:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/ (root)`
5. Save the settings and wait for the Pages URL to become available.

Because the app uses relative asset paths, it works from the repository root without a bundler.

## Notes

- The rewrite logic is intentionally deterministic so the demo works without an API key.
- The optional API key field is only for local experiments with a browser-side rewrite API. Do not ship real secrets in the frontend for a public deployment.
