# The Qubit

Quantum survival game with multiplayer lobby, hosted at:

https://the-qubit.ssh.codes

## Run Locally

```sh
npm install
npm start
```

The server listens on `PORT` if set, otherwise `8080`.

```sh
PORT=8080 npm start
```

Open `http://localhost:8080` in your browser.

## Nickname Moderation

The server always runs a local nickname filter before names can appear in multiplayer or on leaderboards. If `OPENAI_API_KEY` is set, it also checks public nicknames with OpenAI moderation using `omni-moderation-latest`.

```sh
OPENAI_API_KEY=sk-... npm start
```

On the Mac, use the helper script to set the key on the Raspberry Pi:

```sh
./scripts/set-openai-key.sh
```

Optional environment variables:

- `OPENAI_MODERATION_MODEL`: defaults to `omni-moderation-latest`
- `OPENAI_MODERATION_FAIL_OPEN=1`: allow locally clean nicknames if OpenAI moderation is unavailable
