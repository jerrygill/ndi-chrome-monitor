from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import socket
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import qrcode
import qrcode.image.svg
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .hub import ControlHub

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT_DIR / "web"

DEFAULT_DEMO = os.environ.get("NDI_DEMO", "0") == "1"
hub = ControlHub(default_demo=DEFAULT_DEMO)


def get_lan_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


def make_qr_svg(url: str) -> str:
    qr = qrcode.QRCode(border=2, box_size=8)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("utf-8")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    hub.bind_loop(asyncio.get_running_loop())
    hub.start()
    try:
        yield
    finally:
        hub.stop()


app = FastAPI(title="NDI Chrome Monitor", lifespan=lifespan)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "ndi": hub.ndi.get_status()})


@app.get("/api/info")
async def info(port: Optional[int] = None) -> JSONResponse:
    lan_ip = get_lan_ip()
    srv_port = port or int(os.environ.get("NDI_PORT", "8765"))
    lan_url = f"http://{lan_ip}:{srv_port}"
    return JSONResponse(
        {
            "lan_ip": lan_ip,
            "port": srv_port,
            "lan_url": lan_url,
            "local_url": f"http://127.0.0.1:{srv_port}",
            "extension_ws_local": f"ws://127.0.0.1:{srv_port}/ws/extension",
            "extension_ws_lan": f"ws://{lan_ip}:{srv_port}/ws/extension",
            "snapshot": hub.get_snapshot(),
        }
    )


@app.get("/api/qr.svg")
async def qr_svg(url: Optional[str] = None) -> Response:
    lan_ip = get_lan_ip()
    srv_port = int(os.environ.get("NDI_PORT", "8765"))
    target = url or f"http://{lan_ip}:{srv_port}"
    svg = make_qr_svg(target)
    return Response(content=svg, media_type="image/svg+xml")


@app.websocket("/ws/monitor")
async def ws_monitor(websocket: WebSocket) -> None:
    await websocket.accept()
    session = hub.register_monitor(websocket)

    await websocket.send_text(json.dumps(hub.get_snapshot()))

    async def sender_json() -> None:
        while True:
            raw = await session.json_queue.get()
            await websocket.send_text(raw)

    async def sender_video() -> None:
        while True:
            pkt = await session.video_queue.get()
            await websocket.send_bytes(pkt)

    async def sender_audio() -> None:
        while True:
            pkt = await session.audio_queue.get()
            await websocket.send_bytes(pkt)

    async def receiver() -> None:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await hub.handle_monitor_message(session, data)

    tasks = [
        asyncio.create_task(sender_json()),
        asyncio.create_task(sender_video()),
        asyncio.create_task(sender_audio()),
        asyncio.create_task(receiver()),
    ]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
        hub.unregister_monitor(session.client_id)


@app.websocket("/ws/extension")
async def ws_extension(websocket: WebSocket) -> None:
    await websocket.accept()
    ext = await hub.register_extension(websocket)
    try:
        await websocket.send_text(
            json.dumps({"type": "welcome", "client_id": ext.client_id})
        )
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await hub.handle_extension_message(ext, data)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.unregister_extension(ext.client_id)


if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


def _print_banner(host: str, port: int) -> None:
    lan_ip = get_lan_ip()
    lan_url = f"http://{lan_ip}:{port}"
    print("\n============================================================")
    print("  NDI CHROME MONITOR")
    print("============================================================")
    print(f"  Desktop Browser : http://127.0.0.1:{port}")
    print(f"  iPhone / iPad   : {lan_url}")
    print(f"  Extension WS    : ws://127.0.0.1:{port}/ws/extension")
    print(f"  Extension ID    : anjokcpcmbhbimpjgbffkjfbnciaaeff")
    print("------------------------------------------------------------")
    try:
        qr = qrcode.QRCode(border=1)
        qr.add_data(lan_url)
        qr.make(fit=True)
        print("  Scan with iPhone Camera to open Monitor:")
        qr.print_ascii(invert=True)
    except Exception:
        pass
    print("============================================================\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="NDI Chrome Monitor Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--demo", action="store_true", help="Start with built-in test pattern selected")
    args = parser.parse_args()

    os.environ["NDI_PORT"] = str(args.port)
    if args.demo:
        hub.ndi.select_source("Built-in Test Signal (Demo)")

    _print_banner(args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
