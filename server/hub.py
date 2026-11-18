from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import WebSocket

from .ndi_manager import NDIManager


@dataclass
class MonitorSession:
    client_id: str
    websocket: WebSocket
    video_enabled: bool = True
    audio_enabled: bool = False
    video_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1))
    audio_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=10))
    json_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=64))


@dataclass
class ExtensionClient:
    client_id: str
    websocket: WebSocket
    connected_at: float
    info: dict[str, Any] = field(default_factory=dict)


class ControlHub:
    """Routes NDI video/audio streams and Chrome Extension remote control state."""

    def __init__(self, default_demo: bool = False) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._monitors: dict[str, MonitorSession] = {}
        self._extension: Optional[ExtensionClient] = None
        self._chrome_state: dict[str, Any] = {
            "connected": False,
            "extension_id": None,
            "studio_mode": False,
            "debugger_enabled": False,
            "tabs": [],
            "active_tab_id": None,
            "meet": {},
            "slides": {},
            "youtube": {},
            "updated_at": None,
        }
        self._pending_commands: dict[str, asyncio.Future] = {}
        self.ndi = NDIManager(
            on_video_frame=self._on_video_frame_thread,
            on_audio_frame=self._on_audio_frame_thread,
            on_sources_changed=self._on_sources_changed_thread,
            on_status_changed=self._on_status_changed_thread,
            default_demo=default_demo,
        )

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def start(self) -> None:
        self.ndi.start()

    def stop(self) -> None:
        self.ndi.stop()

    def get_snapshot(self) -> dict[str, Any]:
        return {
            "type": "state_snapshot",
            "ndi": self.ndi.get_status(),
            "chrome": self._chrome_state,
            "monitors_count": len(self._monitors),
        }

    # --- Thread-safe callbacks from NDIManager ---

    def _on_video_frame_thread(self, payload: bytes, _w: int, _h: int) -> None:
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._fanout_video, payload)

    def _on_audio_frame_thread(self, payload: bytes) -> None:
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._fanout_audio, payload)

    def _on_sources_changed_thread(self, sources: list[str]) -> None:
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(
                self._broadcast_json,
                {"type": "ndi_sources", "sources": sources},
            )

    def _on_status_changed_thread(self, status: dict[str, Any]) -> None:
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(
                self._broadcast_json,
                {"type": "ndi_status", "ndi": status},
            )

    def _fanout_video(self, payload: bytes) -> None:
        for session in list(self._monitors.values()):
            if not session.video_enabled:
                continue
            if session.video_queue.full():
                try:
                    session.video_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                session.video_queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def _fanout_audio(self, payload: bytes) -> None:
        for session in list(self._monitors.values()):
            if not session.audio_enabled:
                continue
            if session.audio_queue.full():
                try:
                    session.audio_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                session.audio_queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def _broadcast_json(self, message: dict[str, Any]) -> None:
        raw = json.dumps(message)
        for session in list(self._monitors.values()):
            if session.json_queue.full():
                try:
                    session.json_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                session.json_queue.put_nowait(raw)
            except asyncio.QueueFull:
                pass

    def _update_subscriber_counts(self) -> None:
        video_count = sum(1 for m in self._monitors.values() if m.video_enabled)
        audio_count = sum(1 for m in self._monitors.values() if m.audio_enabled)
        self.ndi.set_subscriber_counts(video_count, audio_count)

    # --- Monitor WebSocket management ---

    def register_monitor(self, websocket: WebSocket) -> MonitorSession:
        cid = uuid.uuid4().hex[:10]
        session = MonitorSession(client_id=cid, websocket=websocket)
        self._monitors[cid] = session
        self._update_subscriber_counts()
        self._broadcast_json({"type": "monitors_count", "count": len(self._monitors)})
        return session

    def unregister_monitor(self, client_id: str) -> None:
        self._monitors.pop(client_id, None)
        self._update_subscriber_counts()
        self._broadcast_json({"type": "monitors_count", "count": len(self._monitors)})

    async def handle_monitor_message(self, session: MonitorSession, data: dict[str, Any]) -> None:
        msg_type = data.get("type", "")
        if msg_type == "ping":
            await self._enqueue_json(session, {"type": "pong", "ts": time.time()})
            return

        if msg_type == "monitor:prefs":
            if "video_enabled" in data:
                session.video_enabled = bool(data["video_enabled"])
            if "audio_enabled" in data:
                session.audio_enabled = bool(data["audio_enabled"])
            self._update_subscriber_counts()
            return

        if msg_type == "ndi:refresh_sources":
            sources = await asyncio.to_thread(self.ndi.refresh_sources)
            await self._enqueue_json(session, {"type": "ndi_sources", "sources": sources})
            return

        if msg_type == "ndi:select_source":
            source = str(data.get("source", ""))
            status = await asyncio.to_thread(self.ndi.select_source, source)
            self._broadcast_json({"type": "ndi_status", "ndi": status})
            return

        if msg_type == "ndi:config":
            status = await asyncio.to_thread(
                self.ndi.update_config,
                max_width=data.get("max_width"),
                fps=data.get("fps"),
                quality=data.get("quality"),
                bandwidth=data.get("bandwidth"),
            )
            self._broadcast_json({"type": "ndi_status", "ndi": status})
            return

        if msg_type == "chrome:command":
            action = str(data.get("action", ""))
            payload = data.get("payload") or {}
            req_id = str(data.get("request_id") or uuid.uuid4().hex[:12])
            res = await self.send_extension_command(action, payload, req_id)
            await self._enqueue_json(
                session,
                {
                    "type": "command_result",
                    "request_id": req_id,
                    "action": action,
                    **res,
                },
            )
            return

    async def _enqueue_json(self, session: MonitorSession, msg: dict[str, Any]) -> None:
        raw = json.dumps(msg)
        if session.json_queue.full():
            try:
                session.json_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        await session.json_queue.put(raw)

    # --- Extension WebSocket management ---

    async def register_extension(self, websocket: WebSocket) -> ExtensionClient:
        if self._extension is not None:
            try:
                await self._extension.websocket.close(code=1000, reason="Replaced by new connection")
            except Exception:
                pass
        ext = ExtensionClient(
            client_id=uuid.uuid4().hex[:10],
            websocket=websocket,
            connected_at=time.time(),
        )
        self._extension = ext
        self._chrome_state["connected"] = True
        self._chrome_state["updated_at"] = time.time()
        self._broadcast_json({"type": "chrome_state", "chrome": self._chrome_state})
        return ext

    def unregister_extension(self, client_id: str) -> None:
        if self._extension and self._extension.client_id == client_id:
            self._extension = None
            self._chrome_state = {
                "connected": False,
                "extension_id": self._chrome_state.get("extension_id"),
                "studio_mode": False,
                "debugger_enabled": False,
                "tabs": [],
                "active_tab_id": None,
                "meet": {},
                "slides": {},
                "youtube": {},
                "updated_at": time.time(),
            }
            for fut in list(self._pending_commands.values()):
                if not fut.done():
                    fut.set_result({"ok": False, "error": "Chrome extension disconnected"})
            self._pending_commands.clear()
            self._broadcast_json({"type": "chrome_state", "chrome": self._chrome_state})

    async def handle_extension_message(self, ext: ExtensionClient, data: dict[str, Any]) -> None:
        msg_type = data.get("type", "")
        if msg_type == "ping":
            await ext.websocket.send_text(json.dumps({"type": "pong", "ts": time.time()}))
            return

        if msg_type == "hello":
            ext.info = data
            self._chrome_state["connected"] = True
            self._chrome_state["extension_id"] = data.get("extension_id")
            self._chrome_state["studio_mode"] = bool(data.get("studio_mode", False))
            self._chrome_state["debugger_enabled"] = bool(data.get("debugger_enabled", False))
            self._chrome_state["updated_at"] = time.time()
            self._broadcast_json({"type": "chrome_state", "chrome": self._chrome_state})
            return

        if msg_type == "chrome_state":
            state = data.get("state") or {}
            self._chrome_state = {
                "connected": True,
                "extension_id": state.get("extension_id") or self._chrome_state.get("extension_id"),
                "studio_mode": bool(state.get("studio_mode", self._chrome_state.get("studio_mode", False))),
                "debugger_enabled": bool(
                    state.get("debugger_enabled", self._chrome_state.get("debugger_enabled", False))
                ),
                "tabs": state.get("tabs", []),
                "active_tab_id": state.get("active_tab_id"),
                "meet": state.get("meet", {}),
                "slides": state.get("slides", {}),
                "youtube": state.get("youtube", {}),
                "updated_at": time.time(),
            }
            self._broadcast_json({"type": "chrome_state", "chrome": self._chrome_state})
            return

        if msg_type == "command_result":
            req_id = str(data.get("request_id", ""))
            fut = self._pending_commands.pop(req_id, None)
            if fut and not fut.done():
                fut.set_result(
                    {
                        "ok": bool(data.get("ok", True)),
                        "message": data.get("message"),
                        "error": data.get("error"),
                        "data": data.get("data"),
                    }
                )
            return

    async def send_extension_command(
        self, action: str, payload: dict[str, Any], req_id: str
    ) -> dict[str, Any]:
        ext = self._extension
        if ext is None:
            return {"ok": False, "error": "Chrome extension is not connected."}

        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending_commands[req_id] = fut
        try:
            await ext.websocket.send_text(
                json.dumps(
                    {
                        "type": "command",
                        "request_id": req_id,
                        "action": action,
                        "payload": payload,
                    }
                )
            )
            return await asyncio.wait_for(fut, timeout=8.0)
        except asyncio.TimeoutError:
            self._pending_commands.pop(req_id, None)
            return {"ok": False, "error": f"Timed out waiting for Chrome ({action})"}
        except Exception as exc:
            self._pending_commands.pop(req_id, None)
            return {"ok": False, "error": str(exc)}
