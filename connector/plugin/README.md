# The Trommi plugin for Claude Code

This folder is the plugin, as Claude Code reads it from the repository's marketplace
(`.claude-plugin/marketplace.json` at the repository's root). It holds no program. Its MCP server, its hooks and
its monitor all name the installed connector, `~/.local/share/trommi/bin/trommi-connector`, which `install.sh`
puts there from a signed release; `install.sh` also runs `trommi-connector setup claude`, which adds this plugin.
In a project folder, inside Claude Code: `/trommi:connect '<invite link>'` (`commands/connect.md`).

A hook of a session whose connector is not there ends without a word. See [`connector/README.md`](../README.md).
