# The demo room

The room every Trommi client shows as its demo (`?mock=1` on the web), and the list of screens and states the web
app's review page `/screens` walks through. **All of it is made up**: no real room, account, person or address is in
here, and none may be added.

Right now the room is an empty skeleton: one device, no agents, no cards, no pictures. The demo shows an empty Desk,
and `/screens` lists the states that need no content (the account screens, the empty Desk, Settings, the Scribble
Board).

```
demo/
├── README.md
├── check.mjs          the check, and the one written form of the two JSON files
└── data/              what a client ships: only data
    ├── fixture.json   the room
    ├── screens.json   every screen and state
    └── files/         the pictures and pages the room names (absent while it names none)
```

## The data

**`data/fixture.json`**: one room as the client core's model (`app/web/core/README.md` "The model"), as JSON:

| Key | What |
| --- | --- |
| `made_at` | the moment the room was made (ms). Every other time in the file is relative to it: a client adds `now - made_at` to each when it loads the room, so "5 min ago" stays five minutes ago |
| `room` | `room_id`, `hub_url` (`mock:`), `my_device_id`, `my_role`, the counters |
| `members` | the devices: at least the human one that looks at the room (`room.my_device_id`) |
| `sessions` | the agents' sessions with profile, status lines and settings |
| `cards` | the decision and info cards, each with its versions and answers |
| `permissions`, `notes`, `published` | waiting permission requests, the corner note, published artifacts |
| `timelines` | the conversations (`chat:session/<device>`, `chat:card/<object>`) and the Scribble Boards (`scribble:desk/<id>`) |
| `human` | the human registers: `drafts`, `snoozes`, `ducks`, `crown`, `desks`, `session_settings` |

An attachment names its file as `url: "/demo/files/<name>"`; the file is `data/files/<name>`.

**`data/screens.json`**: `{ "states": [...] }`, one line per state, a screen's states together and its first one the
screen as it is:

```json
{"id":"desk--keys-sheet","screen":"Desk","state":"Keys sheet","web":{"path":"/","state":"keys","mock":"1"}}
```

| Field | What |
| --- | --- |
| `id` | `<screen>` for the first state of a screen, else `<screen>--<state>`, both in lower case with `-` for everything else |
| `screen`, `state` | the names shown |
| `web.path` | the address in the app |
| `web.state` | the click the web makes once the page is there (`?state=<name>`, `demoState` in `app/web/public/demo/demo.mjs`), or `null` |
| `web.mock` | the room: `"1"` is the fixture as it is, its times moved to now; any other name is a variant the client builds from it (`loadFixture` in `demo.mjs`) |

An empty list is allowed: `/screens` then says that none are listed.

## Who takes it, and when

The web app's build (`app/web/dev/build.mjs`) runs the check, then copies the room (without its spaces) to
`public/demo/fixture.json` and the files to `public/demo/files/`, the addresses the app fetches, and puts the states
into the bundle. Neither is in git. The dev server (`app/web/dev/serve.mjs`) does the same from memory on every
request: an edit here shows at the next reload.

## The check

`node demo/check.mjs` (`npm run test:demo`; also run by `npm run test:app` and by the web app's build). It fails when

- `fixture.json` or `screens.json` does not parse, lacks a key, has a list or an object of the wrong kind, names no
  human device as the one looking, or is not in its written form (`node demo/check.mjs --write` writes both);
- a state has no id, an id twice, an id that does not follow from its names, or stands apart from its screen;
- the fixture, `demo.mjs` or a page in `files/` names a file that is not there, or a file is named by nobody;
- the web app keeps a copy: anything of the demo data tracked in `app/web/public/demo/`.
