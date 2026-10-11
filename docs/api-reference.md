# Nexus Legacy API integration

This page documents the game API routes currently used by Nexus Accounting. It is
a practical integration reference, not a complete or official specification of
the Nexus Legacy API. Routes and response fields can change without notice.

The add-on sends requests to the currently selected game server, for example
`https://s0.nexuslegacy.space`, using paths under `/api`.

## Authentication and request handling

The add-on does not read or extract the session token. It sends requests through
the logged-in game tab, where the browser attaches the game's HttpOnly session
cookie. This keeps requests same-origin with the game. If the bridge content
script is not available, the background service worker attempts to inject it.

GET requests are used for loading and refreshing data. POST requests are also
used for actions initiated from the add-on, as well as for the fuel-estimate
calculation. State-changing requests are only sent when the corresponding
feature is used; a periodic report scrape does not launch missions or research.

The background API client observes the server's rate-limit headers, throttles
requests before the remaining budget gets low, and retries transient network,
HTTP 429, and server errors. A 401 means the user needs to log in to the game.
Some API reads are also made directly by the add-on UI in the game tab.

## Data endpoints

| Feature | Method and route | Use |
|---|---|---|
| Player | `GET /api/auth/me` | Current player identity and account details |
| Planets | `GET /api/planets` | Planet list and IDs |
| Planets | `GET /api/planets/{planetId}` | Planet resources and building data |
| Fleets | `GET /api/planets/{planetId}/fleet` | Ships stationed at a planet |
| Shipyard | `GET /api/planets/{planetId}/shipyard` | Ship definitions and planet availability |
| Research | `GET /api/research?planetId={planetId}` | Research catalogue and player progress |
| Missions | `GET /api/fleet/missions` | Active and returning fleets |
| Reports | `GET /api/fleet/survey-reports` | Survey results used by accounting and follow-up tools |
| Reports | `GET /api/fleet/survey-cooldowns` | Survey availability |
| Reports | `GET /api/fleet/pirate-reports` | Pirate combat reports |
| Reports | `GET /api/fleet/reports` and `GET /api/fleet/reports/{id}` | Combat report summaries and full details |
| Reports | `GET /api/fleet/spy-reports`, `GET /api/fleet/camp-scout-reports` | Scouting reports |
| Reports | `GET /api/fleet/mining-reports`, `GET /api/fleet/expedition-reports` | Mining and expedition results |
| Reports | `GET /api/fleet/wormhole-runs`, `GET /api/fleet/wormholes` | Wormhole activity |
| Reports | `GET /api/fleet/system-debris`, `GET /api/messages/system` | Debris and system-message data |
| Galaxy | `GET /api/galaxy/arms` | Galaxy arms |
| Galaxy | `GET /api/galaxy/arms/{armId}/sectors` | Sectors in an arm |
| Galaxy | `GET /api/galaxy/sectors/{sectorId}/systems` | Systems in a sector |
| Galaxy | `GET /api/galaxy/map` | Known systems and coordinates |
| Galaxy | `GET /api/galaxy/systems/{systemId}/planets` | Planets, asteroid fields, and moons in a system |
| Trade | `GET /api/market/hubs`, `GET /api/market/orders` | Market hubs and public orders |
| Trade | `GET /api/market/my-trades`, `GET /api/alliance-trade/orders` | Player trades and alliance orders |
| Logistics | `GET /api/outposts`, `GET /api/moons/{moonId}` and related fleet routes | Logistics destinations and their state |

Paged report and trade feeds may accept `page` and `limit` query parameters.
The exact parameters and response envelope depend on the endpoint.

## Response shapes used by the add-on

These are abbreviated shapes, not exhaustive schemas. Optional properties,
empty collections, and fields available to a player can vary.

### Survey reports

The survey feed is an object with a `reports` array and `unreadCount`. A report
can include its system and event, resource `loot`, ship losses, timestamps,
investigation status, and combat or anomaly details. Treat resource keys and
event-specific details as data-driven rather than assuming every report has the
same fields. Spy-report payloads have also evolved: newer reports can put
tiered scan data in `intel` rather than the legacy `fleetData`, `buildingData`,
`defenseData`, and `resourceData` fields.

```json
{
  "reports": [
    {
      "id": 3129005,
      "systemId": 6905,
      "eventType": "pirate_fleet",
      "loot": {
        "ore": 2078,
        "hydrogen": 710,
        "silicates": 1094
      },
      "shipsLost": [],
      "createdAt": "2026-08-26T07:39:20.640Z"
    }
  ],
  "unreadCount": 0
}
```

### Missions and fuel estimates

The missions feed returns `{ "missions": [...], "maxFleetSlots": number }`.
Missions identify their type and status and can include fleet composition,
source and target, travel timing, cargo, and mining-specific fields.

`POST /api/fleet/fuel-estimate` is a calculation endpoint. It accepts a source
planet, target system, and ship quantities; its response includes values such
as `fuelCost`, `distance`, `travelTime`, `sufficient`, and `inRange`.

```json
{
  "sourcePlanetId": 74062,
  "targetSystemId": 5752,
  "ships": [
    {
      "shipDefId": 21,
      "quantity": 1
    }
  ]
}
```

### Galaxy map and system contents

The map response contains `systems` and may include `userSystemIds`. A system
entry supplies fields such as its ID, coordinates, sector, arm, and security
zone. The system-contents endpoint returns separate `planets`,
`asteroidFields`, and `moons` arrays; `included` indicates which entity groups
were resolved. Any one of these arrays can be empty.

### Research

The research endpoint returns the research catalogue along with player progress
and active research. Entries can include requirements, effects, current level,
status, and server-calculated next-level costs and duration. The UI should use
the returned next-level values rather than treating base costs as current costs.

## Actions initiated by the add-on

The following POST routes are used by interactive features:

| Method and route | Purpose |
|---|---|
| `POST /api/fleet/survey` | Launch a survey |
| `POST /api/fleet/mine` | Launch asteroid mining |
| `POST /api/fleet/investigate` | Investigate a survey result |
| `POST /api/fleet/collect-debris` | Collect system debris |
| `POST /api/fleet/collect-salvage` | Collect report salvage |
| `POST /api/fleet/expedition` | Launch an expedition |
| `POST /api/fleet/xeno-survey` | Survey a moon |
| `POST /api/research/{researchId}/start` | Start research on a planet |
| `POST /api/fleet/dispatch` and outpost/moon routes | Send fleets or resources through logistics |
| `POST /api/fleet/fuel-estimate` | Calculate dispatch fuel and travel values; does not itself launch a fleet |

The game validates action requirements and remains authoritative for resulting
state. A successful request should not be treated as proof that every displayed
or cached view has already refreshed.

## Further endpoint notes

The following upstream API notes were reviewed when preparing this page. They
contain additional examples and dated observations; verify details against this
project's current call sites before relying on them:

- [API notes and endpoint index](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/README.md)
- [Survey reports](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/fleet_survey_reports.md)
- [Spy reports](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/fleet_spy_reports.md)
- [Fleet missions](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/fleet_missions.md)
- [Research](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/research.md)
- [Galaxy map](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/galaxy_map.md)
- [System contents](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/galaxy_system_planets.md)
- [Fuel estimate](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/post/fleet_fuel_estimate.md)
- [Planet detail](https://github.com/Verroq/NexusAccounting/blob/09a5cb1c4203e880ae28e9a20c6576e463c77f76/docs/api/get/planets_detail.md)
