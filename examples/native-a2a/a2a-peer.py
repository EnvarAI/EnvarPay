#!/usr/bin/env python3
"""Bounded standard A2A client; its profile contains only a restricted proxy token.

No wallet key, private buyer-management endpoint or approval operation exists here.
"""
import argparse
import json
from pathlib import Path
import urllib.request
from urllib.parse import urlsplit
import uuid

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("A2A redirects are not permitted")

parser = argparse.ArgumentParser()
parser.add_argument("--profile", required=True)
parser.add_argument("action", choices=["send", "status", "continue"])
parser.add_argument("--request-id")
parser.add_argument("--task-id")
parser.add_argument("--input-file")
args = parser.parse_args()
profile = json.loads(Path(args.profile).read_text())
origin = profile["origin"].rstrip("/")
parsed = urlsplit(origin)
if parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment or parsed.username:
    raise SystemExit("Profile must contain an exact HTTP(S) proxy origin")
token = Path(profile["tokenFile"]).read_text().strip()
if not 32 <= len(token) <= 4096 or any(c.isspace() for c in token):
    raise SystemExit("Invalid restricted proxy token file")
if args.action == "status":
    if not args.task_id:
        parser.error("--task-id is required")
    method, params = "GetTask", {"id": args.task_id}
else:
    if not args.request_id or not args.input_file or args.action == "continue" and not args.task_id:
        parser.error("send/continue requires stable --request-id and --input-file; continue also requires --task-id")
    path = Path(args.input_file)
    if path.stat().st_size > 524288:
        raise SystemExit("Input exceeds 512 KiB")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise SystemExit("Input must be a JSON object")
    message = {"messageId": str(uuid.uuid4()), "role": "ROLE_USER", "parts": [{"data": {"requestId": args.request_id, "input": value}}]}
    if args.action == "continue":
        message["taskId"] = args.task_id
    method, params = "SendMessage", {"message": message, "configuration": {"returnImmediately": True}}
body = json.dumps({"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params}).encode()
request = urllib.request.Request(origin + "/a2a", data=body, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "A2A-Version": "1.0"})
with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
    data = response.read(1048577)
    if len(data) > 1048576:
        raise SystemExit("Result exceeds 1 MiB; owner should inspect the original purchase")
print(json.dumps(json.loads(data), ensure_ascii=False))
