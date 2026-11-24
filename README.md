# Showcase Studio

Showcase Studio is a local Windows desktop app for turning live websites into screenshots, device mockups, scroll videos, and portfolio materials. It can capture public HTTP/HTTPS sites and development servers such as `http://localhost:3000`. It stores project data and exports on your machine.

## Set up on Windows 10 or 11 (x64)

Install Node.js 22 LTS or newer and a build of FFmpeg with the `libx264` encoder. From PowerShell with `winget` available:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Gyan.FFmpeg --exact
```

Open a new PowerShell window so the updated `PATH` is available. From the FlowWEB checkout:

```powershell
node --version
ffmpeg -version
npm.cmd install
npm.cmd run setup
npm.cmd run dev
```

`npm.cmd run setup` installs the Playwright Chromium version used by the project when needed and verifies that FFmpeg provides `libx264`. The `npm.cmd` entry point works in PowerShell when its script execution policy blocks `npm.ps1`. To point Showcase Studio at an existing executable, set one or both overrides before launching it:

```powershell
$env:SHOWCASE_CHROMIUM_PATH = 'C:\Path\To\chrome.exe'
$env:SHOWCASE_FFMPEG_PATH = 'C:\Path\To\ffmpeg.exe'
npm.cmd run setup
npm.cmd run dev
```

## Capture and export

- Create a project with a website URL and optional category, description, technologies, and features. Thumbnail capture runs in the background.
- **Screenshot Studio** captures any combination of desktop, laptop, tablet, mobile, and custom sizes. Preview the result before saving as PNG or JPEG. For interaction, open the live Chromium window, interact with the page there, then capture from Screenshot Studio.
- **Mockup Studio** previews seven device layouts and eight original templates. Start from a saved screenshot, capture the project website, or import your own assets. Customize the background, frame geometry, text, and export size up to 4K.
- The **Portfolio** tab in Mockup Studio builds a composition with desktop, mobile, and a device mockup. It exports the image, editable description text, and project JSON. Presets set the canvas dimensions for each use and can be adjusted.
- **Video Studio** records live pages in static, smooth, top-to-bottom, return-scroll, and manual modes. Export H.264 MP4 as landscape, portrait, square, or a custom size. Manual recordings run for the selected duration in a separate Chromium window.
- **Batch Export** queues selected projects and reports progress per project. Select device screenshots, a full-page screenshot, a mockup, a scrolling video, and portfolio text. You can cancel the batch, skip a project, or retry failed work.
- **Export History** opens exported files and their folders. **Settings** updates output defaults, theme, browser timeout, and batch concurrency. Automatic project saving preserves the in-progress form as a local draft.

Exports default to `Documents\Showcase Exports`. Each project keeps a stable folder with a short identifier to avoid naming collisions. Files are organized into `Screenshots`, `Mockups`, `Videos`, and `Portfolio`. A repeated export gets a numeric suffix. The app's workspace data is stored in `showcase.json` under its Electron user-data directory.

## Test

```powershell
npm.cmd run setup
npm.cmd run test
```

The tests serve local pages to verify responsive screenshots and real scroll footage, exercise persistent storage and the queue, inspect PNG/JPEG mockup and portfolio output, and run a multi-project batch. The asset integration tests require Chromium and FFmpeg.

## Build the Windows installer

From the checkout on Windows x64:

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run build
```

Electron Builder writes `release\Showcase Studio Setup 1.0.0.exe`. This is an unsigned per-user NSIS installer. Install FFmpeg separately and make it available on `PATH`. Playwright uses a per-user browser cache. If you install Showcase Studio on a different machine, install the matching Chromium build there:

```powershell
npx.cmd --yes playwright@1.65.1 install chromium
```

That browser-install command requires Node.js and npm. If you already have a compatible Chromium executable, set `SHOWCASE_CHROMIUM_PATH` for your user account and restart the app. The packaged app shows dependency status in Settings.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/main.js`, `src/preload.js` | Electron window, validated IPC, native file dialogs, and startup/shutdown |
| `src/renderer/` | Desktop interface, editors, local theme and UI state |
| `src/services/browser.js`, `screenshot.js`, `video.js` | Isolated Chromium capture, scrolling, frame recording, and FFmpeg export |
| `src/services/mockup.js`, `graphics.js`, `portfolio.js` | Original device frames, image compositing, and portfolio output |
| `src/services/storage.js`, `exports.js`, `queue.js` | Atomic JSON state, organized outputs, and cancellable batch execution |
| `src/services/studio.js`, `inputs.js` | Validated options, preview assets, job orchestration, and export history |

## Limits

- Interactive preview and manual recording require a graphical desktop. Website sessions use temporary browser contexts. Logins, CAPTCHAs, and site-specific consent flows may require manual interaction.
- Extremely tall or continuously expanding pages are subject to Chromium and image-size limits. Lazy-loading and consent dismissal cover common page patterns.
- Video has no audio track. H.264 output needs even pixel dimensions. Render performance depends on the page, browser, and machine.
- Device screens crop to fit frame proportions. Perspective adjusts tilt and apparent depth in the composition.
