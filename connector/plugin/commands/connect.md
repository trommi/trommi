---
description: Connect this folder to your Trommi board with an invite link from the Trommi app
argument-hint: "'<invite link>'"
---

The human wants this Claude Code session connected to their Trommi board with this invite link:

$ARGUMENTS

Call the tool `connect` of the trommi MCP server (mcp__plugin_trommi_trommi__connect) with that link as `link`. If no link was given, ask the human to copy one in the Trommi app ("invite an agent") and run /trommi:connect '<link>' again.

The tool answers with six emoji and their words. Show them to the human exactly as given, one per line, and ask them to compare with the Trommi app's invite page and tap "They match" there. The board tools appear by themselves once they match. If the tool answers with an error, show it to the human as it is.
