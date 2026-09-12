#!/usr/bin/env python3
"""Regression tests for the private-CDP Browser.close helper."""
import json
import os
import socket
import subprocess
import sys
import threading
import unittest
from pathlib import Path

HELPER = Path(__file__).with_name("close-browser.py")
HOST = "127.0.0.1"
PORT = 9223


class FakeCdpPeer:
    def __init__(self, partial_handshake: bool):
        self.partial_handshake = partial_handshake
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind((HOST, PORT))
        self.listener.listen(2)
        self.error = None
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.listener.close()
        self.thread.join(timeout=2)
        if self.error:
            raise self.error

    def _serve(self):
        try:
            version, _ = self.listener.accept()
            with version:
                version.recv(4096)
                body = json.dumps(
                    {"webSocketDebuggerUrl": f"ws://{HOST}:{PORT}/devtools/browser/fake"}
                ).encode()
                version.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                    + body
                )

            websocket, _ = self.listener.accept()
            with websocket:
                websocket.recv(4096)
                if self.partial_handshake:
                    websocket.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n")
                    return
                websocket.sendall(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                    b"Connection: Upgrade\r\n\r\n"
                )
                websocket.recv(4096)
                reply = json.dumps({"id": 1, "result": {}}).encode()
                websocket.sendall(bytes([0x81, len(reply)]) + reply)
        except OSError as error:
            self.error = error


class CloseBrowserTests(unittest.TestCase):
    def run_helper(self, partial_handshake: bool) -> subprocess.CompletedProcess[str]:
        with FakeCdpPeer(partial_handshake):
            return subprocess.run(
                [sys.executable, str(HELPER)],
                text=True,
                capture_output=True,
                timeout=2,
                check=False,
            )

    def test_partial_handshake_eof_fails_without_spinning(self):
        result = self.run_helper(partial_handshake=True)
        self.assertEqual(result.returncode, 1)

    def test_matching_cdp_success_reply_succeeds(self):
        result = self.run_helper(partial_handshake=False)
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
