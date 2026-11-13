"""ANSI dashboard inspired by axtest's console, without extra dependencies."""

import os
import re
import shutil
import sys
import threading
import time
import unicodedata


ESC = "\033["
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
LOGO = (
    "████████╗ █████╗ ██████╗ ███████╗",
    "╚══██╔══╝██╔══██╗██╔══██╗██╔════╝",
    "   ██║   ███████║██████╔╝███████╗",
    "   ██║   ██╔══██║██╔══██╗╚════██║",
    "   ██║   ██║  ██║██║  ██║███████║",
    "   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝",
)
GRADIENT = (51, 45, 39, 33, 63, 99, 135, 171, 207)
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def clean(text):
    return "".join(char for char in ANSI.sub("", str(text)) if char.isprintable() or char == "\n")


def cells(text):
    return sum(0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in "WF" else 1 for char in text)


def styled(parts, width, color=True):
    result, used = [], 0
    for text, code in parts:
        chunk = []
        truncated = False
        for char in clean(text).replace("\n", " "):
            size = cells(char)
            if used + size > width:
                truncated = True
                break
            used += size
            chunk.append(char)
        value = "".join(chunk)
        result.append(f"{ESC}{code}m{value}{ESC}0m" if code and color and value else value)
        if truncated or used >= width:
            break
    return "".join(result)


class Console:
    def __init__(self, collect):
        self.collect = collect
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.snapshot = {"services": [], "logs": [], "network": "확인 중"}
        self.notice = "번호 또는 /명령 입력 후 Enter · /help 도움말 · q 콘솔 닫기"
        self.notice_error = False
        self.pending = ""
        self.page = "dashboard"
        self.log_target = "all"
        self.busy = False
        self.phase = "WORKING"
        self.snapshot_error = False
        self.operation = None
        self.operation_started = 0
        self.started = time.monotonic()
        self.color = "NO_COLOR" not in os.environ
        self.previous = []
        self.size = None

    def __enter__(self):
        sys.stdout.write(ESC + "?1049h" + ESC + "?25l")
        sys.stdout.flush()
        self.poller = threading.Thread(target=self._poll, name="tars-status", daemon=True)
        self.poller.start()
        return self

    def __exit__(self, *args):
        try:
            if self.operation and self.operation.is_alive():
                self.message("진행 중인 서버 제어 작업을 마무리하고 있습니다.")
                while self.operation.is_alive():
                    try:
                        self.draw()
                        self.operation.join(timeout=0.1)
                    except KeyboardInterrupt:
                        continue
        finally:
            self.stop_event.set()
            self.poller.join(timeout=2)
            sys.stdout.write(ESC + "0m" + ESC + "?25h" + ESC + "?1049l")
            sys.stdout.flush()

    def message(self, text, error=False):
        with self.lock:
            self.notice, self.notice_error = clean(text), error

    def refresh(self):
        # Serialize polling and the final operation check so older results cannot
        # overwrite the service state collected after a stop/build/start.
        with self.refresh_lock:
            try:
                result = self.collect()
                with self.lock:
                    self.snapshot = result
                    self.snapshot_error = False
            except Exception as error:
                with self.lock:
                    self.snapshot_error = True
                self.message(f"상태 조회 오류: {error}", error=True)

    def _poll(self):
        while not self.stop_event.is_set():
            self.refresh()
            self.stop_event.wait(2)

    def set_phase(self, phase):
        with self.lock:
            self.phase = phase

    def perform(self, title, action):
        if self.busy:
            self.message("진행 중인 서버 제어 작업이 끝난 뒤 다시 입력하세요.")
            return
        self.busy = True
        self.phase = "WORKING"
        self.operation_started = time.monotonic()
        self.message(title)

        def work():
            try:
                message = action()
                self.message(message or "작업을 마쳤습니다.")
            except Exception as error:
                self.message(str(error), error=True)
            finally:
                self.refresh()
                with self.lock:
                    self.busy = False

        self.operation = threading.Thread(target=work, name="tars-command", daemon=True)
        self.operation.start()

    def _lines(self, columns, rows):
        width = max(1, columns - 1)
        body = []

        def line(*parts):
            body.append(styled(parts, width, self.color))

        def rule(label=""):
            prefix = "  ── " + (label + " " if label else "")
            line((prefix + "─" * max(0, width - cells(prefix) - 2), "38;5;239"))

        if self.page == "dashboard" and rows >= 24 and columns >= 54:
            for row in LOGO:
                parts = [("  ", "")]
                for char in row:
                    code = "1;38;5;114" if char == "█" else "38;5;65"
                    parts.append((char, code))
                line(*parts)
            line(("", ""))
        line(("  Tars", "1;38;5;51"), ("  /  AI TEAM CONTROL", "1;38;5;255"), ("   " + time.strftime("%H:%M:%S"), "38;5;244"))
        if rows >= 22:
            line(("  부서와 AI 세션을 위한 서버 콘솔", "38;5;244"), ("  ·  0.0.0.0", "38;5;81"))
            rule()
            for service in reversed(self.snapshot["services"]):
                label = "WEB" if service["name"] == "frontend" else "API"
                line((f"  {label:<5}", "1;38;5;213"), (service["network_url"], "1;38;5;51"))
        rule("SERVICES")
        services = self.snapshot["services"]
        if not services:
            line(("  서버 상태를 불러오는 중…", "38;5;244"))
        for service in services:
            running = bool(service["pids"])
            color = "38;5;114" if running else "38;5;203" if service["label"] == "EXITED" else "38;5;244"
            name = "Frontend" if service["name"] == "frontend" else "Backend"
            line((f"  {name:<11}", "1;38;5;255"), (f"● {service['label']:<15}", color),
                 (f"  {service['uptime']}", "38;5;244"))
            http = service["http"]
            code = "38;5;114" if http.startswith("HTTP 2") else "38;5;179" if running else "38;5;244"
            line((f"    {service['listen']}  │  PID {service['pid']}  │  ", "38;5;245"), (http, code))
            if rows >= 30:
                line(("", ""))
        footer_count = 5
        if self.page == "help":
            rule("COMMANDS")
            for command, help_text in (
                ("/start [backend|frontend]", "전체 또는 개별 서버 시작"),
                ("/stop [backend|frontend]", "전체 또는 개별 서버 중지"),
                ("/restart [backend|frontend]", "중지 → 리빌드 → 시작"),
                ("/rebuild [backend|frontend]", "빌드 실행 · build 스크립트 없으면 생략"),
                ("/logs [backend|frontend]", "최근 서버 로그 펼치기"),
                ("/status", "기본 상태 화면으로 돌아가기"),
                ("q / /quit", "콘솔 닫기 · 실행 중 서버는 유지"),
            ):
                line((f"  {command:<29}", "38;5;81"), (help_text, "38;5;248"))
        else:
            log_rows = max(0, rows - len(body) - footer_count - 1)
            rule("RECENT LOGS" + (f" · {self.log_target}" if self.page == "logs" else ""))
            records = [entry for entry in self.snapshot["logs"] if self.page != "logs" or self.log_target == "all" or entry["service"] == self.log_target]
            count = min(log_rows, 25 if self.page == "logs" else 6)
            if count and (self.page != "logs" or self.log_target == "all"):
                groups = [[entry for entry in records if entry["service"] == name] for name in ("backend", "frontend")]
                groups = [group for group in groups if group]
                selected = []
                for index, group in enumerate(groups):
                    quota = count // len(groups) + (1 if index < count % len(groups) else 0)
                    if quota:
                        selected.extend(group[-quota:])
                records = selected
            if records and count:
                for record in records[-count:]:
                    line(("  " + record["tag"] + " ", "38;5;81" if record["service"] == "frontend" else "38;5;141"),
                         (record["text"], "38;5;203" if record["error"] else "38;5;247"))
            elif log_rows:
                line(("  아직 기록된 로그가 없습니다. /start 로 서버를 시작하세요.", "38;5;244"))
        body = body[:max(0, rows - footer_count)]
        body += [""] * max(0, rows - footer_count - len(body))
        elapsed = int(time.monotonic() - self.started)
        tick = int(time.monotonic() * 10)
        active = sum(bool(service["pids"]) for service in services)
        ready = sum(bool(service["pids"]) and service["http"].startswith("HTTP 2") for service in services)
        pulse = SPINNER[tick % len(SPINNER)]
        if self.busy:
            status_parts = [(f"  ● {self.phase}  ·  {int(time.monotonic() - self.operation_started)}s", "38;5;179")]
        else:
            if self.snapshot_error or not services:
                status, code = "● UNKNOWN", "38;5;244"
            elif ready == len(services):
                status, code = f"{pulse} LIVE", f"1;38;5;{GRADIENT[tick % len(GRADIENT)]}"
            elif ready:
                status, code = "● PARTIAL", "38;5;179"
            elif active:
                status, code = "● NOT READY", "38;5;179"
            elif any(service["label"] == "EXITED" for service in services):
                status, code = "● EXITED", "38;5;203"
            else:
                status, code = "● STOPPED", "38;5;244"
            status_parts = [
                (f"  {status}", code),
                (f"  ·  준비 {ready}/{len(services)}  ·  프로세스 {active}  ·  콘솔 {elapsed // 60:02}:{elapsed % 60:02}  ·  상태 조회 2s", "38;5;244"),
            ]
        notice_symbol = "✘ " if self.notice_error else "› "
        capacity = max(0, width - 10)
        pending = self.pending[-capacity:] if capacity else ""
        prompt = "  Tars ❯ " + pending
        footer = [
            styled([("  " + "─" * max(0, width - 4), "38;5;239")], width, self.color),
            styled([("  1 시작   2 중지   3 재시작   4 로그   5 상태   6 리빌드   /help   q 닫기", "38;5;245")], width, self.color),
            styled([("  " + notice_symbol + self.notice, "38;5;203" if self.notice_error else "38;5;179")], width, self.color),
            styled(status_parts, width, self.color),
            styled([("  Tars ❯ ", "1;38;5;51"), (pending, "38;5;255")], width, self.color),
        ]
        lines = (body + footer)[-rows:]
        return lines, min(columns, cells(prompt) + 1)

    def draw(self):
        with self.lock:
            size = shutil.get_terminal_size((100, 30))
            columns, rows = max(1, size.columns), max(1, size.lines)
            lines, cursor_column = self._lines(columns, rows)
            output = [ESC + "?25l"]
            if size != self.size:
                output.append(ESC + "2J" + ESC + "H")
                self.previous = []
                self.size = size
            for index, line in enumerate(lines):
                if index >= len(self.previous) or self.previous[index] != line:
                    output.append(f"{ESC}{index + 1};1H{ESC}2K{line}")
            output.append(f"{ESC}{rows};{cursor_column}H{ESC}?25h")
            self.previous = lines
            sys.stdout.write("".join(output))
            sys.stdout.flush()
