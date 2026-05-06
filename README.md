# pi-webui

a simple, standalone webui for [pi.dev](https://pi.dev)

![screencast](docs/screencast.gif)

## getting started

prerequisites:

- node.js 20+
- a working pi installation

install as a pi extension:

```bash
pi install npm:@khimaros/pi-webui
```

control from the pi tui:

```bash
> /webui start    # start the server
> /webui status   # view server status
> /webui open     # open webui in browser
> /webui stop     # stop the server
```

run without installing:

```bash
npx @khimaros/pi-webui
```

or install globally:

```bash
npm install -g @khimaros/pi-webui
pi-webui
```

then open <http://127.0.0.1:8787>.

### from a source checkout

```bash
make            # install deps via npm install
make start      # run the server (npm start)
make start-dev  # run with auto-reload (npm run dev)
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
| `PI_CWD_ALLOW_ANY` | `0` | allow `/cwd` to switch to paths outside `$HOME` |

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
make start      # run the server
make start-dev  # run with auto-reload
make install    # install pi-webui globally from this checkout
make update     # update dependencies (npm update)
make test       # run tests
make lint       # syntax-check sources
make precommit  # lint + test
make vendor     # refresh public/vendor (marked, highlight.js)
```
