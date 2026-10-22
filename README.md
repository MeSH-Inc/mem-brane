# mem-brane

A spatial workspace for thinking with cards and AI. Create a **brane**, arrange text, images, PDFs and imported webpages, then develop a card or write a prompt with exactly the cards you choose as context. Every response shows what it was based on, keeps the exact inputs it was sent, and says when a source has changed since.

This is a greenfield, single-server application under active development, running at [mem-brane.com](https://mem-brane.com) with DeepSeek generation under small spend limits. Locally, the default **mock** model streams deterministic text without provider credentials or model spend.

## Quick start

Use Node.js 24 (see `.node-version`) and npm. The SQLite dependency, `better-sqlite3`, needs a compatible native binary; if a prebuilt binary is unavailable, installation requires your platform's C/C++ build tools.

```sh
git clone https://github.com/MeSH-Inc/mem-brane.git
cd mem-brane
npm ci
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Open [localhost:5173](http://localhost:5173). The optional development seed creates:

- Email: `hello@mem-brane.local`
- Password: `mem-brane-local-only`

Set `SEED_EMAIL` and `SEED_PASSWORD` to override those credentials, or skip the seed and create an account in the interface. Never use the development seed for production.

Vite serves the browser on port 5173 and proxies `/api` to the Node server on port 3001. Use `localhost` to match `APP_ORIGIN`. If you change the browser hostname, update that setting too. Run commands from the repository root: migrations, browser assets and default data paths resolve from the working directory.

## Develop

```sh
npx playwright install chromium firefox webkit   # once
npm run verify                                   # format, build, unit and browser tests
```

`npm run verify` is the pre-push gate; there is no CI. See [development](docs/development.md) for every command, configuration setting and the stress suite.

## Documentation

| Document                                                     | Covers                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| [Using mem-brane](docs/guide.md)                             | Branes, cards, context, imports, canvas gestures and Focus      |
| [Development](docs/development.md)                           | Verification, commands, configuration, running a build          |
| [Architecture overview](docs/architecture/README.md)         | Domain records, background work, repository map, boundaries     |
| [Architecture decisions](docs/architecture/)                 | Principles, invariants and one document per subsystem (00–15)   |
| [Deployment](docs/deployment.md)                             | Kamal on apps-1, Litestream and bundle backups, budgets, limits |
| [Offline PWA](docs/offline-pwa.md)                           | Installation, offline reload and reconnect conflicts            |
| [Interaction verification](docs/interaction-verification.md) | Stress suite, latency guards and device coverage                |
| [Operations](docs/operations/)                               | Live generation, recovery and alerts, retention                 |
