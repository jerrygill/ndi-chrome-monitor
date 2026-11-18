from __future__ import annotations

import asyncio
import io
import json
import socket
import struct
import threading
import time
import unittest
import urllib.request

import numpy as np
import uvicorn
import websockets
from PIL import Image

from server.app import app
from server.ndi_manager import DEMO_SOURCE_NAME, NDIManager, _uyvy_to_rgb


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class NDIManagerUnitTests(unittest.TestCase):
    def test_uyvy_to_rgb_with_padded_stride(self) -> None:
        # 4x2 neutral gray (Y=128, U=128, V=128) with stride=12 (4 bytes padding per row)
        xres, yres, stride = 4, 2, 12
        buf = np.zeros((yres, stride), dtype=np.uint8)
        row_pixels = np.array([128, 128, 128, 128, 128, 128, 128, 128], dtype=np.uint8)
        buf[0, :8] = row_pixels
        buf[1, :8] = row_pixels

        rgb = _uyvy_to_rgb(buf.reshape(-1), xres, yres, stride)
        self.assertEqual(rgb.shape, (yres, xres, 3))
        self.assertEqual(rgb.dtype, np.uint8)
        # BT.601 Y=128 (limited range -> 112*1.16438 ~= 130)
        self.assertTrue(np.all((rgb >= 120) & (rgb <= 140)))

    def test_encode_rgb_jpeg_downscales_cleanly(self) -> None:
        mgr = NDIManager(
            on_video_frame=lambda *_: None,
            on_audio_frame=lambda *_: None,
            on_sources_changed=lambda *_: None,
            on_status_changed=lambda *_: None,
        )
        rgb = np.full((720, 1280, 3), 90, dtype=np.uint8)
        jpeg, out_w, out_h = mgr._encode_rgb_jpeg(rgb, max_width=640, quality=75)
        self.assertEqual((out_w, out_h), (640, 360))
        self.assertTrue(jpeg.startswith(b"\xff\xd8\xff"))
        decoded = Image.open(io.BytesIO(jpeg))
        self.assertEqual(decoded.size, (640, 360))

    def test_update_config_clamps_values(self) -> None:
        mgr = NDIManager(
            on_video_frame=lambda *_: None,
            on_audio_frame=lambda *_: None,
            on_sources_changed=lambda *_: None,
            on_status_changed=lambda *_: None,
        )
        st = mgr.update_config(max_width=50, fps=200, quality=5, bandwidth="lowest")
        self.assertEqual(st["config"]["max_width"], 320)
        self.assertEqual(st["config"]["fps"], 60)
        self.assertEqual(st["config"]["quality"], 30)
        self.assertEqual(st["config"]["bandwidth"], "lowest")


class BridgeEndToEndTests(unittest.TestCase):
    port: int
    server: uvicorn.Server
    thread: threading.Thread

    @classmethod
    def setUpClass(cls) -> None:
        cls.port = _free_port()
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=cls.port,
            log_level="warning",
        )
        cls.server = uvicorn.Server(config)
        cls.server.install_signal_handlers = lambda: None
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            try:
                with opener.open(f"http://127.0.0.1:{cls.port}/api/health", timeout=1) as resp:
                    if resp.status == 200:
                        return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("Uvicorn test server failed to start")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.should_exit = True
        cls.thread.join(timeout=5.0)

    def _get(self, path: str) -> tuple[int, str, bytes]:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{self.port}{path}", timeout=3) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()

    def test_http_endpoints_and_static_assets(self) -> None:
        status, ctype, html = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn(b'id="ndiCanvas"', html)

        for asset in (
            "/styles.css",
            "/app.js",
            "/manifest.webmanifest",
            "/icon.svg",
            "/icon-192.png",
            "/apple-touch-icon.png",
        ):
            st, _, body = self._get(asset)
            self.assertEqual(st, 200, f"Asset {asset} failed")
            self.assertGreater(len(body), 50)

        st, _, info_raw = self._get("/api/info")
        self.assertEqual(st, 200)
        info = json.loads(info_raw.decode("utf-8"))
        self.assertIn("lan_url", info)
        self.assertIn("extension_ws_local", info)

        st, ctype, svg = self._get("/api/qr.svg")
        self.assertEqual(st, 200)
        self.assertIn("image/svg+xml", ctype)
        self.assertIn(b"<svg", svg)

    def test_websocket_monitor_demo_stream_and_extension_relay(self) -> None:
        asyncio.run(self._async_ws_roundtrip())

    async def _async_ws_roundtrip(self) -> None:
        base_ws = f"ws://127.0.0.1:{self.port}"
        async with websockets.connect(f"{base_ws}/ws/monitor") as mon_ws:
            snapshot = json.loads(await asyncio.wait_for(mon_ws.recv(), timeout=3.0))
            self.assertEqual(snapshot["type"], "state_snapshot")
            self.assertFalse(snapshot["chrome"]["connected"])

            async with websockets.connect(f"{base_ws}/ws/extension") as ext_ws:
                welcome = json.loads(await asyncio.wait_for(ext_ws.recv(), timeout=3.0))
                self.assertEqual(welcome["type"], "welcome")

                await ext_ws.send(
                    json.dumps(
                        {
                            "type": "hello",
                            "extension_id": "anjokcpcmbhbimpjgbffkjfbnciaaeff",
                            "studio_mode": True,
                            "debugger_enabled": True,
                        }
                    )
                )

                sample_state = {
                    "extension_id": "anjokcpcmbhbimpjgbffkjfbnciaaeff",
                    "studio_mode": True,
                    "debugger_enabled": True,
                    "active_tab_id": 102,
                    "shared_tab_id": None,
                    "tabs": [
                        {
                            "id": 101,
                            "title": "Team Sync - Google Meet",
                            "url": "https://meet.google.com/abc-defg-hij",
                            "kind": "meet",
                            "active": False,
                            "audible": False,
                            "muted": False,
                        },
                        {
                            "id": 102,
                            "title": "Quarterly Deck - Google Slides",
                            "url": "https://docs.google.com/presentation/d/123/present",
                            "kind": "slides",
                            "active": True,
                            "audible": False,
                            "muted": False,
                        },
                        {
                            "id": 103,
                            "title": "Product Keynote - YouTube",
                            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                            "kind": "youtube",
                            "active": False,
                            "audible": True,
                            "muted": False,
                        },
                    ],
                    "meet": {
                        "101": {
                            "meetingCode": "abc-defg-hij",
                            "inMeeting": True,
                            "isPresenting": False,
                            "micMuted": False,
                            "camOff": False,
                        }
                    },
                    "slides": {
                        "102": {
                            "title": "Quarterly Deck",
                            "isPresenting": True,
                            "currentSlide": 3,
                            "totalSlides": 12,
                        }
                    },
                    "youtube": {
                        "103": {
                            "title": "Product Keynote",
                            "hasVideo": True,
                            "paused": False,
                            "currentTime": 14.0,
                            "duration": 180.0,
                            "muted": False,
                            "volume": 85,
                            "fillTab": False,
                            "hideHud": False,
                        }
                    },
                }
                await ext_ws.send(json.dumps({"type": "chrome_state", "state": sample_state}))

                # Wait until monitor observes updated chrome_state
                seen_state = False
                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline:
                    raw = await asyncio.wait_for(mon_ws.recv(), timeout=2.0)
                    if isinstance(raw, str):
                        msg = json.loads(raw)
                        if msg.get("type") == "chrome_state" and len(msg["chrome"]["tabs"]) == 3:
                            self.assertTrue(msg["chrome"]["studio_mode"])
                            seen_state = True
                            break
                self.assertTrue(seen_state)

                # Test bidirectional command relay across several actions
                commands = [
                    ("tabs:open_url", {"url": "https://example.com", "active": True}),
                    ("meet:share_tab", {"tabId": 101, "targetTabId": 102}),
                    ("slides:next", {"tabId": 102}),
                    ("youtube:togglePlay", {"tabId": 103}),
                    ("youtube:fillTab", {"tabId": 103, "enabled": True}),
                    ("meet:stop_share", {"tabId": 101}),
                ]
                for idx, (action, payload) in enumerate(commands):
                    req_id = f"req-{idx}"
                    await mon_ws.send(
                        json.dumps(
                            {
                                "type": "chrome:command",
                                "action": action,
                                "payload": payload,
                                "request_id": req_id,
                            }
                        )
                    )
                    cmd_msg = json.loads(await asyncio.wait_for(ext_ws.recv(), timeout=2.0))
                    self.assertEqual(cmd_msg["type"], "command")
                    self.assertEqual(cmd_msg["action"], action)
                    self.assertEqual(cmd_msg["payload"], payload)

                    await ext_ws.send(
                        json.dumps(
                            {
                                "type": "command_result",
                                "request_id": req_id,
                                "ok": True,
                                "message": f"Executed {action}",
                            }
                        )
                    )

                    got_result = False
                    res_deadline = time.monotonic() + 2.0
                    while time.monotonic() < res_deadline:
                        raw = await asyncio.wait_for(mon_ws.recv(), timeout=2.0)
                        if isinstance(raw, str):
                            msg = json.loads(raw)
                            if msg.get("type") == "command_result" and msg.get("request_id") == req_id:
                                self.assertTrue(msg["ok"])
                                self.assertEqual(msg["action"], action)
                                got_result = True
                                break
                    self.assertTrue(got_result, f"Missing command_result for {action}")

                # Enable monitor audio + select Built-in Demo NDI signal -> verify live binary packets
                await mon_ws.send(
                    json.dumps({"type": "monitor:prefs", "video_enabled": True, "audio_enabled": True})
                )
                await mon_ws.send(
                    json.dumps({"type": "ndi:select_source", "source": DEMO_SOURCE_NAME})
                )

                got_video = False
                got_audio = False
                stream_deadline = time.monotonic() + 5.0
                while time.monotonic() < stream_deadline and not (got_video and got_audio):
                    frame = await asyncio.wait_for(mon_ws.recv(), timeout=2.0)
                    if isinstance(frame, (bytes, bytearray)):
                        if frame[0] == 1:
                            img = Image.open(io.BytesIO(frame[1:]))
                            self.assertGreater(img.width, 0)
                            self.assertGreater(img.height, 0)
                            got_video = True
                        elif frame[0] == 2:
                            kind, ch, _reserved, sr = struct.unpack("<BBHI", frame[:8])
                            self.assertEqual(kind, 2)
                            self.assertEqual(ch, 2)
                            self.assertEqual(sr, 48000)
                            self.assertGreater(len(frame), 8)
                            got_audio = True

                self.assertTrue(got_video, "Did not receive demo video JPEG frame over /ws/monitor")
                self.assertTrue(got_audio, "Did not receive demo PCM audio frame over /ws/monitor")

                # Reset NDI source back to empty
                await mon_ws.send(json.dumps({"type": "ndi:select_source", "source": ""}))

            # After extension exits cleanly, monitor receives disconnected chrome_state
            disconnected_seen = False
            disc_deadline = time.monotonic() + 3.0
            while time.monotonic() < disc_deadline:
                raw = await asyncio.wait_for(mon_ws.recv(), timeout=2.0)
                if isinstance(raw, str):
                    msg = json.loads(raw)
                    if msg.get("type") == "chrome_state" and not msg["chrome"]["connected"]:
                        disconnected_seen = True
                        break
            self.assertTrue(disconnected_seen)


if __name__ == "__main__":
    unittest.main()
