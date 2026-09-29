from pathlib import Path

import pytest
from pydantic import ValidationError

from envarpay.backend import AgentBackend
from envarpay.cli import initialize
from envarpay.config import Backend, load_config


@pytest.mark.parametrize(
    "preset,target,port",
    [
        ("openclaw", "openclaw/seller", 18789),
        ("hermes-http", "hermes-agent", 8642),
    ],
)
async def test_existing_runtime_preset_has_no_model_dependency(
    tmp_path, monkeypatch, preset, target, port
):
    initialize(tmp_path / "config", "0x" + "33" * 20, preset)
    config = load_config(tmp_path / "config/seller.toml")
    assert config.seller.backend.kind == "http"
    assert config.seller.backend.model == target
    assert config.seller.backend.base_url == f"http://127.0.0.1:{port}/v1"
    monkeypatch.setenv("ENVARPAY_RUNTIME_TOKEN", "test-token")
    backend = AgentBackend(config.seller.backend, 30)
    import sys

    monkeypatch.setitem(sys.modules, "run_agent", None)
    tools = await backend.list_tools()
    assert [tool.name for tool in tools] == ["ask_agent"]


@pytest.mark.parametrize(
    "url",
    [
        "https://user:password@example.com/v1",
        "https://example.com/v1?api_key=secret",
        "http://remote.example/v1",
        "file:///private/secret",
        "https://example.com/v1/responses",
    ],
)
def test_http_backend_rejects_unsafe_or_ambiguous_url(url):
    with pytest.raises(ValidationError):
        Backend(kind="http", model="fixed", base_url=url, api_key_env="RUNTIME_TOKEN")


def test_http_secret_path_resolves_from_existing_config(tmp_path: Path):
    initialize(tmp_path / "config", "0x" + "33" * 20, "hermes-http")
    path = tmp_path / "config/seller.toml"
    path.write_text(
        path.read_text().replace(
            'api_key_env = "ENVARPAY_RUNTIME_TOKEN"', 'api_key_file = "../runtime-token"'
        )
    )
    loaded = load_config(path)
    assert loaded.seller.backend.api_key_file == str(tmp_path / "runtime-token")
    assert loaded.state_dir == str(tmp_path / "config/seller-state")
