#!/usr/bin/env python3
"""Deterministic OpenAI-compatible provider for the OpenCode continuation test."""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


root = Path(sys.argv[1])
fixture = root / "workspace/.claude/worktrees/task/app/fixture.txt"
request_count = 0


def chunk(*, content=None, tool_call=None, finish_reason=None):
    delta = {"role": "assistant"}
    if content is not None:
        delta["content"] = content
    if tool_call is not None:
        delta["tool_calls"] = [
            {
                "index": 0,
                "id": tool_call,
                "type": "function",
                "function": {
                    "name": "read",
                    "arguments": json.dumps({"filePath": str(fixture), "limit": 200}),
                },
            }
        ]
    return {
        "id": "deterministic",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "continuation-contract",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_POST(self):
        global request_count
        request_count += 1
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length))
        messages = body.get("messages", [])
        serialized = json.dumps(messages)
        system = "\n".join(
            json.dumps(message.get("content", ""))
            for message in messages
            if message.get("role") == "system"
        )
        tool_messages = [message for message in messages if message.get("role") == "tool"]
        tool_text = "\n".join(json.dumps(message.get("content", "")) for message in tool_messages)
        has_summary = "COMPACTED_STATE_SENTINEL" in serialized
        is_compaction = (
            not body.get("tools")
            and "You are a context summarization agent" in system
        )
        observation = {
            "request": request_count,
            "tools": bool(body.get("tools")),
            "isCompaction": is_compaction,
            "isTitle": not body.get("tools") and not is_compaction,
            "hasStandingInstructions": "Commit and push at the first working slice" in system,
            "hasSummary": has_summary,
            "hasSyntheticContinuation": "Continue if you have next steps" in serialized,
            "toolMessageCount": len(tool_messages),
            "toolHasLine120": "LINE-120" in tool_text,
            "toolHasLine121": "LINE-121" in tool_text,
            "toolHasLine200": "LINE-200" in tool_text,
            "rootInstructionCount": serialized.count("ROOT_INSTRUCTION_SENTINEL"),
            "hasChildInstructions": "CHILD_INSTRUCTION_SENTINEL" in tool_text,
            "maxTokens": body.get("max_tokens", body.get("max_completion_tokens")),
        }
        with (root / "observations.ndjson").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation, sort_keys=True) + "\n")

        if is_compaction:
            first = chunk(content="COMPACTED_STATE_SENTINEL")
            usage = 100
        elif not body.get("tools"):
            first = chunk(content="continuation contract")
            usage = 100
        elif has_summary and tool_messages:
            first = chunk(content="continuation complete")
            usage = 100
        else:
            first = chunk(tool_call=f"read-{request_count}")
            usage = 3600 if not has_summary and tool_messages else 100

        finish = "tool_calls" if "tool_calls" in first["choices"][0]["delta"] else "stop"
        frames = [
            first,
            chunk(finish_reason=finish),
            {
                "id": "deterministic",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "continuation-contract",
                "choices": [],
                "usage": {
                    "prompt_tokens": usage,
                    "completion_tokens": 10,
                    "total_tokens": usage + 10,
                },
            },
        ]
        payload = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"
        encoded = payload.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
(root / "port").write_text(str(server.server_port), encoding="utf-8")
server.serve_forever()
