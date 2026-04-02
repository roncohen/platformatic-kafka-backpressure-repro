# `@platformatic/kafka` 1.31 async-iterator backpressure repro

This is a **standalone minimal reproduction** for the suspected async-iterator backpressure regression between:

- `@platformatic/kafka` **1.30.0**
- `@platformatic/kafka` **1.31.0**

It does **not** use any Reflag application code.

## What it tries to show

The repro uses:

- one local Kafka broker on `localhost:29092`
- one topic with one partition
- a large pre-produced backlog
- a slow consumer using:

```js
for await (const message of stream) {
  await sleep(PROCESS_DELAY_MS)
}
```

- `highWaterMark=1`

It monkey-patches the returned stream instance to count how often `stream.push()` returns `false`.

The expected signal is:

- in **1.30.0**, buffering stays much more bounded
- in **1.31.0**, `push()` starts returning `false` but the consumer keeps fetching anyway, so:
  - `readableLength` keeps growing
  - RSS / heap keep growing

On this machine, with the suggested settings below, the summaries looked like:

- **1.30.0**
  - `pushFalseCount: 3500`
  - `maxReadableLength: 3500`
  - `maxRssMiB: 290.77`
- **1.31.0**
  - `pushFalseCount: 20000`
  - `maxReadableLength: 19971`
  - `maxRssMiB: 716.52`

That is, with `highWaterMark=1`, 1.31 buffered almost the entire backlog while 1.30 stopped after roughly one large fetch window.

## Prerequisites

- Node **24.6.0** or newer
- Docker
- Yarn **4.x**

## Install

```bash
yarn install
```

## Start the broker

```bash
yarn broker:up
```

Wait until the container is healthy:

```bash
docker ps
```

## Run the repro

### `@platformatic/kafka` 1.30.0

```bash
yarn repro:130
```

### `@platformatic/kafka` 1.31.0

```bash
yarn repro:131
```

## Suggested comparison run

Use the same settings for both runs:

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

## Output

The script prints JSON lines such as:

- `config`
- `produce:*`
- `sample`
- `summary`

Useful fields to compare:

- `pushFalseCount`
- `readableLength`
- `maxReadableLength`
- `readableHighWaterMark`
- `rssMiB`
- `heapUsedMiB`

## Why this is minimal

This repo intentionally avoids:

- databases
- HTTP servers
- batchers
- feature flags
- app-specific code
- production offsets or production brokers

It only exercises the stream consumer behavior of `@platformatic/kafka`.

## Cleanup

```bash
yarn broker:down
```
