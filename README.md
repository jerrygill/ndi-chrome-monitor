# NDI Chrome Monitor

A low-latency **NDI® network monitor** with **top Chrome remote controls** designed for **iPhone Safari** and desktop browsers, powered by a lightweight Python NDI bridge and a Manifest V3 Chrome Extension.

Watch your live NDI feed while switching tabs, opening URLs, presenting and stepping through Google Slides, controlling YouTube playback/fullscreen, and starting, swapping, or stopping Google Meet tab shares—from one screen.

---

## Architecture

```text
┌─────────────────────────┐      /ws/extension      ┌──────────────────────────┐      /ws/monitor       ┌─────────────────────────────┐
│  Google Chrome + Ext    │ ◀─────────────────────▶ │  FastAPI Bridge Server   │ ◀────────────────────▶ │  iPhone Safari / Desktop    │
│  (Meet, Slides, YT,     │   tabs, Meet, Slides,   │  + NDI® SDK Receiver     │  MJPEG frames + Int16  │  NDI Monitor + Top Controls │
│   URL & Tab Control)    │   YouTube commands      │  (cyndilib + FrameSync)  │  PCM audio + JSON UI   │  (Canvas + WebAudio + PWA)  │
└─────────────────────────┘                         └──────────────────────────┘                        └─────────────────────────────┘
                                                               ▲
                                                               │ LAN mDNS / NDI® stream
                                                        ┌──────┴───────┐
                                                        │ NDI® Senders │
                                                        └──────────────┘
```

- **Bridge Server (`server/`)**: Python 3.10+ FastAPI + `cyndilib` (bundles NDI SDK 6.x runtime libraries cleanly on Windows, macOS, and Linux). Automatically discovers NDI senders on your LAN and includes a `"Built-in Test Signal (Demo)"` generator.
- **Web App (`web/`)**: Mobile-first dark broadcast interface tuned for iPhone Safari (`100dvh`, safe-area padding, tactile hit targets, WebAudio unlock button, QR pairing modal, `Add to Home Screen` PWA manifest).
- **Chrome Extension (`extension/`)**: Fixed extension ID `anjokcpcmbhbimpjgbffkjfbnciaaeff`. Automates Chrome tabs, arbitrary URL opening, Google Slides (`/present`, `Next`, `Prev`, slide jump), YouTube (`Play`/`Pause`, seek, mute/volume, `Fill Tab` clean viewport share mode, `Clean HUD`, `Theater`, `Fullscreen`), and Google Meet (`Share Tab`, `Swap Tab`, `Stop Sharing`, `Mic`, `Cam`, `Leave`).

---

## Quick Start

### 1. Start the NDI Bridge Server

Double-click or run the launcher for your OS:

- **macOS**: Double-click `scripts/start-server.command` (or run `./scripts/start-server.sh`)
- **Windows**: Double-click `scripts\start-server.bat`
- **Linux**: Run `./scripts/start-server.sh`

On first run it automatically creates `.venv/` and installs dependencies (`requirements.txt`). Once running, the terminal prints your local URL, your LAN URL (`http://<YOUR-IP>:8765`), and an **ASCII QR code** to scan with your iPhone Camera.

To pre-select the test signal immediately on startup:
```bash
./scripts/start-server.sh --demo
```

---

### 2. Connect Google Chrome (Choose Normal or Studio Mode)

#### Option A — Normal Chrome Mode (Uses your existing Chrome profile)
1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder inside this repo.
4. Confirm the extension badge turns **`ON`** (green). Your personal logins stay intact.
   - *Note*: Due to Chrome security rules, starting a brand-new Google Meet tab share prompts Chrome's picker (the target tab is automatically tagged **`__NDI_SHARE__ [SHARE THIS]`** at the top of the list for a single confirmation click). Stopping sharing, Mic/Cam toggles, Google Slides, YouTube, and tab/URL switching all run hands-free.

#### Option B — Studio Zero-Click Chrome Mode (Recommended for Live Production)
Run our Studio launcher so Chrome grants allowlisted `tabCapture` access to the extension in an isolated `.ndi-chrome-studio-profile/`:
- **macOS**: Double-click `scripts/launch-studio-chrome.command` (or run `./scripts/launch-studio-chrome.sh`)
- **Windows**: Double-click `scripts\launch-studio-chrome.bat`
- **Linux**: Run `./scripts/launch-studio-chrome.sh`

Studio Mode unlocks:
- **Zero-click** `Share Tab` in Google Meet without manual picker confirmation
- **Zero-downtime live tab swapping** via `RTCRtpSender.replaceTrack` (`Swap Tab`)

---

### 3. Open on iPhone Safari (or Any Browser)

1. Connect your iPhone to the same Wi-Fi network as the host computer.
2. Scan the QR code shown in the server terminal (or click the **`QR`** button inside the desktop web UI).
3. Tap **`🔇 Audio`** once in Safari to unlock iOS WebAudio playback and see the live stereo VU meter.
4. Optional: In Safari tap **Share → Add to Home Screen** for edge-to-edge standalone monitor mode.
5. Use **`▲ Controls`** anytime to collapse/expand the top dock, or **`⛶`** inside the NDI stage for fullscreen view.

---

## Controls Reference

| Section | Actions |
| --- | --- |
| **Header** | Select discovered NDI source or Demo Test Signal, Refresh NDI scan, Extension mode badge (`Studio` / `Connected` / `Offline`), Enable Audio, QR pairing modal, Collapse Top Controls |
| **Quick Bar** | Open any URL directly in Chrome, quick `+ Meet` / `+ Slides` / `+ YouTube` openers, pick any non-Meet tab & click **`Share Tab`** / **`Swap Tab`**, **`Stop`**, **`Mic`**, **`Cam`** |
| **Slides** | Deck selector, **`◀ Prev`**, **`Next ▶`**, **`Present`** (switches `/edit` to `/present` in-tab for clean sharing), **`Exit`**, Slide `#` Jump, **`Share in Meet`** |
| **YouTube** | Video selector, live timeline scrubber, **`-10s` / `▶ Play` / `⏸ Pause` / `+10s`**, **`Mute`**, Volume slider, **`Fill Tab`** (borderless viewport fill ideal for tab sharing), **`Clean HUD`**, **`Theater`**, **`Fullscreen`**, **`Share in Meet`** |
| **Tabs** | Live list of open Chrome tabs with status badges (`MEET`, `SLIDES`, `YT`, `SHARING`) plus 1-tap **`Share`**, **`Focus`**, **`Mute`**, **`↻ Reload`**, **`✕ Close`**, and **`Chrome Fullscreen`** |
| **Meet** | Meeting code badge, Focus Meet, Share Selected Tab (+ optional auto-focus), Stop Sharing, Mic/Cam toggles, two-tap safety Leave Call |
| **Stream** | Adaptive mobile tuning: Resolution (`640w`–`1920w`), Max FPS (`10`–`60`), JPEG Quality (`55`–`88`), NDI Bandwidth (`Full` vs `Proxy/Low BW`) |

---

## Network & NDI Notes

- **Firewall**: Make sure local network / TCP ports **`8765`** (HTTP/WebSocket) and **`5353/udp`** (mDNS NDI discovery) + NDI TCP/UDP media ports (`5960–5990`) are allowed on private/LAN networks on Windows/macOS so your NDI senders and iPhone Safari can connect cleanly.
- **Chrome Auto-Injection**: Tabs already open before the extension connects are automatically injected cleanly on WebSocket connect (`background.js`).

---

## Notice

NDI® is a registered trademark of Vizrt NDI AB. This project uses the MIT-licensed [`cyndilib`](https://github.com/nocarryr/cyndilib) wrapper around the NDI® SDK runtime.
