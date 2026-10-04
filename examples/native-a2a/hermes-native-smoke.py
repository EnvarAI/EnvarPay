"""Invoke the installed native Hermes tool against a disposable no-payment fixture.

No model invocation and no live configuration change. HERMES_HOME must be a
new disposable directory so native audit/history stays separate.
"""
import json
import os
from pathlib import Path
from plugins.platforms.a2a import tools

base = os.environ["ENVAR_PROXY_ORIGIN"]
token = Path(os.environ["ENVAR_PROXY_TOKEN_FILE"]).read_text().strip()
tools._configured_peers = lambda: {
    "approved_research": {
        "url": base,
        "auth": {"type": "bearer", "token": token},
        "timeout": 30,
    }
}
message = json.dumps({"requestId": "native-hermes-smoke", "input": {"request": "Native outbound fixture"}})
first = tools.a2a_call({"agent": "approved_research", "message": message})
second = tools.a2a_call({"agent": "approved_research", "message": message})
if "simulated native tool result" not in first or "simulated native tool result" not in second:
    raise RuntimeError("Native Hermes A2A tool did not retrieve the fixture result")
print(json.dumps({"runtime": "hermes", "entry": "a2a_call", "resultMatched": True,
                  "invocations": 2, "sameIntendedRequest": True,
                  "modelInvoked": False, "realPayment": False}))
