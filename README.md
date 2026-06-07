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

## Difficulty

Solo play starts with a safe Tutorial that explains movement, particles, Dark Energy, and power-ups step by step. Scored solo and competition modes support Easy, Normal, and Hard. Normal and Hard can spawn rare Dark Energy, which creates a repulsion field around itself and can still collapse the qubit on contact. The time ramp increases spawn rate linearly by 10% per survived minute, capped at 2x the starting spawn rate.

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

## Leaderboard Validation

Leaderboard submissions require a server-issued run token from `/api/run/start`. The token is one-time-use, mode-bound, and checked against real elapsed server time before `/api/score` accepts the submitted survival time.
