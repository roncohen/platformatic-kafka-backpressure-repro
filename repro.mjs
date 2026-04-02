#!/usr/bin/env node

import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const versionArg = process.argv[2];
const packageName =
  versionArg === 'kafka130'
    ? 'kafka130'
    : versionArg === 'kafka131'
      ? 'kafka131'
      : null;

if (!packageName) {
  console.error('usage: node repro.mjs <kafka130|kafka131>');
  process.exit(1);
}

// `packageName` is either `kafka130` or `kafka131` from package.json aliases.
// Using dynamic import lets the same script load either installed version at runtime
// without changing any other code in the repro.
const kafka = await import(packageName);
const selectedVersion = packageName === 'kafka130' ? '1.30.0' : '1.31.0';

const config = {
  broker: envString('BROKER', 'localhost:29092'),
  topic: envString('TOPIC', `repro-backpressure-${selectedVersion.replaceAll('.', '-')}-${Date.now()}`),
  groupId: envString('GROUP_ID', `repro-backpressure-${selectedVersion.replaceAll('.', '-')}-${Date.now()}`),
  messageCount: envNumber('MESSAGE_COUNT', 20_000),
  messageBytes: envNumber('MESSAGE_BYTES', 16_384),
  produceBatchSize: envNumber('PRODUCE_BATCH_SIZE', 50),
  processDelayMs: envNumber('PROCESS_DELAY_MS', 25),
  runMs: envNumber('RUN_MS', 30_000),
  highWaterMark: envNumber('HIGH_WATER_MARK', 1),
  minBytes: envNumber('MIN_BYTES', 1),
  maxBytes: envNumber('MAX_BYTES', 64 * 1024 * 1024),
  maxWaitTimeMs: envNumber('MAX_WAIT_TIME_MS', 10),
  topicCreateWaitMs: envNumber('TOPIC_CREATE_WAIT_MS', 1_000),
  logIntervalMs: envNumber('LOG_INTERVAL_MS', 1_000),
};

const payload = 'x'.repeat(config.messageBytes);
let producedCount = 0;
let consumedCount = 0;
let stopping = false;
let logTimer = null;
let stopTimer = null;
let stream = null;
let consumer = null;
let producer = null;
let admin = null;

const stats = {
  pushCalls: 0,
  pushFalseCount: 0,
  maxReadableLength: 0,
  firstPushFalseAtReadableLength: null,
  maxRssMiB: 0,
  maxHeapUsedMiB: 0,
  maxExternalMiB: 0,
};

const startedAt = Date.now();

function envString(name, defaultValue) {
  return process.env[name] ?? defaultValue;
}

function envNumber(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid numeric env ${name}=${value}`);
  }

  return parsed;
}

function formatMiB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function elapsedMs() {
  return Date.now() - startedAt;
}

function log(event, extra = {}) {
  console.log(
    JSON.stringify({
      event,
      selectedVersion,
      elapsedMs: elapsedMs(),
      ...extra,
    }),
  );
}

function snapshotMemory() {
  const memory = process.memoryUsage();
  const rssMiB = formatMiB(memory.rss);
  const heapUsedMiB = formatMiB(memory.heapUsed);
  const externalMiB = formatMiB(memory.external);

  stats.maxRssMiB = Math.max(stats.maxRssMiB, rssMiB);
  stats.maxHeapUsedMiB = Math.max(stats.maxHeapUsedMiB, heapUsedMiB);
  stats.maxExternalMiB = Math.max(stats.maxExternalMiB, externalMiB);

  return {
    rssMiB,
    heapUsedMiB,
    externalMiB,
  };
}

async function createTopic() {
  admin = new kafka.Admin({
    clientId: `admin-${selectedVersion}`,
    bootstrapBrokers: [config.broker],
  });

  log('create-topic:start', {
    broker: config.broker,
    topic: config.topic,
  });

  await admin.createTopics({
    topics: [config.topic],
    partitions: 1,
    replicas: 1,
  });

  await sleep(config.topicCreateWaitMs);

  log('create-topic:done', {
    topic: config.topic,
  });
}

async function produceBacklog() {
  producer = new kafka.Producer({
    clientId: `producer-${selectedVersion}`,
    bootstrapBrokers: [config.broker],
    serializers: kafka.stringSerializers,
  });

  log('produce:start', {
    topic: config.topic,
    messageCount: config.messageCount,
    messageBytes: config.messageBytes,
    produceBatchSize: config.produceBatchSize,
  });

  for (let batchStart = 0; batchStart < config.messageCount; batchStart += config.produceBatchSize) {
    const batchEnd = Math.min(batchStart + config.produceBatchSize, config.messageCount);
    const messages = [];

    for (let index = batchStart; index < batchEnd; index += 1) {
      messages.push({
        topic: config.topic,
        key: String(index),
        value: payload,
      });
    }

    await producer.send({ messages });
    producedCount += messages.length;

    if (producedCount % (config.produceBatchSize * 10) === 0 || producedCount === config.messageCount) {
      log('produce:progress', {
        producedCount,
      });
    }
  }

  await producer.close();
  producer = null;

  if (typeof global.gc === 'function') {
    global.gc();
  }

  log('produce:done', {
    producedCount,
    ...snapshotMemory(),
  });
}

function patchStreamPush(messagesStream) {
  const originalPush = messagesStream.push.bind(messagesStream);

  messagesStream.push = function patchedPush(chunk, ...rest) {
    const result = originalPush(chunk, ...rest);

    if (chunk !== null) {
      stats.pushCalls += 1;
      if (!result) {
        stats.pushFalseCount += 1;
        if (stats.firstPushFalseAtReadableLength == null) {
          stats.firstPushFalseAtReadableLength = messagesStream.readableLength;
        }
      }
      stats.maxReadableLength = Math.max(stats.maxReadableLength, messagesStream.readableLength);
    }

    return result;
  };
}

function startPeriodicLogging(messagesStream) {
  logTimer = setInterval(() => {
    const memory = snapshotMemory();

    log('sample', {
      producedCount,
      consumedCount,
      pushCalls: stats.pushCalls,
      pushFalseCount: stats.pushFalseCount,
      readableLength: messagesStream.readableLength,
      readableHighWaterMark: messagesStream.readableHighWaterMark,
      maxReadableLength: stats.maxReadableLength,
      ...memory,
    });
  }, config.logIntervalMs);

  stopTimer = setTimeout(async () => {
    stopping = true;
    log('time-limit-reached', {
      runMs: config.runMs,
      consumedCount,
      producedCount,
    });

    try {
      await messagesStream.close();
    } catch (error) {
      log('stream-close:error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, config.runMs);
}

async function consumeSlowly() {
  consumer = new kafka.Consumer({
    clientId: `consumer-${selectedVersion}`,
    groupId: config.groupId,
    bootstrapBrokers: [config.broker],
    deserializers: kafka.stringDeserializers,
    highWaterMark: config.highWaterMark,
    minBytes: config.minBytes,
    maxBytes: config.maxBytes,
    maxWaitTime: config.maxWaitTimeMs,
  });

  log('consume:start', {
    groupId: config.groupId,
    highWaterMark: config.highWaterMark,
    minBytes: config.minBytes,
    maxBytes: config.maxBytes,
    maxWaitTimeMs: config.maxWaitTimeMs,
    processDelayMs: config.processDelayMs,
  });

  stream = await consumer.consume({
    topics: [config.topic],
    mode: 'earliest',
    autocommit: false,
    highWaterMark: config.highWaterMark,
    minBytes: config.minBytes,
    maxBytes: config.maxBytes,
    maxWaitTime: config.maxWaitTimeMs,
  });

  patchStreamPush(stream);
  startPeriodicLogging(stream);

  try {
    for await (const message of stream) {
      consumedCount += 1;

      if (stopping) {
        break;
      }

      if (message == null) {
        continue;
      }

      await sleep(config.processDelayMs);
    }
  } catch (error) {
    if (!stopping) {
      throw error;
    }
  }

  log('consume:done', {
    consumedCount,
    readableLength: stream.readableLength,
  });
}

async function cleanup() {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }

  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }

  if (stream) {
    try {
      await stream.close();
    } catch {
      // ignore close errors during shutdown
    }
    stream = null;
  }

  if (consumer) {
    try {
      await consumer.close();
    } catch {
      // ignore close errors during shutdown
    }
    consumer = null;
  }

  if (producer) {
    try {
      await producer.close();
    } catch {
      // ignore close errors during shutdown
    }
    producer = null;
  }

  if (admin) {
    try {
      await admin.close();
    } catch {
      // ignore close errors during shutdown
    }
    admin = null;
  }
}

async function main() {
  log('config', config);
  await createTopic();
  await produceBacklog();
  await consumeSlowly();
}

try {
  await main();
} finally {
  await cleanup();

  log('summary', {
    producedCount,
    consumedCount,
    pushCalls: stats.pushCalls,
    pushFalseCount: stats.pushFalseCount,
    firstPushFalseAtReadableLength: stats.firstPushFalseAtReadableLength,
    maxReadableLength: stats.maxReadableLength,
    highWaterMark: config.highWaterMark,
    maxRssMiB: stats.maxRssMiB,
    maxHeapUsedMiB: stats.maxHeapUsedMiB,
    maxExternalMiB: stats.maxExternalMiB,
  });
}
