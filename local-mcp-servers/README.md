# local-mcp-servers

Placeholder mount point for custom MCP server projects that aren't installable
npm/docker packages — for example a private QuickBooks MCP server.

By default, `docker-compose.yml` and `docker-compose.dev.yml` bind-mount
`./local-mcp-servers/quickbooks` (this directory) into the container at the
fixed path `/mcp-servers/quickbooks`. If you don't need this, leave it empty —
it's a harmless no-op.

To use it: either drop your project directly into `local-mcp-servers/quickbooks`,
or set `QUICKBOOKS_MCP_PATH` in your own `.env` to point at wherever your
project actually lives on disk. Either way, the container always sees it at
`/mcp-servers/quickbooks`, so when you register the server in the metamcp UI,
point its command at that fixed path (e.g. `node /mcp-servers/quickbooks/dist/index.js`)
regardless of where the project lives on your host.

Anything you put under this directory (other than this README) is gitignored.
