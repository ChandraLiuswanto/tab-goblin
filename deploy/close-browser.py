#!/usr/bin/env python3
"""Request and confirm a graceful Chromium shutdown over private CDP."""
import base64
import json
import os
import socket
import struct
import sys
from urllib.parse import urlparse
from urllib.request import urlopen


def recv_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise OSError("WebSocket closed before a complete frame arrived")
        data.extend(chunk)
    return bytes(data)


def send_frame(sock: socket.socket, opcode: int, payload: bytes) -> None:
    if len(payload) >= 126:
        raise ValueError("unexpectedly large CDP control message")
    mask = os.urandom(4)
    frame = bytearray([0x80 | opcode, 0x80 | len(payload)]) + bytearray(mask)
    frame.extend(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    sock.sendall(frame)


def recv_message(sock: socket.socket) -> bytes | None:
    """Return one complete text message while answering control frames."""
    fragments = bytearray()
    text_message = False
    while True:
        first, second = recv_exact(sock, 2)
        final = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", recv_exact(sock, 8))[0]
        mask = recv_exact(sock, 4) if masked else b""
        payload = bytearray(recv_exact(sock, length))
        if masked:
            for index in range(len(payload)):
                payload[index] ^= mask[index % 4]

        if opcode == 0x8:
            return None
        if opcode == 0x9:
            send_frame(sock, 0xA, bytes(payload))
            continue
        if opcode == 0xA:
            continue
        if opcode == 0x1:
            if fragments:
                raise ValueError("new text message interrupted a fragmented message")
            text_message = True
        elif opcode == 0x0:
            if not fragments:
                raise ValueError("unexpected WebSocket continuation frame")
        else:
            raise ValueError(f"unexpected WebSocket opcode {opcode}")
        fragments.extend(payload)
        if final:
            if not text_message:
                raise ValueError("CDP sent a non-text message")
            return bytes(fragments)


def main() -> int:
    try:
        with urlopen("http://127.0.0.1:9223/json/version", timeout=2) as response:
            endpoint = json.load(response)["webSocketDebuggerUrl"]
        parsed = urlparse(endpoint)
        sock = socket.create_connection((parsed.hostname, parsed.port), timeout=2)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {parsed.path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Origin: http://127.0.0.1\r\n\r\n"
        )
        sock.sendall(request.encode("ascii"))
        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                return 1
            response.extend(chunk)
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            return 1

        send_frame(sock, 0x1, json.dumps({"id": 1, "method": "Browser.close"}).encode())
        sock.settimeout(5)
        while message := recv_message(sock):
            reply = json.loads(message)
            if reply.get("id") != 1:
                continue
            sock.close()
            return 0 if "result" in reply and "error" not in reply else 1
        return 1
    except (KeyError, OSError, ValueError, json.JSONDecodeError, struct.error):
        return 1


if __name__ == "__main__":
    sys.exit(main())
