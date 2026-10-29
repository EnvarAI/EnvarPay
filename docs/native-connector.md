# Native Agent connection

The implementation and current setup guide are in [EnvarConnect](https://github.com/EnvarAI/EnvarConnect/blob/main/docs/native-connector.md). Install `@envarai/connect` and use `envar-connect connect/run/doctor`.

Existing `envarpay connector ...` commands and `@envarai/envarpay/connector` imports remain supported through the pinned dependency. The original `~/.envarpay/connectors/AGENT_ID` state, journal, credentials and locks are preserved. Stop one receiver before running the other. See [migration](https://github.com/EnvarAI/EnvarConnect/blob/main/docs/migration.md).
