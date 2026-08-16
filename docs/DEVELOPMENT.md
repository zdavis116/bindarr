# Development

Bindarr's supported development and CI runtime is **Node.js 20.19 or newer within
the Node 20 LTS line**. Select it before installing dependencies, for example
with `nvm install 20 && nvm use 20`, then confirm `node --version` reports at
least 20.19.0.

## Install dependencies

Dependencies are managed separately for the backend and frontend:

```sh
cd backend
npm ci --onnxruntime-node-install=skip

cd ../frontend
npm ci
```

The backend dependency tree includes ONNX Runtime for card-image matching. Its
default installer downloads large CUDA binaries that Bindarr's CPU inference
path does not use; `--onnxruntime-node-install=skip` avoids that download. On an
older Linux distribution, the downloaded `sqlite3` binary may require a newer
glibc. If loading it reports `GLIBC_* not found`, rebuild only that native module
against the host:

```sh
cd backend
npm rebuild sqlite3 --build-from-source
```

Do not check in `node_modules` or a host-built native binary.

## Run locally

In separate terminals from the repository root:

```sh
cd backend
npm run dev
```

```sh
cd frontend
npm run dev
```

Copy `.env.example` to `.env` if local configuration is needed. Do not point
`DB_PATH` at a production database while developing or testing.

## Verification gates

Run the same gates expected for a pull request:

```sh
cd backend
npm test
```

```sh
cd frontend
npm run lint
npm run check:locales
npm run build
```

The backend suite includes the fresh-database fixture test. For a focused run
while changing that helper:

```sh
cd backend
node test/fresh-database.test.js
```

Tests must use temporary data and clean it up; they must not reuse an operator's
configured database.
