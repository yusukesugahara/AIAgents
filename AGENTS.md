# Repository agent instructions

- Never open, search, print, summarize, or otherwise read secret-bearing dotenv files such as
  `.env`, `.env.local`, environment-specific `.env` files, or `*.local` variants. `.env.example`
  is a public template and may be used only for configuration names and documentation.
- Never inspect secret values from process environment variables. Tests that need credentials must
  use explicit fake values and must not make live provider requests.
- Pass `--no-env-file` explicitly to Bun commands. Do not rely only on `bunfig.toml`, because some
  package-manager versions may load dotenv files before applying project configuration.
