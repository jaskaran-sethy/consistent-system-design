# Consistent System Design

Draw system design diagrams in Obsidian with consistent, theme-aware components. Tag a node with its role and it gets that role's colour and shape:

````markdown
```mermaid
flowchart LR
U[Users]:::client --> CDN[CDN]:::cdn --> GW[API gateway]:::gateway --> LB[Load balancer]:::lb
LB --> API[Orders service]:::service
API --> R[Redis]:::cache
API --> PG[Postgres]:::db
API --> S3[S3 images]:::storage
API --> Q[order-events]:::queue --> W[Email worker]:::worker --> SG[SendGrid]:::external
```
````

The plugin also stops Obsidian from turning wide left-to-right diagrams into top-down ones.

Requires Obsidian 1.15 or later, which draws diagrams with [Pele](https://github.com/obsidianmd/pele).

## Components

| Class | For | Look | Automatic shape |
|---|---|---|---|
| `client` | users, browsers, mobile apps | grey | pill |
| `cdn` | CDN, edge | cyan | cloud |
| `gateway` | API gateway | pink | box |
| `lb` | load balancer | purple | hexagon |
| `service` | app or API service | blue | box |
| `worker` | async worker, background job | blue, dashed border | box |
| `db` | database | green | cylinder |
| `cache` | Redis, Memcached | red | cylinder |
| `queue` | queue or stream (Kafka, SQS) | orange | horizontal cylinder |
| `storage` | object or blob storage | yellow | bucket |
| `external` | third-party service | grey, dashed border | box |

Colours come from your theme's `--color-*` variables, so they follow light and dark mode and theme changes.

You can also tag nodes with a `class` statement:

```
class PG,Orders db
```

## Automatic shapes

A tagged node gets its role's shape only when you haven't given it one: `PG[Postgres]:::db` and `PG:::db` become cylinders. A shape you write yourself always wins, so `PG{{Postgres}}:::db` stays a hexagon.

To skip one diagram, add this line to it:

```
%% csd: no-shapes
```

To turn the feature off everywhere, use **Settings → Consistent System Design → Automatic shapes**.

How it works: before Pele draws a flowchart, the plugin appends a line such as `PG@{ shape: cyl }` for each tagged node without a shape. Your note is never changed.

Labels that contain brackets need quotes, as they always do in Mermaid syntax: `PG["Postgres (main)"]:::db`.

## Looks

Three looks are included: **Soft** (tinted fill, the default), **Outline** (coloured border and text) and **Solid** (filled with the role colour). With the [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) plugin, choose one under **Style Settings → Consistent System Design**. Without it, components use Soft.

## Keep diagram direction

When a left-to-right diagram is wider than the note, Pele redraws it top-down. With this setting on (the default), the diagram keeps the direction you wrote and is scaled down to fit. Turn it off in **Settings → Consistent System Design**.

How it works: Obsidian draws each diagram by calling Pele's `mount()`. The plugin wraps that call and passes Pele's own `autoDirection: false` option. It restores Pele when the plugin is disabled. If a future Obsidian version draws diagrams differently, this setting stops having an effect, but your diagrams keep working.

## Compatibility

- Diagrams that don't use these classes look exactly as before.
- Colours set inside a diagram with `classDef` or `style` win over the plugin's colours.
- Works alongside other plugins that wrap Pele, such as Mermaid Flow Enhancer.

## Privacy

The plugin makes no network requests and collects no data.

## Installing manually

Download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/consistent-system-design/`, then enable the plugin in **Settings → Community plugins**.

## License

[MIT](LICENSE)
