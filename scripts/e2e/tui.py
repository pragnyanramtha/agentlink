#!/usr/bin/env python3
"""Drive interactive agent TUIs like a user would (a tmux stand-in for E2E tests).

  tui.py start <name> [--cwd DIR] [--rows N] [--cols N] -- <command...>
  tui.py type  <name> <text>            # types text (no Enter)
  tui.py key   <name> <enter|esc|tab|up|down|left|right|ctrl-c|ctrl-d|backspace>...
  tui.py say   <name> <text>            # types text, then Enter
  tui.py screen <name> [--tail N]       # rendered screen (needs pyte) or raw tail
  tui.py wait  <name> <regex> [--timeout S]
  tui.py pid   <name>
  tui.py stop  <name>

Each session runs under a small supervisor process that owns the PTY, appends output to
$TUI_STATE/<name>.log and serves commands on $TUI_STATE/<name>.sock.
"""
import json
import os
import pty
import re
import select
import signal
import socket
import sys
import time

STATE = os.environ.get("TUI_STATE", "/tmp/agentlink-tui")
KEYS = {
    "enter": b"\r", "esc": b"\x1b", "tab": b"\t", "backspace": b"\x7f",
    "up": b"\x1b[A", "down": b"\x1b[B", "right": b"\x1b[C", "left": b"\x1b[D",
    "ctrl-c": b"\x03", "ctrl-d": b"\x04", "ctrl-j": b"\n", "space": b" ",
}

try:
    import pyte  # type: ignore
except ImportError:  # pragma: no cover
    pyte = None


class StringSeqFilter:
    """Drops OSC/DCS/APC/PM/SOS strings (kitty graphics, capability probes) that pyte renders as
    garbage. Keeps state across reads because sequences can span chunks."""

    STARTS = {ord("]"), ord("P"), ord("_"), ord("^"), ord("X")}

    def __init__(self):
        self.state = 0  # 0 normal, 1 saw ESC, 2 in string, 3 in string saw ESC

    def feed(self, data: bytes) -> bytes:
        out = bytearray()
        for b in data:
            if self.state == 0:
                if b == 0x1B:
                    self.state = 1
                else:
                    out.append(b)
            elif self.state == 1:
                if b in self.STARTS:
                    self.state = 2
                else:
                    out += bytes([0x1B, b])
                    self.state = 0
            elif self.state == 2:
                if b == 0x07:
                    self.state = 0
                elif b == 0x1B:
                    self.state = 3
            elif self.state == 3:
                self.state = 0 if b == ord("\\") else 2
        return bytes(out)


def paths(name):
    os.makedirs(STATE, exist_ok=True)
    base = os.path.join(STATE, name)
    return base + ".sock", base + ".log", base + ".pid"


def supervise(name, cwd, rows, cols, argv):
    sock_path, log_path, pid_path = paths(name)
    for p in (sock_path,):
        if os.path.exists(p):
            os.unlink(p)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.environ["TERM"] = os.environ.get("TERM_OVERRIDE", "xterm-256color")
        os.environ["COLUMNS"], os.environ["LINES"] = str(cols), str(rows)
        os.execvp(argv[0], argv)
    import fcntl, struct, termios  # noqa: E401

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    with open(pid_path, "w") as f:
        f.write(str(pid))
    screen = stream = None
    strings = StringSeqFilter()
    if pyte:
        screen = pyte.Screen(cols, rows)
        stream = pyte.ByteStream(screen)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(8)
    log = open(log_path, "ab", buffering=0)
    alive = True
    while alive:
        r, _, _ = select.select([fd, server], [], [], 0.5)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                alive = False
            else:
                log.write(data)
                if stream:
                    stream.feed(strings.feed(data))
                # answer terminal queries that TUIs block on (cursor position, device attributes)
                if b"\x1b[6n" in data:
                    y, x = (screen.cursor.y + 1, screen.cursor.x + 1) if screen else (1, 1)
                    os.write(fd, f"\x1b[{y};{x}R".encode())
                if b"\x1b[c" in data or b"\x1b[0c" in data:
                    os.write(fd, b"\x1b[?62;22c")
        if server in r:
            conn, _ = server.accept()
            with conn:
                req = json.loads(conn.recv(1 << 20).decode() or "{}")
                op = req.get("op")
                if op == "write":
                    os.write(fd, req["data"].encode("latin-1"))
                    conn.sendall(b'{"ok":true}')
                elif op == "screen":
                    text = "\n".join(screen.display).rstrip() if screen else ""
                    conn.sendall(json.dumps({"screen": text}).encode())
                elif op == "stop":
                    os.kill(pid, signal.SIGTERM)
                    conn.sendall(b'{"ok":true}')
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                alive = False
        except ChildProcessError:
            alive = False
    for p in (sock_path, pid_path):
        if os.path.exists(p):
            os.unlink(p)


def request(name, payload):
    sock_path, _, _ = paths(name)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(sock_path)
    s.sendall(json.dumps(payload).encode())
    s.shutdown(socket.SHUT_WR)
    chunks = []
    while True:
        b = s.recv(1 << 20)
        if not b:
            break
        chunks.append(b)
    return json.loads(b"".join(chunks).decode() or "{}")


def raw_tail(name, n):
    _, log_path, _ = paths(name)
    with open(log_path, "rb") as f:
        text = f.read().decode("utf-8", "replace")
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r", "", text)
    return "\n".join(text.splitlines()[-n:])


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    cmd, name, rest = args[0], args[1], args[2:]
    if cmd == "start":
        cwd, rows, cols = os.getcwd(), 50, 160
        while rest and rest[0] != "--":
            flag, value = rest[0], rest[1]
            rest = rest[2:]
            if flag == "--cwd":
                cwd = value
            elif flag == "--rows":
                rows = int(value)
            elif flag == "--cols":
                cols = int(value)
        argv = rest[1:]
        if os.fork() == 0:
            os.setsid()
            if os.fork() == 0:
                devnull = os.open(os.devnull, os.O_RDWR)
                for fd in (0, 1, 2):
                    os.dup2(devnull, fd)
                supervise(name, cwd, rows, cols, argv)
            os._exit(0)
        sock_path, _, _ = paths(name)
        for _ in range(100):
            if os.path.exists(sock_path):
                break
            time.sleep(0.05)
        print(open(paths(name)[2]).read() if os.path.exists(paths(name)[2]) else "?")
        return 0
    if cmd == "type":
        request(name, {"op": "write", "data": " ".join(rest)})
    elif cmd == "say":
        text = " ".join(rest)
        request(name, {"op": "write", "data": text})
        time.sleep(0.3)
        request(name, {"op": "write", "data": "\r"})
    elif cmd == "key":
        for k in rest:
            request(name, {"op": "write", "data": KEYS[k].decode("latin-1")})
            time.sleep(0.15)
    elif cmd == "screen":
        tail = int(rest[1]) if len(rest) > 1 and rest[0] == "--tail" else 60
        out = request(name, {"op": "screen"}).get("screen") if pyte else ""
        print(out if out else raw_tail(name, tail))
    elif cmd == "wait":
        pattern, timeout = re.compile(rest[0]), 60.0
        if len(rest) > 2 and rest[1] == "--timeout":
            timeout = float(rest[2])
        deadline = time.time() + timeout
        while time.time() < deadline:
            screen = request(name, {"op": "screen"}).get("screen") if pyte else raw_tail(name, 200)
            if pattern.search(screen or "") or pattern.search(raw_tail(name, 400)):
                print("matched")
                return 0
            time.sleep(0.5)
        print("timeout")
        return 1
    elif cmd == "pid":
        print(open(paths(name)[2]).read())
    elif cmd == "stop":
        try:
            request(name, {"op": "stop"})
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
