# Nexus Accounting

Firefox addon that tracks survey mission data from [Nexus Legacy](https://s0.nexuslegacy.space).

<img width="1889" height="726" alt="image" src="https://github.com/user-attachments/assets/62757e1c-d4c6-422d-9889-4ad0144b8801" />

## What it does

- Scrapes survey reports from the game API every 15 minutes (or on demand)
- Aggregates resources collected: ore, hydrogen, silicates
- Tracks ship losses and computes their rebuild cost (ore, silicates, hydrogen, alloys, rare resources)
- Breaks down results by event type
- Displays all-time, daily, and hourly views
- Stores up to 500 survey reports locally (configurable, 0 = unlimited)

## How it works

The addon reads your `nexus_token` JWT directly from the browser cookies, no credentials to enter. You just need to be logged in to Nexus Legacy.

All data is stored locally in `browser.storage.local`. Nothing is sent anywhere.

## Usage

1. Log in to [Nexus Legacy](https://s0.nexuslegacy.space)
2. Click the Nexus Accounting toolbar icon to open the dashboard
3. Click **Scrape Now** to fetch data immediately, or wait for the automatic 15-minute scrape

## Dashboard

| Section | Description |
|---|---|
| Resources collected | Ore, hydrogen, silicates, mission count, ships lost |
| Resources lost | Build cost of destroyed ships per resource type |
| Resources per period | Line chart over time |
| Event type breakdown | Doughnut chart of mission types |
| Resources by event type | Bar chart of yields per mission type |
| Recent reports | Paginated table of individual survey reports |

Use the **View** selector (All time / Daily / Hourly) to filter all stats and charts to the latest day or hour.

### Escort templates

Fleet templates can be marked as escorts for one or more asteroid-field security
zones. In **Fleet Templates**, select the applicable zone and, when appropriate,
enable **Per mining ship** to store the ship quantities as escort ratios. When
launching a mining fleet for a matching zone, the fleet editor offers the
configured escort templates and calculates the required ships from the selected
mining fleet. The **Auto-add** option persists its choice and automatically
adds the alphabetically first matching escort template when the dialog opens or
the mining fleet is optimised. The mining dialog can also remember **Auto-optimise
mining fleet** and **Excavator +20%**; when enabled, it applies the recommendation
on open and includes one available Excavator. Active mining missions are marked
in the asteroid-field table. The mining confirmation dialog also offers **Mine until
full**, which keeps mining past the usual ten cycles until the fleet's mining
hold is full or the field is depleted. Its **Withdraw escort by damage
threshold** menu optionally returns the fleet early at 30%, 50%, or 70% escort
damage; mining stops, although pirates may still steal cargo.

Completed Asteroids scans are cached for 15 minutes. When the tab is opened
again with the same source planet selected, the valid cached fields are shown
immediately; use **Scan** to refresh them.

When one or more Asteroids zone filters are selected, **Nearest systems** means
the nearest explored systems in those zones, not merely the nearest systems
overall with non-matching results hidden afterward.

With one or more resource-type filters selected, a scan continues until it has
found the requested number of systems containing those field types, or has
checked 500 systems. Requests remain sequential and use the normal scan delay.

## Settings

- **Records cap**: max survey reports kept locally. Oldest are dropped when limit is reached. Set to `0` for unlimited.
- **Reset all data**: drops all stored reports (keeps your cap setting).

## Screens

<img width="1903" height="726" alt="nexus_accounting" src="https://github.com/user-attachments/assets/9a3fd91c-e3cf-4fec-88e1-0c1b973e693c" />

<img width="1893" height="728" alt="nexus_accounting_hourly" src="https://github.com/user-attachments/assets/1658ae94-12c2-42c1-b634-fab23f98bede" />

<img width="1901" height="883" alt="nexus_accounting_graph_bar" src="https://github.com/user-attachments/assets/723bf0e3-8251-4fe3-bc6b-57f1bb54629f" />


## Disclaimer

Web UI made with Claude Opus 4.8

## License

[Mozilla Public License](https://www.mozilla.org/en-US/MPL/2.0/)
