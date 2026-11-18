from __future__ import annotations

import io
import math
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    import cyndilib
    from cyndilib.audio_frame import AudioFrameSync
    from cyndilib.finder import Finder
    from cyndilib.receiver import Receiver
    from cyndilib.video_frame import VideoFrameSync
    from cyndilib.wrapper.ndi_recv import RecvBandwidth, RecvColorFormat
    from cyndilib.wrapper.ndi_structs import FourCC

    NDI_AVAILABLE = True
    NDI_IMPORT_ERROR: Optional[str] = None
except Exception as exc:  # pragma: no cover - runtime fallback when NDI missing
    cyndilib = None  # type: ignore
    NDI_AVAILABLE = False
    NDI_IMPORT_ERROR = str(exc)

DEMO_SOURCE_NAME = "Built-in Test Signal (Demo)"


@dataclass
class StreamConfig:
    max_width: int = 960
    fps: int = 24
    quality: int = 75
    bandwidth: str = "highest"  # "highest" | "lowest"


@dataclass
class NDIStatus:
    ndi_available: bool
    ndi_version: str
    ndi_error: Optional[str]
    selected_source: str
    connected: bool
    width: int = 0
    height: int = 0
    actual_fps: float = 0.0
    sample_rate: int = 48000
    channels: int = 2
    sources: list[str] = field(default_factory=list)
    config: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "ndi_available": self.ndi_available,
            "ndi_version": self.ndi_version,
            "ndi_error": self.ndi_error,
            "selected_source": self.selected_source,
            "connected": self.connected,
            "width": self.width,
            "height": self.height,
            "actual_fps": round(self.actual_fps, 1),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "sources": self.sources,
            "config": self.config,
        }


def _uyvy_to_rgb(arr: np.ndarray, xres: int, yres: int, stride: int) -> np.ndarray:
    """Fallback BT.601/709 UYVY 4:2:2 to RGB conversion."""
    row_bytes = stride if stride >= xres * 2 else xres * 2
    rows = arr[: yres * row_bytes].reshape((yres, row_bytes))[:, : xres * 2]
    uyvy = rows.reshape((yres, xres // 2, 4)).astype(np.float32)
    u = uyvy[:, :, 0] - 128.0
    y0 = uyvy[:, :, 1] - 16.0
    v = uyvy[:, :, 2] - 128.0
    y1 = uyvy[:, :, 3] - 16.0

    y = np.empty((yres, xres), dtype=np.float32)
    y[:, 0::2] = y0 * 1.164383
    y[:, 1::2] = y1 * 1.164383

    u_full = np.repeat(u, 2, axis=1)
    v_full = np.repeat(v, 2, axis=1)

    r = y + 1.596027 * v_full
    g = y - 0.391762 * u_full - 0.812968 * v_full
    b = y + 2.017232 * u_full
    rgb = np.stack((r, g, b), axis=-1)
    return np.clip(rgb, 0, 255).astype(np.uint8)


class NDIManager:
    """Manages NDI source discovery and frame capture for web streaming."""

    def __init__(
        self,
        on_video_frame: Callable[[bytes, int, int], None],
        on_audio_frame: Callable[[bytes], None],
        on_sources_changed: Callable[[list[str]], None],
        on_status_changed: Callable[[dict], None],
        default_demo: bool = False,
    ) -> None:
        self._on_video_frame = on_video_frame
        self._on_audio_frame = on_audio_frame
        self._on_sources_changed = on_sources_changed
        self._on_status_changed = on_status_changed

        self._lock = threading.RLock()
        self._finder_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._source_changed_event = threading.Event()

        self._config = StreamConfig()
        self._selected_source: str = DEMO_SOURCE_NAME if default_demo else ""
        self._audio_subscribers = 0
        self._video_subscribers = 0

        self._finder: Optional[Finder] = None
        self._receiver: Optional[Receiver] = None
        self._vfs: Optional[VideoFrameSync] = None
        self._afs: Optional[AudioFrameSync] = None

        self._discovered_sources: list[str] = []
        self._connected = False
        self._src_width = 0
        self._src_height = 0
        self._actual_fps = 0.0
        self._sample_rate = 48000
        self._channels = 2
        self._ndi_runtime_error: Optional[str] = NDI_IMPORT_ERROR
        self._ndi_version = (
            cyndilib.get_ndi_version() if NDI_AVAILABLE and cyndilib else "Unavailable"
        )

        self._finder_thread: Optional[threading.Thread] = None
        self._capture_thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._stop_event.clear()
        self._finder_thread = threading.Thread(
            target=self._finder_loop, name="ndi-finder", daemon=True
        )
        self._capture_thread = threading.Thread(
            target=self._capture_loop, name="ndi-capture", daemon=True
        )
        self._finder_thread.start()
        self._capture_thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._source_changed_event.set()
        if self._capture_thread and self._capture_thread.is_alive():
            self._capture_thread.join(timeout=2.0)
        if self._finder_thread and self._finder_thread.is_alive():
            self._finder_thread.join(timeout=2.0)
        self._close_receiver()
        with self._finder_lock:
            if self._finder is not None:
                try:
                    self._finder.close()
                except Exception:
                    pass
                self._finder = None

    def set_subscriber_counts(self, video_count: int, audio_count: int) -> None:
        with self._lock:
            self._video_subscribers = max(0, video_count)
            self._audio_subscribers = max(0, audio_count)

    def get_sources(self) -> list[str]:
        with self._lock:
            return list(self._discovered_sources) + [DEMO_SOURCE_NAME]

    def get_status(self) -> dict:
        with self._lock:
            status = NDIStatus(
                ndi_available=NDI_AVAILABLE and self._ndi_runtime_error is None,
                ndi_version=self._ndi_version,
                ndi_error=self._ndi_runtime_error,
                selected_source=self._selected_source,
                connected=self._connected,
                width=self._src_width,
                height=self._src_height,
                actual_fps=self._actual_fps,
                sample_rate=self._sample_rate,
                channels=self._channels,
                sources=self.get_sources(),
                config={
                    "max_width": self._config.max_width,
                    "fps": self._config.fps,
                    "quality": self._config.quality,
                    "bandwidth": self._config.bandwidth,
                },
            )
            return status.to_dict()

    def select_source(self, source_name: str) -> dict:
        with self._lock:
            self._selected_source = (source_name or "").strip()
            self._connected = False
            self._src_width = 0
            self._src_height = 0
            self._actual_fps = 0.0
            self._source_changed_event.set()
        status = self.get_status()
        self._on_status_changed(status)
        return status

    def update_config(
        self,
        max_width: Optional[int] = None,
        fps: Optional[int] = None,
        quality: Optional[int] = None,
        bandwidth: Optional[str] = None,
    ) -> dict:
        rebind = False
        with self._lock:
            if max_width is not None:
                self._config.max_width = max(320, min(1920, int(max_width)))
            if fps is not None:
                self._config.fps = max(5, min(60, int(fps)))
            if quality is not None:
                self._config.quality = max(30, min(95, int(quality)))
            if bandwidth in ("highest", "lowest") and bandwidth != self._config.bandwidth:
                self._config.bandwidth = bandwidth
                rebind = True
            if rebind:
                self._source_changed_event.set()
        status = self.get_status()
        self._on_status_changed(status)
        return status

    def refresh_sources(self) -> list[str]:
        with self._finder_lock:
            if self._finder is not None:
                try:
                    self._finder.update_sources()
                    names = sorted(self._finder.get_source_names())
                    with self._lock:
                        self._discovered_sources = names
                except Exception as exc:
                    with self._lock:
                        self._ndi_runtime_error = str(exc)
        sources = self.get_sources()
        self._on_sources_changed(sources)
        return sources

    def _finder_loop(self) -> None:
        if NDI_AVAILABLE:
            with self._finder_lock:
                if self._finder is None and not self._stop_event.is_set():
                    try:
                        self._finder = Finder()
                    except Exception as exc:
                        with self._lock:
                            self._ndi_runtime_error = str(exc)
                        self._finder = None

        last_names: list[str] = []
        while not self._stop_event.is_set():
            names: Optional[list[str]] = None
            with self._finder_lock:
                if self._finder is not None:
                    try:
                        self._finder.update_sources()
                        names = sorted(self._finder.get_source_names())
                    except Exception as exc:
                        with self._lock:
                            self._ndi_runtime_error = str(exc)
            if names is not None and names != last_names:
                last_names = names
                with self._lock:
                    self._discovered_sources = names
                self._on_sources_changed(self.get_sources())
            self._stop_event.wait(1.0)

    def _close_receiver(self) -> None:
        if self._receiver is not None:
            try:
                self._receiver.disconnect()
            except Exception:
                pass
            self._receiver = None
        self._vfs = None
        self._afs = None

    def _open_receiver(self, source_name: str, bandwidth_mode: str) -> bool:
        self._close_receiver()
        if not NDI_AVAILABLE or not source_name:
            return False

        try:
            bw = (
                RecvBandwidth.lowest
                if bandwidth_mode == "lowest"
                else RecvBandwidth.highest
            )
            src_obj = None
            with self._finder_lock:
                if self._finder is not None:
                    self._finder.update_sources()
                    names = self._finder.get_source_names()
                    if source_name in names:
                        src_obj = self._finder.get_source(source_name)

            if src_obj is not None:
                recv = Receiver(
                    source=src_obj,
                    color_format=RecvColorFormat.RGBX_RGBA,
                    bandwidth=bw,
                    allow_video_fields=False,
                    recv_name="NDI Chrome Monitor",
                )
            else:
                recv = Receiver(
                    source_name=source_name,
                    color_format=RecvColorFormat.RGBX_RGBA,
                    bandwidth=bw,
                    allow_video_fields=False,
                    recv_name="NDI Chrome Monitor",
                )

            vfs = VideoFrameSync()
            afs = AudioFrameSync()
            recv.frame_sync.set_video_frame(vfs)
            recv.frame_sync.set_audio_frame(afs)
            if src_obj is not None:
                recv.set_source(src_obj)

            self._receiver = recv
            self._vfs = vfs
            self._afs = afs
            return True
        except Exception as exc:
            with self._lock:
                self._ndi_runtime_error = str(exc)
            self._close_receiver()
            return False

    def _encode_rgb_jpeg(self, rgb: np.ndarray, max_width: int, quality: int) -> tuple[bytes, int, int]:
        h, w = rgb.shape[:2]
        img = Image.fromarray(rgb, mode="RGB")
        if w > max_width:
            target_h = max(2, int(round(h * (max_width / w))))
            img = img.resize((max_width, target_h), Image.Resampling.BILINEAR)
            out_w, out_h = max_width, target_h
        else:
            out_w, out_h = w, h

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=False)
        return buf.getvalue(), out_w, out_h

    def _capture_loop(self) -> None:
        active_source = ""
        active_bandwidth = ""
        last_frame_sig = (-1.0, -1.0)
        last_sent_time = 0.0
        fps_window_start = time.monotonic()
        fps_frames = 0
        demo_phase = 0.0
        last_demo_audio = time.monotonic()

        while not self._stop_event.is_set():
            with self._lock:
                desired_source = self._selected_source
                cfg = StreamConfig(
                    max_width=self._config.max_width,
                    fps=self._config.fps,
                    quality=self._config.quality,
                    bandwidth=self._config.bandwidth,
                )
                has_video_subs = self._video_subscribers > 0
                has_audio_subs = self._audio_subscribers > 0

            frame_interval = 1.0 / max(5, cfg.fps)
            loop_start = time.monotonic()

            if not desired_source:
                if active_source:
                    self._close_receiver()
                    active_source = ""
                    with self._lock:
                        self._connected = False
                    self._on_status_changed(self.get_status())
                self._source_changed_event.wait(0.25)
                self._source_changed_event.clear()
                continue

            if desired_source == DEMO_SOURCE_NAME:
                if active_source != DEMO_SOURCE_NAME:
                    self._close_receiver()
                    active_source = DEMO_SOURCE_NAME
                    active_bandwidth = cfg.bandwidth
                    with self._lock:
                        self._connected = True
                        self._src_width = 1280
                        self._src_height = 720
                        self._sample_rate = 48000
                        self._channels = 2
                    self._on_status_changed(self.get_status())

                if has_video_subs:
                    jpeg, out_w, out_h = self._render_demo_frame(
                        demo_phase, cfg.max_width, cfg.quality
                    )
                    demo_phase += 0.08
                    payload = b"\x01" + jpeg
                    self._on_video_frame(payload, out_w, out_h)
                    fps_frames += 1

                now = time.monotonic()
                if has_audio_subs and (now - last_demo_audio) >= 0.04:
                    dt = min(0.1, now - last_demo_audio)
                    last_demo_audio = now
                    audio_pkt = self._render_demo_audio(now, dt)
                    if audio_pkt:
                        self._on_audio_frame(audio_pkt)
                elif not has_audio_subs:
                    last_demo_audio = now

                if now - fps_window_start >= 1.5:
                    with self._lock:
                        self._actual_fps = fps_frames / max(0.1, now - fps_window_start)
                    fps_frames = 0
                    fps_window_start = now
                    self._on_status_changed(self.get_status())

                elapsed = time.monotonic() - loop_start
                time.sleep(max(0.005, frame_interval - elapsed))
                continue

            # Real NDI source
            if (
                desired_source != active_source
                or cfg.bandwidth != active_bandwidth
                or self._receiver is None
            ):
                opened = self._open_receiver(desired_source, cfg.bandwidth)
                active_source = desired_source
                active_bandwidth = cfg.bandwidth
                last_frame_sig = (-1.0, -1.0)
                self._source_changed_event.clear()
                with self._lock:
                    self._connected = False
                self._on_status_changed(self.get_status())
                if not opened:
                    time.sleep(0.75)
                    continue

            recv = self._receiver
            vfs = self._vfs
            afs = self._afs
            if recv is None or vfs is None or afs is None:
                time.sleep(0.25)
                continue

            try:
                is_conn = bool(recv.is_connected())
                recv.frame_sync.capture_video()
                xres, yres = vfs.get_resolution()

                if xres > 0 and yres > 0:
                    now = time.monotonic()
                    ts = vfs.get_timestamp_posix()
                    tc = vfs.get_timecode_posix()
                    sig = (ts, tc)

                    changed_size = (xres != self._src_width or yres != self._src_height)
                    if not self._connected or changed_size:
                        with self._lock:
                            self._connected = True
                            self._src_width = xres
                            self._src_height = yres
                        self._on_status_changed(self.get_status())

                    should_send = has_video_subs and (
                        sig != last_frame_sig or (now - last_sent_time) >= 0.35
                    )
                    if should_send:
                        arr = vfs.get_array()
                        fourcc = vfs.get_fourcc()
                        stride = vfs.get_line_stride()
                        if stride <= 0:
                            stride = xres * 4

                        rgb: Optional[np.ndarray] = None
                        if fourcc in (FourCC.RGBA, FourCC.RGBX, FourCC.BGRA, FourCC.BGRX):
                            needed = yres * stride
                            if arr.size >= needed:
                                rows = arr[:needed].reshape((yres, stride))
                                rgba = rows[:, : xres * 4].reshape((yres, xres, 4))
                                if fourcc in (FourCC.BGRA, FourCC.BGRX):
                                    rgb = rgba[:, :, [2, 1, 0]]
                                else:
                                    rgb = rgba[:, :, :3]
                        elif fourcc in (FourCC.UYVY, FourCC.UYVA):
                            rgb = _uyvy_to_rgb(arr, xres, yres, stride)

                        if rgb is not None:
                            jpeg, out_w, out_h = self._encode_rgb_jpeg(
                                rgb, cfg.max_width, cfg.quality
                            )
                            self._on_video_frame(b"\x01" + jpeg, out_w, out_h)
                            last_frame_sig = sig
                            last_sent_time = now
                            fps_frames += 1

                    # Drain NDI audio frame buffer to keep FrameSync healthy
                    n_samples = recv.frame_sync.capture_available_audio()
                    if n_samples > 0 and has_audio_subs:
                        audio_arr = afs.get_array()
                        sr = int(afs.sample_rate or 48000)
                        ch = int(afs.num_channels or 0)
                        if ch >= 1 and audio_arr.size > 0:
                            if ch == 1:
                                stereo = np.vstack((audio_arr[0], audio_arr[0]))
                            else:
                                stereo = audio_arr[:2, :]
                            interleaved = np.clip(stereo.T, -1.0, 1.0) * 32767.0
                            pcm_bytes = interleaved.astype("<i2").tobytes()
                            pkt = struct.pack("<BBHI", 2, 2, 0, sr) + pcm_bytes
                            self._on_audio_frame(pkt)
                            if sr != self._sample_rate:
                                with self._lock:
                                    self._sample_rate = sr

                    if now - fps_window_start >= 1.5:
                        with self._lock:
                            self._actual_fps = fps_frames / max(0.1, now - fps_window_start)
                        fps_frames = 0
                        fps_window_start = now
                        self._on_status_changed(self.get_status())
                else:
                    if self._connected and not is_conn:
                        with self._lock:
                            self._connected = False
                            self._actual_fps = 0.0
                        self._on_status_changed(self.get_status())
            except Exception as exc:
                with self._lock:
                    self._ndi_runtime_error = str(exc)
                    self._connected = False
                self._on_status_changed(self.get_status())
                time.sleep(0.5)

            elapsed = time.monotonic() - loop_start
            time.sleep(max(0.002, frame_interval - elapsed))

    def _render_demo_frame(
        self, phase: float, max_width: int, quality: int
    ) -> tuple[bytes, int, int]:
        w, h = 1280, 720
        img = Image.new("RGB", (w, h), (16, 18, 22))
        draw = ImageDraw.Draw(img)

        # Classic broadcast color bars in upper 62%
        bars = [
            (204, 204, 204),
            (204, 204, 0),
            (0, 204, 204),
            (0, 204, 0),
            (204, 0, 204),
            (204, 0, 0),
            (0, 0, 204),
        ]
        bar_w = w // len(bars)
        bar_h = int(h * 0.62)
        for i, color in enumerate(bars):
            x0 = i * bar_w
            x1 = w if i == len(bars) - 1 else (i + 1) * bar_w
            draw.rectangle([x0, 0, x1, bar_h], fill=color)

        # Lower technical slate
        draw.rectangle([0, bar_h, w, h], fill=(15, 18, 24))
        draw.rectangle([0, bar_h, w, bar_h + 6], fill=(24, 160, 120))

        # Moving confidence sweep bar so user visually sees live 24fps motion
        sweep_x = int(((math.sin(phase) + 1.0) * 0.5) * (w - 180)) + 40
        draw.rectangle([sweep_x, bar_h + 28, sweep_x + 100, bar_h + 44], fill=(56, 189, 248))

        ts_str = time.strftime("%H:%M:%S")
        ms = int((time.time() % 1.0) * 1000)
        font = ImageFont.load_default()
        draw.text((48, bar_h + 72), "NDI MONITOR  |  BUILT-IN TEST SIGNAL", fill=(235, 240, 245), font=font)
        draw.text(
            (48, bar_h + 104),
            f"TIME {ts_str}.{ms:03d}   1280x720 @ {self._config.fps}fps   SELECT AN NDI SOURCE ABOVE",
            fill=(150, 165, 185),
            font=font,
        )

        # Subtle center crosshair
        cx, cy = w // 2, bar_h // 2
        draw.line([(cx - 24, cy), (cx + 24, cy)], fill=(255, 255, 255), width=2)
        draw.line([(cx, cy - 24), (cx, cy + 24)], fill=(255, 255, 255), width=2)

        if w > max_width:
            th = max(2, int(round(h * (max_width / w))))
            img = img.resize((max_width, th), Image.Resampling.BILINEAR)
            out_w, out_h = max_width, th
        else:
            out_w, out_h = w, h

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return buf.getvalue(), out_w, out_h

    def _render_demo_audio(self, now: float, dt: float) -> bytes:
        sr = 48000
        n = max(256, min(4800, int(sr * dt)))
        # Gentle 440Hz beep for 120ms every 2.0 seconds so user can verify audio without annoyance
        cycle = now % 2.0
        if cycle < 0.12:
            t = (np.arange(n, dtype=np.float32) / sr) + cycle
            env = np.sin(np.pi * np.clip((t - cycle) / max(0.001, dt), 0, 1))
            tone = 0.12 * np.sin(2.0 * np.pi * 440.0 * t) * (0.6 + 0.4 * env)
            stereo = np.stack((tone, tone), axis=1)
        else:
            stereo = np.zeros((n, 2), dtype=np.float32)

        pcm = (np.clip(stereo, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        return struct.pack("<BBHI", 2, 2, 0, sr) + pcm
