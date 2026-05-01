# pi-webui

a native web app for [pi](https://pi.dev), backed by the pi sdk runtime
and your existing persisted pi sessions.

## getting started

prerequisites:

- node.js 20+
- a working pi install with config/auth on this machine
  (`~/.pi/agent` by default)

install and run:

```bash
npm install
npm start
```

then open <http://127.0.0.1:8787>.

for development with auto-reload:

```bash
npm run dev
```

### install from npm

```bash
npm install -g @khimaros/pi-webui
pi-webui
```

## configuration

command-line flags:

| flag | purpose |
| --- | --- |
| `--listen <host:port>` | http bind address; takes precedence over `HOST`/`PORT`. use `:port` for default host, or `[::1]:port` for ipv6. |

environment variables:

| variable | default | purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | http bind address |
| `PORT` | `8787` | http port |
| `PI_PROJECT_CWD` | `process.cwd()` | project directory used for sessions |
| `PI_AGENT_DIR` | pi default (`~/.pi/agent`) | pi agent config directory |
| `PI_SESSION_DIR` | pi default | session storage directory |

examples:

```bash
pi-webui --listen 0.0.0.0:3000
HOST=0.0.0.0 PORT=3000 PI_PROJECT_CWD=/path/to/project npm start
```

## roadmap

see [ROADMAP.md](ROADMAP.md) for implemented and planned features.

## architecture

- `server.mjs` — http + websocket server hosting the pi sdk runtime
- `server-event-log.mjs`, `server-log.mjs`, `server-watch.mjs` —
  server-side helpers
- `public/` — browser client (vanilla js, no build step)

## development

```bash
make            # install deps
make test       # run tests
make lint       # syntax-check sources
make precommit  # lint + test
make vendor     # refresh public/vendor (marked, highlight.js)
```
