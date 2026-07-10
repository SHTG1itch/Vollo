#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MAX_REQUESTS = 2_000;
const MAX_CONCURRENCY = 50;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CIRCUIT_BREAKER_MINIMUM = 20;
const CIRCUIT_BREAKER_ERROR_RATE = 0.5;

export const READ_ONLY_ENDPOINTS = Object.freeze({
  health: 'health',
  feed: 'feed?scope=global&limit=10',
  courts: 'courts?limit=25',
});

const HELP = [
  'Vollo read-only API load test',
  '',
  'Usage:',
  '  VOLLO_API_URL=https://<project>.supabase.co/functions/v1/api npm run load:test -- [options]',
  '',
  'The URL may end in /functions/v1 or /functions/v1/api. Only HTTPS is',
  'accepted, except for loopback HTTP during local development.',
  '',
  'Options:',
  '  --url <url>                 API base (or set VOLLO_API_URL)',
  '  --endpoint <name[,name]>    health, feed, courts (default: health)',
  '  --requests <number>         Total requests, 1-' + MAX_REQUESTS + ' (default: 40)',
  '  --concurrency <number>      Parallel workers, 1-' + MAX_CONCURRENCY + ' (default: 4)',
  '  --timeout-ms <number>       Per-request timeout, 100-' + MAX_TIMEOUT_MS + ' (default: 5000)',
  '  --max-p95-ms <number>       Failing p95 latency threshold (default: 2500)',
  '  --max-error-rate <percent>  Failing error-rate threshold (default: 1)',
  '  --help                      Show this message',
  '',
  'Every request is a GET to a fixed, bounded public endpoint. Redirects are',
  'rejected, response bodies are capped, and an outage circuit breaker stops',
  'issuing work after sustained failures.',
].join('\n');

function parseInteger(raw, name, minimum, maximum) {
  if (!/^\d+$/.test(raw ?? '')) {
    throw new Error(name + ' must be an integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function parseNumber(raw, name, minimum, maximum) {
  if (raw == null || raw.trim() === '') {
    throw new Error(name + ' must be a number');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function isLoopback(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function normalizeApiUrl(rawUrl) {
  if (!rawUrl) {
    throw new Error('Set VOLLO_API_URL or pass --url');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('API URL is invalid');
  }

  if (url.username || url.password) {
    throw new Error('API URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new Error('API URL must not contain a query string or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('API URL must use HTTPS (loopback HTTP is allowed for local tests)');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.pathname.endsWith('/functions/v1')) {
    url.pathname += '/api';
  }
  if (!url.pathname.endsWith('/api')) {
    throw new Error('API URL must end in /functions/v1 or /functions/v1/api');
  }

  return url;
}

function parseEndpoints(values) {
  const names = values.length
    ? values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
    : ['health'];
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!Object.hasOwn(READ_ONLY_ENDPOINTS, name)) {
      throw new Error(
        'Unknown endpoint "' + name + '". Allowed endpoints: ' + Object.keys(READ_ONLY_ENDPOINTS).join(', '),
      );
    }
  }
  return unique;
}

export function parseArgs(argv, env = process.env) {
  const values = {
    url: env.VOLLO_API_URL,
    endpoints: [],
    requests: '40',
    concurrency: '4',
    timeoutMs: '5000',
    maxP95Ms: '2500',
    maxErrorRate: '1',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') {
      return { help: true };
    }

    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) {
      throw new Error('Missing value for ' + option);
    }
    index += 1;

    switch (option) {
      case '--url':
        values.url = next;
        break;
      case '--endpoint':
        values.endpoints.push(next);
        break;
      case '--requests':
        values.requests = next;
        break;
      case '--concurrency':
        values.concurrency = next;
        break;
      case '--timeout-ms':
        values.timeoutMs = next;
        break;
      case '--max-p95-ms':
        values.maxP95Ms = next;
        break;
      case '--max-error-rate':
        values.maxErrorRate = next;
        break;
      default:
        throw new Error('Unknown option ' + option);
    }
  }

  const config = {
    apiUrl: normalizeApiUrl(values.url),
    endpoints: parseEndpoints(values.endpoints),
    requests: parseInteger(values.requests, '--requests', 1, MAX_REQUESTS),
    concurrency: parseInteger(values.concurrency, '--concurrency', 1, MAX_CONCURRENCY),
    timeoutMs: parseInteger(values.timeoutMs, '--timeout-ms', 100, MAX_TIMEOUT_MS),
    maxP95Ms: parseNumber(values.maxP95Ms, '--max-p95-ms', 1, 60_000),
    maxErrorRatePercent: parseNumber(values.maxErrorRate, '--max-error-rate', 0, 100),
  };

  config.concurrency = Math.min(config.concurrency, config.requests);
  return config;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1);
  return sortedValues[index];
}

async function boundedBody(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('response exceeded ' + MAX_RESPONSE_BYTES + ' bytes');
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let receivedBytes = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('response exceeded ' + MAX_RESPONSE_BYTES + ' bytes');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validatePayload(endpointName, response, bytes) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('successful response was not JSON');
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('successful response contained invalid JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('successful response had an invalid JSON shape');
  }
  if (endpointName === 'health' && payload.status !== 'ok') {
    throw new Error('health response did not report ok');
  }
  if (endpointName === 'feed' && (!Array.isArray(payload.matches) || !('next_cursor' in payload))) {
    throw new Error('feed response did not contain matches and next_cursor');
  }
  if (endpointName === 'courts' && !Array.isArray(payload.courts)) {
    throw new Error('courts response did not contain courts');
  }
}

async function executeRequest(config, endpointName, fetchImpl) {
  const target = new URL(READ_ONLY_ENDPOINTS[endpointName], config.apiUrl.href + '/');
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'Vollo-Read-Only-Load-Test/1.0',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const body = await boundedBody(response);
    if (response.ok) validatePayload(endpointName, response, body);
    return {
      endpoint: endpointName,
      ok: response.ok,
      status: response.status,
      latencyMs: performance.now() - startedAt,
      error: response.ok ? null : 'HTTP ' + response.status,
    };
  } catch (error) {
    return {
      endpoint: endpointName,
      ok: false,
      status: null,
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatMilliseconds(value) {
  return value.toFixed(1) + ' ms';
}

function summarize(config, observations, durationMs, circuitOpen) {
  const latencies = observations.map((item) => item.latencyMs).sort((a, b) => a - b);
  const failures = observations.filter((item) => !item.ok);
  const errorRatePercent = observations.length === 0 ? 100 : (failures.length / observations.length) * 100;
  const statusCounts = {};
  for (const observation of observations) {
    const key = observation.status == null ? 'network' : String(observation.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }

  const thresholdFailures = [];
  const p95Ms = percentile(latencies, 95);
  if (p95Ms > config.maxP95Ms) {
    thresholdFailures.push(
      'p95 ' + formatMilliseconds(p95Ms) + ' exceeded ' + formatMilliseconds(config.maxP95Ms),
    );
  }
  if (errorRatePercent > config.maxErrorRatePercent) {
    thresholdFailures.push(
      'error rate ' + errorRatePercent.toFixed(2) + '% exceeded ' + config.maxErrorRatePercent + '%',
    );
  }
  if (circuitOpen || observations.length < config.requests) {
    thresholdFailures.push(
      'outage circuit breaker stopped after ' + observations.length + ' of ' + config.requests + ' requests',
    );
  }

  return {
    passed: thresholdFailures.length === 0,
    attempted: observations.length,
    configuredRequests: config.requests,
    successCount: observations.length - failures.length,
    failureCount: failures.length,
    errorRatePercent,
    durationMs,
    requestsPerSecond: durationMs === 0 ? 0 : observations.length / (durationMs / 1000),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: p95Ms,
      p99: percentile(latencies, 99),
      max: latencies.at(-1) ?? 0,
    },
    statusCounts,
    sampleErrors: failures.slice(0, 5).map((item) => ({
      endpoint: item.endpoint,
      status: item.status,
      error: item.error,
    })),
    thresholdFailures,
  };
}

function printReport(config, report, log) {
  log('');
  log('Vollo read-only load report');
  log('  target:        ' + config.apiUrl.origin + config.apiUrl.pathname);
  log('  endpoints:     ' + config.endpoints.join(', '));
  log('  attempted:     ' + report.attempted + '/' + report.configuredRequests);
  log('  successes:     ' + report.successCount);
  log('  failures:      ' + report.failureCount + ' (' + report.errorRatePercent.toFixed(2) + '%)');
  log('  throughput:    ' + report.requestsPerSecond.toFixed(2) + ' req/s');
  log(
    '  latency:       p50 ' + formatMilliseconds(report.latencyMs.p50) +
      ' | p95 ' + formatMilliseconds(report.latencyMs.p95) +
      ' | p99 ' + formatMilliseconds(report.latencyMs.p99) +
      ' | max ' + formatMilliseconds(report.latencyMs.max),
  );
  log('  status counts: ' + JSON.stringify(report.statusCounts));

  for (const sample of report.sampleErrors) {
    log(
      '  error sample:  ' + sample.endpoint + ' ' +
        (sample.status == null ? 'network' : sample.status) + ' ' + sample.error,
    );
  }
  for (const failure of report.thresholdFailures) {
    log('  threshold:     FAIL - ' + failure);
  }
  log('  result:        ' + (report.passed ? 'PASS' : 'FAIL'));
}

export async function runLoadTest(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? console.log;
  if (typeof fetchImpl !== 'function') {
    throw new Error('This script requires a runtime with fetch support');
  }

  let nextRequest = 0;
  let completed = 0;
  let failures = 0;
  let circuitOpen = false;
  const observations = [];
  const startedAt = performance.now();

  async function worker() {
    while (!circuitOpen) {
      const requestIndex = nextRequest;
      nextRequest += 1;
      if (requestIndex >= config.requests) return;

      const endpoint = config.endpoints[requestIndex % config.endpoints.length];
      const observation = await executeRequest(config, endpoint, fetchImpl);
      observations.push({ ...observation, requestIndex });
      completed += 1;
      if (!observation.ok) failures += 1;

      if (
        completed >= CIRCUIT_BREAKER_MINIMUM &&
        failures / completed >= CIRCUIT_BREAKER_ERROR_RATE
      ) {
        circuitOpen = true;
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  observations.sort((a, b) => a.requestIndex - b.requestIndex);
  const report = summarize(config, observations, performance.now() - startedAt, circuitOpen);
  printReport(config, report, log);
  return report;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  try {
    config = parseArgs(argv, env);
  } catch (error) {
    console.error('Configuration error: ' + (error instanceof Error ? error.message : String(error)));
    console.error('Run with --help for usage.');
    return 2;
  }

  if (config.help) {
    console.log(HELP);
    return 0;
  }

  const report = await runLoadTest(config);
  return report.passed ? 0 : 1;
}

const isDirectExecution =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  process.exitCode = await main();
}
