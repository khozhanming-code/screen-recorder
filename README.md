# FrameCap – Web-Based Screen Recorder

A browser screen recorder built only with native web APIs. No frameworks, no build step, no server code, and **nothing is uploaded**. Recordings stay in your browser.

## Features

- Record a monitor, application window, or browser tab (`getDisplayMedia`)
- Pause / resume with a timer that excludes paused time
- Microphone with live level meter, volume, echo cancellation and noise suppression
- System / tab audio where the browser and chosen source provide it, mixed with the mic into a single audio track (Web Audio API)
- Webcam overlay: drag, circle or rectangle, size, mirror, hide/show
- **Studio mode**: screen + webcam composited on a canvas so the webcam is part of the saved video
- Settings (resolution, FPS, video/audio bitrate, echo, noise, default file name) applied to the real pipeline
- Preview, download (extension matches the real format), PNG snapshot, and save to an IndexedDB library (thumbnails, rename, delete, preview, download)
- Keyboard shortcuts: `R` record/stop, `P` pause, `S` screen, `C` webcam, `M` mic, `T` studio, `L` library, `,` settings

## Run it

Screen capture needs a secure context, so open it from `http://localhost` or `https://`, not `file://`.

Pick any one:

```bash
# VS Code: install "Live Server", right-click index.html -> Open with Live Server
python3 -m http.server 8080      # then open http://localhost:8080
npx serve .                      # then open the printed address
```

Deploy by uploading the folder to any static host that serves HTTPS (GitHub Pages, Netlify, Cloudflare Pages, cPanel, etc.).

## Project structure

```
screen-recorder/
├── index.html
├── css/style.css            layout, theme, stage
├── css/components.css       buttons, dialogs, library, toasts
└── js/
    ├── app.js               UI events, state, coordination
    ├── recorder.js          MediaRecorder lifecycle, MIME detection, timer
    ├── audio-mixer.js       mic + system audio -> one track
    ├── canvas-compositor.js screen + webcam compositing (Studio mode)
    ├── storage.js           IndexedDB (metadata and blobs in separate stores)
    ├── visualizer.js        microphone level meter
    └── utils.js             formatting, downloads, thumbnails, WebM duration fix
```

## Browser notes and limits

- **Best support: Chrome and Edge (desktop).** Firefox and Safari have partial `getDisplayMedia` / system-audio support.
- **System audio**: Chrome/Edge can share tab audio (any OS) and whole-screen audio (Windows). macOS and most Linux setups cannot capture whole-system audio. If no audio track is shared, the app warns you and keeps recording.
- **Output format** is whatever `MediaRecorder.isTypeSupported()` reports: VP9/VP8 WebM first, then H.264 WebM, then MP4. The app shows the real format and uses the matching file extension.
- **Resolution**: Studio mode renders at the exact size you choose. Without Studio mode the screen track is recorded directly, so the browser decides the final size (settings are requested, not forced).
- **Studio mode while you record another window**: a worker timer keeps drawing frames while this tab is in the background. If the screen layer looks frozen in your browser, keep this tab visible (for example on a second monitor).
- **Storage**: the library lives in this browser's IndexedDB. It is not synced between devices and is cleared if you clear site data. Quota is browser-controlled; a clear error appears if it is full.
- Mobile browsers generally cannot capture the screen, so the app shows a notice there.

## Manual test checklist

1. Select a screen, window and tab, and confirm the preview appears.
2. Record, pause, resume, stop. Confirm the timer excludes the pause.
3. Record with mic, with tab audio, and with both. Confirm both are audible in the result.
4. Enable the webcam, drag it, resize it, switch shape. Record with **Studio** on and confirm it appears in the video; record with it off and confirm it does not.
5. Download, take a snapshot, save to the library, reload the page and confirm it is still there. Rename, preview, download, delete.
6. Deny each permission (screen, camera, mic) and confirm a clear message and a working app.
7. Record several times in a row and watch the browser task manager for steady memory.
