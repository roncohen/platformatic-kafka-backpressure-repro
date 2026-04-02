# `@platformatic/kafka` async-iterator backpressure repro

This repo is a **small standalone reproduction** of a behavioral difference between:

- `@platformatic/kafka` **1.30.0**
- `@platformatic/kafka` **1.31.0**

## Claim

With the same script and the same broker:

- **1.30.0** buffers a limited chunk of the backlog
- **1.31.0** keeps buffering almost the entire backlog

That happens even though:

- the consumer uses `for await (const message of stream)`
- `highWaterMark=1`
- `stream.push()` is already returning `false`

## Repro shape

The script does only this:

1. starts a local Kafka broker on `localhost:29092`
2. creates a 1-partition topic
3. pre-produces a backlog of messages
4. starts a **slow** consumer:

```js
for await (const message of stream) {
  await sleep(PROCESS_DELAY_MS)
}
```

It monkey-patches the returned stream instance to count:

- how many times `push()` is called
- how many times `push()` returns `false`
- the largest observed `readableLength`

It also logs memory usage (`rssMiB`, `heapUsedMiB`).

## Quick start

### Prerequisites

- Node **24.6.0** or newer
- Docker
- Yarn **4.x**

### Install

```bash
yarn install
```

### Start Kafka

```bash
yarn broker:up
```

### Run both versions with the same settings

```bash
HIGH_WATER_MARK=1 \
MESSAGE_COUNT=20000 \
MESSAGE_BYTES=16384 \
PRODUCE_BATCH_SIZE=50 \
PROCESS_DELAY_MS=25 \
RUN_MS=30000 \
MAX_BYTES=$((64 * 1024 * 1024)) \
yarn repro:130

HIGH_WATER_MARK=1 \
MESSAGE_COUNT=20000 \
MESSAGE_BYTES=16384 \
PRODUCE_BATCH_SIZE=50 \
PROCESS_DELAY_MS=25 \
RUN_MS=30000 \
MAX_BYTES=$((64 * 1024 * 1024)) \
yarn repro:131
```

## What to look at

Each run prints JSON lines. The most useful line is the final `summary` event.

Compare these fields:

- `pushFalseCount`
- `maxReadableLength`
- `maxRssMiB`
- `maxHeapUsedMiB`

## Example result from one run

Using the settings above, one local run produced:

### 1.30.0

```json
{"event":"summary","selectedVersion":"1.30.0","producedCount":20000,"consumedCount":564,"pushCalls":3500,"pushFalseCount":3500,"firstPushFalseAtReadableLength":1,"maxReadableLength":3500,"highWaterMark":1,"maxRssMiB":290.77,"maxHeapUsedMiB":74.15}
```

### 1.31.0

```json
{"event":"summary","selectedVersion":"1.31.0","producedCount":20000,"consumedCount":554,"pushCalls":20000,"pushFalseCount":20000,"firstPushFalseAtReadableLength":1,"maxReadableLength":19971,"highWaterMark":1,"maxRssMiB":716.52,"maxHeapUsedMiB":346.57}
```

## Why this looks wrong

With `highWaterMark=1`, backpressure starts immediately:

- `firstPushFalseAtReadableLength` is `1`

But in `1.31.0` the consumer still buffers almost the entire backlog:

- `maxReadableLength` grows to ~`20000`
- RSS / heap grow much more than in `1.30.0`

So the issue is not just that buffering is "large" in general. The important part is:

> `push()` is already signaling backpressure, but `1.31.0` continues fetching and buffering anyway.

## Files

- `repro.mjs` — the full repro script
- `compose.yaml` — local Kafka broker
- `package.json` — installs both versions via aliases:
  - `kafka130` → `@platformatic/kafka@1.30.0`
  - `kafka131` → `@platformatic/kafka@1.31.0`

## Cleanup

```bash
yarn broker:down
```
