"""Offline connector contract tests. These do NOT prove a framework run or payment."""

import json
from types import SimpleNamespace

import httpx
import pytest

from envarpay.runtime_http import RuntimeHTTP, terminal_text
from envarpay.storage import PaymentError


def completed(text="delivered"):
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
    }


@pytest.fixture
def runtime(monkeypatch):
    monkeypatch.setenv("ENVARPAY_TEST_RUNTIME_TOKEN", "test-operator-token")
    config = SimpleNamespace(
        base_url="http://127.0.0.1:8642/v1",
        model="hermes-agent",
        http_api="responses",
        api_key_file=None,
        api_key_env="ENVARPAY_TEST_RUNTIME_TOKEN",
        max_response_bytes=10000,
    )
    return RuntimeHTTP(config, 5)


async def test_one_fixed_request_and_only_final_text(runtime, respx_mock):
    route = respx_mock.post("http://127.0.0.1:8642/v1/responses").respond(json=completed())
    result = await runtime.call("do task")
    request = route.calls[0].request
    assert json.loads(request.content) == {
        "model": "hermes-agent",
        "input": "do task",
        "stream": False,
    }
    assert request.headers["authorization"] == "Bearer test-operator-token"
    assert "x-openclaw-session-key" not in request.headers
    assert "x-openclaw-model" not in request.headers
    assert result.content[0].text == "delivered" and route.call_count == 1


@pytest.mark.parametrize("status", [202, 301, 302, 401, 429, 500])
async def test_no_retries_or_redirects(runtime, respx_mock, status):
    route = respx_mock.post("http://127.0.0.1:8642/v1/responses").respond(
        status, headers={"location": "https://elsewhere.invalid"}, text="private server detail"
    )
    with pytest.raises(PaymentError) as error:
        await runtime.call("do task")
    assert "private server detail" not in str(error.value)
    assert route.call_count == 1


async def test_timeout_no_retry_or_credential_leak(runtime, respx_mock):
    route = respx_mock.post("http://127.0.0.1:8642/v1/responses").mock(
        side_effect=httpx.ReadTimeout("test-operator-token")
    )
    with pytest.raises(PaymentError, match="unresolved") as error:
        await runtime.call("task")
    assert "test-operator-token" not in str(error.value) and route.call_count == 1


async def test_missing_credential_makes_no_request(runtime, monkeypatch, respx_mock):
    monkeypatch.delenv("ENVARPAY_TEST_RUNTIME_TOKEN")
    with pytest.raises(PaymentError, match="credential"):
        await runtime.call("task")
    assert not respx_mock.calls


async def test_oversized_and_non_json_response(runtime, respx_mock):
    route = respx_mock.post("http://127.0.0.1:8642/v1/responses").respond(text="x" * 10001)
    with pytest.raises(PaymentError, match="limit"):
        await runtime.call("task")
    route.respond(text="not JSON")
    with pytest.raises(PaymentError, match="unresolved"):
        await runtime.call("a different standalone contract test")


@pytest.mark.parametrize("status", ["queued", "in_progress", "incomplete", "failed", "cancelled"])
def test_nonterminal_is_never_delivered(status):
    value = completed()
    value["status"] = status
    with pytest.raises(PaymentError):
        terminal_text(value, "responses")


def test_commentary_and_pending_client_tool_are_not_final_answer():
    value = completed("I will do it")
    value["output"][0]["phase"] = "commentary"
    with pytest.raises(PaymentError):
        terminal_text(value, "responses")
    value = completed()
    value["output"].insert(0, {"type": "function_call", "name": "run"})
    with pytest.raises(PaymentError):
        terminal_text(value, "responses")
    value["output"][0]["status"] = "completed"
    with pytest.raises(PaymentError):
        terminal_text(value, "responses")
    value["output"][0]["call_id"] = "call-1"
    value["output"].insert(
        1,
        {
            "type": "function_call_output",
            "status": "completed",
            "call_id": "call-1",
        },
    )
    assert terminal_text(value, "responses") == "delivered"


@pytest.mark.parametrize("finish", ["length", "tool_calls", "content_filter", None])
def test_chat_requires_finished_answer(finish):
    with pytest.raises(PaymentError):
        terminal_text(
            {
                "choices": [
                    {
                        "finish_reason": finish,
                        "message": {"role": "assistant", "content": "partial"},
                    }
                ]
            },
            "chat-completions",
        )


async def test_chat_path(runtime, respx_mock):
    runtime.config.http_api = "chat-completions"
    route = respx_mock.post("http://127.0.0.1:8642/v1/chat/completions").respond(
        json={
            "choices": [
                {"finish_reason": "stop", "message": {"role": "assistant", "content": "answer"}}
            ],
        }
    )
    assert (await runtime.call("task")).content[0].text == "answer"
    assert json.loads(route.calls[0].request.content)["messages"] == [
        {"role": "user", "content": "task"}
    ]
